import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config();
dotenv.config({ path: path.join(__serverDir, '.env') });

import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import {
  getPool,
  verifyDatabaseReadiness,
  sanitizeDbErrorCode,
  createPoolConfig,
  DEFAULT_DB_CONNECTION_LIMIT,
  MAX_DB_CONNECTION_LIMIT,
  parseConnectionLimit,
  parseDbSsl,
} from './db.js';
import { createAuthRouter } from './routes/auth.js';
import { createVehiclesRouter } from './routes/vehicles.js';
import { createPublicRouter } from './routes/public.js';

const DAY = 24 * 60 * 60 * 1000;

export function parseAllowedOrigins(value = '') {
  return [...new Set(value.split(',').map((origin) => origin.trim()).filter(Boolean))];
}

export function validateRuntimeConfig(env = process.env) {
  const problems = [];
  const secret = env.SESSION_SECRET || '';
  if (Buffer.byteLength(secret, 'utf8') < 32 || new Set(secret).size < 8 || /^(replace|generate|example)/i.test(secret)) {
    problems.push('SESSION_SECRET must be set to at least 32 UTF-8 bytes.');
  }
  const sameSite = env.COOKIE_SAME_SITE || (env.NODE_ENV === 'production' ? 'strict' : 'lax');
  if (!['strict', 'lax', 'none'].includes(sameSite.toLowerCase())) problems.push('COOKIE_SAME_SITE must be Strict, Lax, or None.');
  if (sameSite.toLowerCase() === 'none' && env.NODE_ENV !== 'production') problems.push('COOKIE_SAME_SITE=None requires production HTTPS.');

  const origins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  if (!origins.length) problems.push('ALLOWED_ORIGINS must contain at least one exact origin.');
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
        problems.push(`ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
      }
      if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
        problems.push(`Production ALLOWED_ORIGINS must use HTTPS: ${origin}`);
      }
    } catch {
      problems.push(`ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }
  }

  if (env.NODE_ENV === 'production') {
    if (!env.DB_USER || env.DB_USER === 'root') {
      problems.push('Production DB_USER must be a dedicated non-root database account.');
    }
    if (!env.DB_PASSWORD || /^(replace|example|password)/i.test(env.DB_PASSWORD)) problems.push('Production DB_PASSWORD must be set to a private value.');
    if (env.TRUST_PROXY_HOPS && !/^\d+$/.test(env.TRUST_PROXY_HOPS)) {
      problems.push('TRUST_PROXY_HOPS must be a non-negative integer.');
    }
  }

  if (problems.length) {
    const error = new Error(`Invalid server configuration: ${problems.join(' ')}`);
    error.code = 'INVALID_CONFIGURATION';
    throw error;
  }
  return { origins, secret, sameSite: sameSite.toLowerCase() };
}

function makeSessionStore(pool, env) {
  const MySQLStore = MySQLStoreFactory(session);
  return new MySQLStore(
    {
      clearExpired: true,
      checkExpirationInterval: 15 * 60 * 1000,
      expiration: DAY,
      createDatabaseTable: false,
      schema: {
        tableName: 'sessions',
        columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' },
      },
    },
    pool
  );
}

export function createApp({
  env = process.env,
  pool = getPool(),
  store,
  loginLimiter,
  signupLimiter,
  publicLimiter,
  vehicleLogger = console,
  logger,
} = {}) {
  const activeLogger = logger || vehicleLogger || console;
  const { origins, secret, sameSite } = validateRuntimeConfig(env);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const supplied = req.get('X-Request-ID') || '';
    req.requestId = /^[A-Za-z0-9._:-]{1,64}$/.test(supplied) ? supplied : randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    next();
  });
  if (env.NODE_ENV === 'production' && env.TRUST_PROXY_HOPS) {
    app.set('trust proxy', Number(env.TRUST_PROXY_HOPS));
  }

  const allowed = new Set(origins);
  app.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    return next();
  });
  app.use(cors({
    origin(origin, callback) {
      // Requests without Origin (health checks, CLI clients, server-to-server calls)
      // proceed without CORS response headers. They still need CSRF tokens for writes.
      if (!origin) return callback(null, false);
      if (allowed.has(origin)) return callback(null, origin);
      const error = new Error('Origin is not allowed');
      error.status = 403;
      error.code = 'ORIGIN_NOT_ALLOWED';
      return callback(error);
    },
    credentials: true,
    optionsSuccessStatus: 204,
  }));
  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  app.use(session({
    name: 'parkx.sid',
    secret,
    store: store || makeSessionStore(pool, env),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite,
      path: '/',
      maxAge: DAY,
    },
  }));

  app.use('/api/auth', createAuthRouter({ pool, origins, loginLimiter, signupLimiter }));
  app.use('/api/vehicles', createVehiclesRouter({ pool, origins, logger: activeLogger }));
  app.use('/api/public', createPublicRouter({ pool, limiter: publicLimiter, logger: activeLogger }));
  app.get('/api/health', async (_req, res) => {
    const safeLog = (level, message, meta) => {
      try {
        if (typeof activeLogger?.[level] === 'function') {
          activeLogger[level](message, meta);
        }
      } catch {}
    };

    try {
      await pool.query('SELECT 1');
      return res.json({ status: 'ok', uptime: process.uptime() });
    } catch (firstErr) {
      const firstCode = sanitizeDbErrorCode(firstErr?.code);
      const isStale =
        firstCode === 'PROTOCOL_CONNECTION_LOST' ||
        firstCode === 'ECONNRESET' ||
        firstCode === 'EPIPE';

      if (isStale) {
        safeLog('warn', 'Health check connection reset, retrying on fresh connection:', {
          code: firstCode,
        });
        try {
          await pool.query('SELECT 1');
          return res.json({ status: 'ok', uptime: process.uptime() });
        } catch (retryErr) {
          const retryCode = sanitizeDbErrorCode(retryErr?.code);
          safeLog('error', 'Health check database query failed on retry:', {
            code: retryCode,
          });
          return res.status(503).json({ status: 'db_error', uptime: process.uptime() });
        }
      }

      safeLog('error', 'Health check database query failed:', {
        code: firstCode,
      });
      return res.status(503).json({ status: 'db_error', uptime: process.uptime() });
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ message: 'Not found' }));

  app.use((err, _req, res, _next) => {
    if (res.headersSent) return;
    const status = err.status || (err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500);
    const message = status === 413 ? 'Request body is too large' : status === 400 ? 'Invalid JSON request body' : status === 403 ? 'Origin is not allowed' : 'Internal server error';
    if (status >= 500) console.error('Request failed:', { code: err.code || err.type || 'INTERNAL_ERROR', status });
    return res.status(status).json({ message });
  });
  return app;
}

export {
  verifyDatabaseReadiness,
  sanitizeDbErrorCode,
  createPoolConfig,
  DEFAULT_DB_CONNECTION_LIMIT,
  MAX_DB_CONNECTION_LIMIT,
  parseConnectionLimit,
  parseDbSsl,
};

export function resolveServerListenOptions({
  env = process.env,
  port,
  host = '0.0.0.0',
} = {}) {
  let finalPort;
  if (port !== undefined) {
    const p = Number(port);
    finalPort = Number.isInteger(p) && p >= 0 ? p : 5001;
  } else {
    const rawEnv = typeof env.PORT === 'string' ? env.PORT.trim() : env.PORT;
    const p = rawEnv !== undefined && rawEnv !== '' ? Number(rawEnv) : NaN;
    finalPort = Number.isInteger(p) && p >= 0 ? p : 5001;
  }
  const finalHost = typeof host === 'string' && host.trim() !== '' ? host.trim() : '0.0.0.0';
  return { port: finalPort, host: finalHost };
}

export async function startServer({
  env = process.env,
  pool,
  store,
  port,
  host = '0.0.0.0',
  timeoutMs = Number(env.DB_READINESS_TIMEOUT_MS) || 5000,
  logger = console,
} = {}) {
  validateRuntimeConfig(env);
  const targetPool = pool || getPool();

  try {
    await verifyDatabaseReadiness(targetPool, { timeoutMs });
  } catch (err) {
    const safeCode = sanitizeDbErrorCode(err.code);
    logger.error(`Database readiness check failed: unable to connect to database (${safeCode}). Server startup aborted.`);
    const error = new Error(`Database readiness check failed: ${safeCode}`);
    error.code = safeCode;
    throw error;
  }

  const app = createApp({ env, pool: targetPool, store });
  const { port: finalPort, host: finalHost } = resolveServerListenOptions({ env, port, host });

  return new Promise((resolve, reject) => {
    const server = app.listen(finalPort, finalHost, () => {
      const actualPort = server.address()?.port ?? finalPort;
      logger.log(`PARKX server listening on ${finalHost}:${actualPort} (${env.NODE_ENV || 'development'})`);
      resolve(server);
    });
    server.on('error', (err) => {
      reject(err);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().catch((error) => {
    if (error.code === 'INVALID_CONFIGURATION') {
      console.error(error.message);
    } else if (!error.message?.includes('Database readiness check failed')) {
      const safeCode = sanitizeDbErrorCode(error.code);
      console.error(`Server startup failed: ${safeCode}`);
    }
    process.exit(1);
  });
}
