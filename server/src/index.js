import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import { getPool } from './db.js';
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
} = {}) {
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
  app.use('/api/vehicles', createVehiclesRouter({ pool, origins, logger: vehicleLogger }));
  app.use('/api/public', createPublicRouter({ pool, limiter: publicLimiter, logger: vehicleLogger }));
  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      return res.json({ status: 'ok', uptime: process.uptime() });
    } catch {
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    validateRuntimeConfig(process.env);
    const app = createApp();
    const port = Number(process.env.PORT) || 5001;
    app.listen(port, () => console.log(`PARKX server listening on port ${port} (${process.env.NODE_ENV || 'development'})`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
