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
import { wrapAsyncHandler, HandlerTracker } from './asyncHandler.js';
import { DatabaseTracker, instrumentPool, isInstrumentedPool, getInstrumentedPoolTracker } from './dbTracker.js';
import { createAuthRouter } from './routes/auth.js';
import { createVehiclesRouter } from './routes/vehicles.js';
import { createPublicRouter } from './routes/public.js';
import { startVisitorSessionCleanupTask } from './services/sessionCleanup.js';

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
      endConnectionOnClose: false,
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
  sessionCreateLimiter,
  sessionReadLimiter,
  vehicleLogger = console,
  logger,
} = {}) {
  const activeLogger = logger || vehicleLogger || console;
  const { origins, secret, sameSite } = validateRuntimeConfig(env);
  const app = express();
  app.disable('x-powered-by');

  const handlerTracker = new HandlerTracker();
  let dbTracker;
  let instrumentedPool;

  if (isInstrumentedPool(pool)) {
    dbTracker = getInstrumentedPoolTracker(pool);
    instrumentedPool = pool;
  } else if (pool && typeof pool === 'object' && (pool._isInstrumented || pool[Symbol.for('parkx.instrumented_pool')])) {
    const err = new Error('Cannot create application: supplied pool has an invalid or corrupted DatabaseTracker');
    err.code = 'EINVALID_INSTRUMENTATION';
    throw err;
  } else {
    dbTracker = new DatabaseTracker();
    instrumentedPool = instrumentPool(pool, dbTracker);
  }
  const sessionStore = store || makeSessionStore(instrumentedPool, env);

  let isShuttingDown = false;

  app.setShuttingDown = (val = true) => {
    isShuttingDown = Boolean(val);
  };
  app.isShuttingDown = () => isShuttingDown;
  app.handlerTracker = handlerTracker;
  app.dbTracker = dbTracker;
  app.pool = instrumentedPool;
  app.sessionStore = sessionStore;
  app.trackHandlerWork = (promise) => handlerTracker.track(promise);
  app.trackWork = (promise) => handlerTracker.track(promise);
  app.getActiveHandlerWork = () => handlerTracker.getActiveCount();
  app.getActiveDatabaseWork = () => dbTracker.getActiveCount();
  app.getActiveWork = () => handlerTracker.getActiveCount() + dbTracker.getActiveCount();
  app.getActiveRequests = app.getActiveWork;

  // Admission guard: rejects new work once shutdown starts on both new and keep-alive connections
  app.use((req, res, next) => {
    if (isShuttingDown) {
      res.setHeader('Connection', 'close');
      res.setHeader('Content-Type', 'application/json');
      return res.status(503).json({
        error: 'SERVER_SHUTTING_DOWN',
        message: 'Server is shutting down',
      });
    }

    req.trackWork = (promise) => handlerTracker.track(promise);
    next();
  });

  const originalListen = app.listen.bind(app);
  app.listen = function (...args) {
    const srv = originalListen(...args);
    srv.pool = instrumentedPool;
    srv.sessionStore = sessionStore;
    srv.getActiveWork = app.getActiveWork;
    srv.getActiveRequests = app.getActiveWork;
    srv.getActiveHandlerWork = app.getActiveHandlerWork;
    srv.getActiveDatabaseWork = app.getActiveDatabaseWork;
    srv.setShuttingDown = app.setShuttingDown;
    srv.trackWork = app.trackWork;
    srv.trackHandlerWork = app.trackHandlerWork;
    srv.handlerTracker = handlerTracker;
    srv.dbTracker = dbTracker;
    return srv;
  };

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
    store: sessionStore,
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

  app.use('/api/auth', createAuthRouter({ pool: instrumentedPool, origins, loginLimiter, signupLimiter }));
  app.use('/api/vehicles', createVehiclesRouter({ pool: instrumentedPool, origins, logger: activeLogger }));
  app.use('/api/public', createPublicRouter({
    pool: instrumentedPool,
    limiter: publicLimiter,
    sessionCreateLimiter,
    sessionReadLimiter,
    logger: activeLogger,
  }));
  app.get('/api/health', wrapAsyncHandler(async (_req, res) => {
    const safeLog = (level, message, meta) => {
      try {
        if (typeof activeLogger?.[level] === 'function') {
          activeLogger[level](message, meta);
        }
      } catch {}
    };

    try {
      await instrumentedPool.query('SELECT 1');
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
          await instrumentedPool.query('SELECT 1');
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
  }));
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
  wrapAsyncHandler,
  HandlerTracker,
  DatabaseTracker,
  instrumentPool,
  getInstrumentedPoolTracker,
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

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
export const DEFAULT_HTTP_GRACE_MS = 5000;

const shutdownPromises = new WeakMap();

/**
 * Gracefully shuts down the HTTP server, session cleanup background task, and database pool.
 *
 * Single Overall Deadline & Shutdown Stage Budgeting:
 * --------------------------------------------------
 * 1. A single overall shutdown deadline (`timeoutMs`, default 10,000ms) bounds the entire shutdown.
 *    Each sequential stage consumes time from this same overall budget via `getRemainingMs()`.
 *
 * 2. Stage Sequence:
 *    a) Stop accepting new HTTP requests (`server.close()`).
 *       Wait for in-flight HTTP request handlers to finish during the HTTP grace period.
 *       If the HTTP deadline expires and handlers are still active, terminate connections
 *       and record `EHTTPBUSY` to prevent closing the pool while queries are in-flight.
 *    b) Signal cleanup task to cease scheduling (`cleanupTask.stop()`), and await in-flight
 *       cleanup only up to the remaining overall deadline (`Math.min(cleanupTimeoutMs, getRemainingMs())`).
 *       If cleanup is still running when time expires, skip pool closure with `ECLEANUPBUSY`.
 *    c) Close database pool (`pool.end()`) ONLY IF no known database work remains active
 *       (neither HTTP request handlers nor cleanup queries).
 *       Pool closure itself is bounded by the remaining overall deadline. If `pool.end()`
 *       does not settle within the remaining time, shutdown records `ETIMEDOUT`.
 *       The runtime does not retry `pool.end()` or assume mid-flight cancellation.
 *
 * 3. Process Termination Boundary:
 *    - mysql2 (v3.x) does NOT provide an active-query cancellation API for `pool.query()`.
 *    - Destroying sockets does NOT cancel handler queries on MySQL.
 *    - If any stage fails or times out, the application records that graceful shutdown failed
 *      and transitions to the explicit process termination boundary (`onForceExit` callback
 *      or production `process.exit(1)`).
 */
export async function closeServerGracefully(server, cleanupTask, pool, options = {}) {
  const key = (server && typeof server === 'object')
    ? server
    : (cleanupTask && typeof cleanupTask === 'object')
      ? cleanupTask
      : (pool && typeof pool === 'object')
        ? pool
        : null;

  if (key) {
    const existing = shutdownPromises.get(key);
    if (existing) return existing;
  }

  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : (Number(process.env.SHUTDOWN_TIMEOUT_MS) || DEFAULT_SHUTDOWN_TIMEOUT_MS);

  const shutdownStartTime = Date.now();
  const overallDeadline = shutdownStartTime + timeoutMs;
  const getRemainingMs = () => Math.max(0, overallDeadline - Date.now());

  const httpGraceMs = typeof options.httpGraceMs === 'number' && options.httpGraceMs >= 0
    ? options.httpGraceMs
    : Math.min(timeoutMs / 2, DEFAULT_HTTP_GRACE_MS);

  const httpTimeoutMs = typeof options.httpTimeoutMs === 'number' && options.httpTimeoutMs > 0
    ? options.httpTimeoutMs
    : Math.min(timeoutMs, Math.max(httpGraceMs * 2, httpGraceMs + 500));

  const cleanupTimeoutMs = typeof options.cleanupTimeoutMs === 'number' && options.cleanupTimeoutMs > 0
    ? options.cleanupTimeoutMs
    : Math.max(100, timeoutMs - httpGraceMs);

  const onForceExit = typeof options.onForceExit === 'function' ? options.onForceExit : null;

  const explicitTracker = options?.dbTracker || server?.dbTracker || null;
  let poolTracker = null;
  if (pool) {
    try {
      poolTracker = getInstrumentedPoolTracker(pool);
    } catch (err) {
      if (err?.code === 'EINVALID_INSTRUMENTATION') {
        return Promise.reject(err);
      }
      throw err;
    }
  }

  if (explicitTracker && poolTracker && explicitTracker !== poolTracker) {
    const mismatchErr = new Error('Database tracker mismatch: supplied tracker does not match instrumented pool tracker');
    mismatchErr.code = 'EINVALID_TRACKER';
    return Promise.reject(mismatchErr);
  }

  const resolvedDbTracker = poolTracker || explicitTracker || null;

  const performShutdown = async () => {
    let primaryError = null;
    let httpRequestsDangling = false;
    let cleanupTimedOut = false;
    let sessionStoreTimedOut = false;
    let dbDrainTimedOut = false;

    let idleTimer = null;
    let forceHttpTimer = null;
    let cleanupTimer = null;
    let storeTimer = null;
    let poolTimer = null;
    let drainPollTimer = null;

    const clearAllTimers = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (forceHttpTimer) { clearTimeout(forceHttpTimer); forceHttpTimer = null; }
      if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null; }
      if (storeTimer) { clearTimeout(storeTimer); storeTimer = null; }
      if (poolTimer) { clearTimeout(poolTimer); poolTimer = null; }
      if (drainPollTimer) { clearInterval(drainPollTimer); drainPollTimer = null; }
    };

    const getActiveHandlerCount = () => {
      if (typeof server?.getActiveHandlerWork === 'function') return server.getActiveHandlerWork();
      if (typeof options?.getActiveHandlerWork === 'function') return options.getActiveHandlerWork();
      if (typeof server?.handlerTracker?.getActiveCount === 'function') return server.handlerTracker.getActiveCount();
      return 0;
    };

    const getActiveDbCount = () => {
      if (resolvedDbTracker && typeof resolvedDbTracker.getActiveCount === 'function') {
        return resolvedDbTracker.getActiveCount();
      }
      if (typeof options?.getActiveDatabaseWork === 'function') return options.getActiveDatabaseWork();
      if (typeof server?.getActiveDatabaseWork === 'function') return server.getActiveDatabaseWork();
      return 0;
    };

    const getLegacyHttpCount = () => {
      if (typeof server?.getActiveRequests === 'function') return server.getActiveRequests();
      if (typeof options?.getActiveRequests === 'function') return options.getActiveRequests();
      return 0;
    };

    const getActiveCount = () => {
      if (typeof server?.getActiveRequests === 'function') return server.getActiveRequests();
      if (typeof options?.getActiveRequests === 'function') return options.getActiveRequests();
      if (typeof server?.getActiveWork === 'function') return server.getActiveWork();
      if (typeof options?.getActiveWork === 'function') return options.getActiveWork();
      return getActiveHandlerCount() + getActiveDbCount();
    };

    try {
      // ========================================================
      // Phase 1: Stop accepting new HTTP requests
      // ========================================================
      try {
        if (typeof server?.setShuttingDown === 'function') {
          server.setShuttingDown(true);
        } else if (typeof options?.setShuttingDown === 'function') {
          options.setShuttingDown(true);
        }
      } catch {}

      let serverCloseFired = false;
      let serverCloseError = null;
      const onServerCloseCallbacks = [];

      if (server && typeof server.close === 'function') {
        try {
          server.close((err) => {
            serverCloseFired = true;
            if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
              serverCloseError = err;
              if (!primaryError) primaryError = err;
            }
            for (const cb of onServerCloseCallbacks) cb();
          });
        } catch (err) {
          serverCloseFired = true;
          serverCloseError = err;
          if (!primaryError) primaryError = err;
        }
      } else {
        serverCloseFired = true;
      }

      // ========================================================
      // Phase 2: Stop background producers
      // (session-store expiration timer and visitor-session cleanup)
      // ========================================================
      const sessionStore = options?.sessionStore || server?.sessionStore || options?.store;
      if (sessionStore && !sessionStore._parkxClosed) {
        sessionStore._parkxClosed = true;
        try {
          if (typeof sessionStore.clearExpirationInterval === 'function') {
            try { sessionStore.clearExpirationInterval(); } catch {}
          }
          if (sessionStore._expirationInterval) {
            clearInterval(sessionStore._expirationInterval);
            sessionStore._expirationInterval = null;
          }
          if (sessionStore.clearExpirationIntervalTimer) {
            clearInterval(sessionStore.clearExpirationIntervalTimer);
            sessionStore.clearExpirationIntervalTimer = null;
          }

          if (typeof sessionStore.close === 'function') {
            const rem = getRemainingMs();
            if (rem <= 0) {
              sessionStoreTimedOut = true;
              const err = new Error('Session store close timed out: overall shutdown deadline exceeded');
              err.code = 'ETIMEDOUT';
              if (!primaryError) primaryError = err;
            } else {
              await new Promise((resolve, reject) => {
                let settled = false;
                const settleOnce = (err) => {
                  if (settled) return;
                  settled = true;
                  if (storeTimer) {
                    clearTimeout(storeTimer);
                    storeTimer = null;
                  }
                  if (err) {
                    reject(err);
                  } else {
                    resolve();
                  }
                };

                storeTimer = setTimeout(() => {
                  sessionStoreTimedOut = true;
                  const err = new Error(`Session store close timed out after ${rem}ms`);
                  err.code = 'ETIMEDOUT';
                  settleOnce(err);
                }, rem);

                try {
                  if (sessionStore.close.length > 0) {
                    const ret = sessionStore.close((err) => {
                      if (err) settleOnce(err);
                      else settleOnce();
                    });
                    if (ret && typeof ret.then === 'function') {
                      ret.then(() => settleOnce(), (err) => settleOnce(err));
                    }
                  } else {
                    const ret = sessionStore.close();
                    if (ret && typeof ret.then === 'function') {
                      ret.then(() => settleOnce(), (err) => settleOnce(err));
                    } else {
                      settleOnce();
                    }
                  }
                } catch (err) {
                  settleOnce(err);
                }
              }).catch((err) => {
                if (!primaryError) primaryError = err;
              });
            }
          } else if (typeof sessionStore.stopExpiring === 'function') {
            sessionStore.stopExpiring();
          }
        } catch (storeErr) {
          if (!primaryError) primaryError = storeErr;
        }
      }

      if (cleanupTask && typeof cleanupTask.stop === 'function') {
        const remainingForCleanup = Math.min(cleanupTimeoutMs, getRemainingMs());
        if (remainingForCleanup <= 0) {
          cleanupTimedOut = true;
          const err = new Error('Cleanup shutdown timed out: overall shutdown deadline exceeded');
          err.code = 'ETIMEDOUT';
          if (!primaryError) primaryError = err;
        } else {
          const cleanupTimeoutPromise = new Promise((_, reject) => {
            cleanupTimer = setTimeout(() => {
              cleanupTimedOut = true;
              const err = new Error(`Cleanup shutdown timed out after ${remainingForCleanup}ms`);
              err.code = 'ETIMEDOUT';
              reject(err);
            }, remainingForCleanup);
          });

          try {
            await Promise.race([cleanupTask.stop(), cleanupTimeoutPromise]);
          } catch (cleanupErr) {
            if (!primaryError) {
              primaryError = cleanupErr;
            }
          } finally {
            if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null; }
          }
        }
      }

      // ========================================================
      // Phase 3: Drain already-admitted handler promises to zero
      // ========================================================
      try {
        await new Promise((resolve, reject) => {
          if (serverCloseError) {
            return reject(serverCloseError);
          }

          let settled = false;

          const checkDone = () => {
            if (settled) return;
            const hCount = getActiveHandlerCount();
            const legacyHttp = (typeof server?.handlerTracker === 'undefined' && typeof options?.getActiveHandlerWork === 'undefined')
              ? getLegacyHttpCount()
              : 0;
            if (serverCloseFired && hCount === 0 && legacyHttp === 0) {
              settled = true;
              clearAllTimers();
              resolve();
            }
          };

          const doneWithError = (err) => {
            if (settled) return;
            settled = true;
            clearAllTimers();
            reject(err);
          };

          if (serverCloseFired) {
            checkDone();
          } else {
            onServerCloseCallbacks.push(() => {
              if (serverCloseError) doneWithError(serverCloseError);
              else checkDone();
            });
          }

          drainPollTimer = setInterval(checkDone, 10);
          if (typeof drainPollTimer.unref === 'function') drainPollTimer.unref();

          const effectiveGraceMs = Math.min(httpGraceMs, getRemainingMs());
          if (effectiveGraceMs > 0 && effectiveGraceMs < httpTimeoutMs) {
            idleTimer = setTimeout(() => {
              try {
                if (typeof server?.closeIdleConnections === 'function') {
                  server.closeIdleConnections();
                }
              } catch {}
            }, effectiveGraceMs);
          }

          const effectiveHttpTimeoutMs = Math.min(httpTimeoutMs, getRemainingMs());
          forceHttpTimer = setTimeout(() => {
            try {
              if (typeof server?.closeAllConnections === 'function') {
                server.closeAllConnections();
              }
            } catch {}
            const hCount = getActiveHandlerCount();
            const legacyHttp = (typeof server?.handlerTracker === 'undefined' && typeof options?.getActiveHandlerWork === 'undefined')
              ? getLegacyHttpCount()
              : 0;
            if (hCount > 0 || legacyHttp > 0) {
              httpRequestsDangling = true;
            }
            const err = new Error(`HTTP server closure timed out after ${effectiveHttpTimeoutMs}ms`);
            err.code = 'ETIMEDOUT';
            doneWithError(err);
          }, effectiveHttpTimeoutMs);
        });
      } catch (err) {
        if (!primaryError) primaryError = err;
      }

      // ========================================================
      // Phase 4: Atomically seal database admission
      // (no new operations can begin)
      // ========================================================
      if (resolvedDbTracker && typeof resolvedDbTracker.seal === 'function') {
        resolvedDbTracker.seal();
      }

      // ========================================================
      // Phase 5: Drain existing in-flight database operations to zero
      // ========================================================
      const remainingForDb = getRemainingMs();
      if (getActiveDbCount() > 0 && remainingForDb > 0) {
        await new Promise((resolve) => {
          let pollTimer = null;
          let timeoutTimer = null;
          const done = () => {
            if (pollTimer) clearInterval(pollTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            resolve();
          };
          pollTimer = setInterval(() => {
            if (getActiveDbCount() === 0) done();
          }, 10);
          timeoutTimer = setTimeout(() => {
            if (getActiveDbCount() > 0) {
              dbDrainTimedOut = true;
            }
            done();
          }, remainingForDb);
        });
      }
    } finally {
      clearAllTimers();

      // ========================================================
      // Phase 6: Verify zero active work
      // ========================================================
      const activeHandlerCount = getActiveHandlerCount();
      const activeDbCount = getActiveDbCount();
      const legacyHttpCount = (typeof server?.handlerTracker === 'undefined' && typeof options?.getActiveHandlerWork === 'undefined')
        ? getLegacyHttpCount()
        : 0;

      const isHttpWorkActive = Boolean(httpRequestsDangling || activeHandlerCount > 0 || legacyHttpCount > 0);
      const isDbWorkActive = Boolean(dbDrainTimedOut || activeDbCount > 0);
      const isCleanupActive = Boolean(cleanupTask?.isRunning || cleanupTimedOut || sessionStoreTimedOut);

      if (isHttpWorkActive || isDbWorkActive) {
        const httpBusyErr = new Error('Database pool closure skipped: HTTP request handlers or database operations are still active');
        httpBusyErr.code = 'EHTTPBUSY';
        if (!primaryError) primaryError = httpBusyErr;
      } else if (isCleanupActive) {
        const poolSkipErr = new Error('Database pool closure skipped: cleanup queries are still active');
        poolSkipErr.code = 'ECLEANUPBUSY';
        if (!primaryError) primaryError = poolSkipErr;
      } else if (pool && typeof pool.end === 'function') {
        // ========================================================
        // Phase 7: Invoke pool.end()
        // ========================================================
        const poolTimeoutMs = getRemainingMs();
        if (poolTimeoutMs <= 0) {
          const poolTimeoutErr = new Error('Database pool closure timed out: overall shutdown deadline exceeded');
          poolTimeoutErr.code = 'ETIMEDOUT';
          if (!primaryError) primaryError = poolTimeoutErr;
        } else {
          let poolTimer = null;
          const poolTimeoutPromise = new Promise((_, reject) => {
            poolTimer = setTimeout(() => {
              const err = new Error(`Database pool closure timed out after ${poolTimeoutMs}ms`);
              err.code = 'ETIMEDOUT';
              reject(err);
            }, poolTimeoutMs);
          });

          try {
            await Promise.race([pool.end(), poolTimeoutPromise]);
          } catch (err) {
            if (!primaryError) primaryError = err;
          } finally {
            if (poolTimer) clearTimeout(poolTimer);
          }
        }
      }

      // Hard process exit boundary if configured and primary error occurred
      if (primaryError && onForceExit) {
        try {
          onForceExit(1, primaryError);
        } catch {}
      }
    }

    if (primaryError) {
      throw primaryError;
    }
  };

  const promise = performShutdown();
  if (key) {
    shutdownPromises.set(key, promise);
  }
  return promise;
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
      const cleanupTask = startVisitorSessionCleanupTask({ pool: app.pool, logger });
      let shutdownPromise;
      const onClose = () => {
        cleanupTask.stop().catch(() => {});
      };
      server.on('close', onClose);

      server.shutdown = (opts) => {
        if (!shutdownPromise) {
          try {
            if (typeof app.setShuttingDown === 'function') {
              app.setShuttingDown(true);
            }
          } catch {}
          const shutdownPool = opts?.pool || app.pool;
          shutdownPromise = closeServerGracefully(server, cleanupTask, shutdownPool, {
            dbTracker: app.dbTracker,
            sessionStore: app.sessionStore,
            ...opts,
          })
            .finally(() => {
              try { server.removeListener('close', onClose); } catch {}
            });
        }
        return shutdownPromise;
      };
      server.sessionStore = app.sessionStore;
      server.getActiveWork = app.getActiveWork;
      server.getActiveRequests = app.getActiveWork;
      server.getActiveHandlerWork = app.getActiveHandlerWork;
      server.getActiveDatabaseWork = app.getActiveDatabaseWork;
      server.setShuttingDown = app.setShuttingDown;
      server.trackWork = app.trackWork;
      server.trackHandlerWork = app.trackHandlerWork;
      server.handlerTracker = app.handlerTracker;
      server.dbTracker = app.dbTracker;
      resolve(server);
    });
    server.on('error', (err) => {
      reject(err);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().then((server) => {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { process.removeListener('SIGTERM', shutdown); } catch {}
      try { process.removeListener('SIGINT', shutdown); } catch {}

      // Explicit hard-termination boundary: if graceful shutdown hangs, forcibly terminate process
      const hardExitTimer = setTimeout(() => {
        console.error('Shutdown deadline exceeded: forcing process exit');
        process.exit(1);
      }, DEFAULT_SHUTDOWN_TIMEOUT_MS + 1000);
      if (typeof hardExitTimer.unref === 'function') hardExitTimer.unref();

      server.shutdown().then(() => {
        clearTimeout(hardExitTimer);
        process.exit(0);
      }).catch((error) => {
        clearTimeout(hardExitTimer);
        const safeCode = sanitizeDbErrorCode(error?.code);
        console.error(`Graceful shutdown failed: ${safeCode} (forced process termination)`);
        process.exit(1);
      });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }).catch((error) => {
    if (error.code === 'INVALID_CONFIGURATION') {
      console.error(error.message);
    } else if (!error.message?.includes('Database readiness check failed')) {
      const safeCode = sanitizeDbErrorCode(error.code);
      console.error(`Server startup failed: ${safeCode}`);
    }
    process.exit(1);
  });
}
