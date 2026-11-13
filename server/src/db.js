import { isIP } from 'node:net';
import mysql from 'mysql2/promise';

let pool;

export const DEFAULT_DB_CONNECTION_LIMIT = 10;
export const MAX_DB_CONNECTION_LIMIT = 100;

/**
 * Validates and parses DB_CONNECTION_LIMIT safely.
 * Requires a positive safe integer between 1 and MAX_DB_CONNECTION_LIMIT.
 * Fails fast on explicitly supplied invalid, non-numeric, unsafe, zero, or out-of-range values.
 * Returns DEFAULT_DB_CONNECTION_LIMIT if unset.
 */
export function parseConnectionLimit(raw) {
  if (raw === undefined) {
    return DEFAULT_DB_CONNECTION_LIMIT;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`Invalid DB_CONNECTION_LIMIT: must be a positive integer between 1 and ${MAX_DB_CONNECTION_LIMIT}.`);
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_DB_CONNECTION_LIMIT) {
      throw new Error(`Invalid DB_CONNECTION_LIMIT: must be a positive integer between 1 and ${MAX_DB_CONNECTION_LIMIT}.`);
    }
    return parsed;
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 1 || raw > MAX_DB_CONNECTION_LIMIT) {
      throw new Error(`Invalid DB_CONNECTION_LIMIT: must be a positive integer between 1 and ${MAX_DB_CONNECTION_LIMIT}.`);
    }
    return raw;
  }
  throw new Error(`Invalid DB_CONNECTION_LIMIT: must be a positive integer between 1 and ${MAX_DB_CONNECTION_LIMIT}.`);
}

/**
 * Parses DB_SSL strictly.
 * Accepts 'true', '1' (enabled) and 'false', '0' (disabled), case-insensitively with whitespace trimmed.
 * Returns false if unset. Rejects any other value with a configuration error.
 */
export function parseDbSsl(raw) {
  if (raw === undefined) {
    return false;
  }
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'number') {
    if (raw === 1) return true;
    if (raw === 0) return false;
    throw new Error('Invalid DB_SSL configuration: must be "true", "false", "1", or "0".');
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }
  throw new Error('Invalid DB_SSL configuration: must be "true", "false", "1", or "0".');
}

/**
 * Builds pool configuration with keepalive, idle timeout, and bounds.
 *
 * Single-Connection Pool Tradeoff:
 * When connectionLimit is 1, maxIdle is clamped to 0 to preserve maxIdle < connectionLimit.
 * mysql2 only starts its idle connection cleanup timer when maxIdle < connectionLimit.
 * In a 1-connection pool, setting maxIdle = 0 ensures idle connections are pruned upon idleTimeout
 * rather than holding a severed socket indefinitely, at the minor cost of reconnecting when the single
 * connection goes idle and new queries arrive.
 */
export function createPoolConfig(env = process.env) {
  const connectionLimit = parseConnectionLimit(env.DB_CONNECTION_LIMIT);

  let maxIdle;
  if (typeof env.DB_MAX_IDLE === 'string' && env.DB_MAX_IDLE.trim() !== '') {
    const trimmed = env.DB_MAX_IDLE.trim();
    if (/^\d+$/.test(trimmed)) {
      const rawMaxIdle = Number(trimmed);
      // Ensure maxIdle is strictly less than connectionLimit to keep idle cleanup active
      maxIdle = Math.min(rawMaxIdle, Math.max(0, connectionLimit - 1));
    }
  } else if (typeof env.DB_MAX_IDLE === 'number' && Number.isInteger(env.DB_MAX_IDLE) && env.DB_MAX_IDLE >= 0) {
    maxIdle = Math.min(env.DB_MAX_IDLE, Math.max(0, connectionLimit - 1));
  }
  if (maxIdle === undefined) {
    maxIdle = Math.min(5, Math.max(0, connectionLimit - 1));
  }

  const idleTimeout = Number(env.DB_IDLE_TIMEOUT_MS);
  const keepAliveDelay = Number(env.DB_KEEPALIVE_INITIAL_DELAY_MS);
  const connectTimeout = Number(env.DB_CONNECT_TIMEOUT_MS);
  const host = typeof env.DB_HOST === 'string' && env.DB_HOST.trim() !== '' ? env.DB_HOST.trim() : '127.0.0.1';

  const config = {
    host,
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER || 'parkx_app',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'parkx_db',
    waitForConnections: true,
    connectionLimit,
    maxIdle,
    idleTimeout: Number.isInteger(idleTimeout) && idleTimeout > 0 ? idleTimeout : 30000,
    queueLimit: 0,
    charset: 'utf8mb4',
    enableKeepAlive: true,
    keepAliveInitialDelay: Number.isInteger(keepAliveDelay) && keepAliveDelay >= 0 ? keepAliveDelay : 10000,
    connectTimeout: Number.isInteger(connectTimeout) && connectTimeout > 0 ? connectTimeout : 10000,
  };

  const sslEnabled = parseDbSsl(env.DB_SSL);
  if (sslEnabled) {
    if (isIP(host)) {
      throw new Error('TLS hostname verification requires a DNS hostname for DB_HOST, but an IP literal was provided.');
    }
    config.ssl = {
      rejectUnauthorized: true,
      verifyIdentity: true,
    };
  }

  return config;
}

/**
 * Returns a singleton mysql2 connection pool.
 * Reads credentials from process.env (loaded by dotenv in index.js).
 */
export function getPool() {
  if (!pool) {
    if (process.env.NODE_ENV === 'production' && (!process.env.DB_USER || process.env.DB_USER === 'root' || !process.env.DB_PASSWORD)) {
      throw new Error('Production requires DB_USER for a dedicated account and DB_PASSWORD.');
    }
    pool = mysql.createPool(createPoolConfig(process.env));
  }
  return pool;
}

/**
 * Closes singleton connection pool if active (useful for testing and graceful shutdown).
 */
export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export const KNOWN_DB_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'EPERM',
  'ER_ACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_CON_COUNT_ERROR',
  'ER_HOST_NOT_PRIVILEGED',
  'ER_HOST_IS_BLOCKED',
  'ER_NET_READ_ERROR',
  'ER_NET_WRITE_ERROR',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_PACKETS_OUT_OF_ORDER',
  'DB_CONNECTION_ERROR',
]);

/**
 * Validates database error codes against strict KNOWN_DB_ERROR_CODES whitelist.
 * Returns code if and only if it is in KNOWN_DB_ERROR_CODES.
 * Replaces every unknown, malformed, or arbitrary value with 'DB_CONNECTION_ERROR'.
 */
export function sanitizeDbErrorCode(code) {
  if (typeof code === 'string' && KNOWN_DB_ERROR_CODES.has(code.trim())) {
    return code.trim();
  }
  return 'DB_CONNECTION_ERROR';
}

/**
 * Forcefully destroys a connection and its underlying socket stream, removing
 * it from the pool and ensuring it can never be returned or reused.
 */
export function forceDestroyConnection(conn) {
  if (!conn) return;

  try {
    conn._released = true;
    if (conn.connection) {
      conn.connection._released = true;
    }
  } catch {}

  try {
    if (typeof conn._removeFromPool === 'function') {
      conn._removeFromPool();
    } else if (typeof conn.connection?._removeFromPool === 'function') {
      conn.connection._removeFromPool();
    }
  } catch {}

  try {
    const stream = conn.connection?.stream || conn.stream;
    if (stream && typeof stream.destroy === 'function' && !stream.destroyed) {
      stream.destroy(new Error('Connection destroyed'));
    }
  } catch {}

  try {
    if (typeof conn.destroy === 'function') {
      conn.destroy();
    } else if (typeof conn.connection?.destroy === 'function') {
      conn.connection.destroy();
    }
  } catch {}
}

/**
 * Quick health-check: executes SELECT 1 and returns true/false.
 */
export async function testConnection() {
  try {
    const p = getPool();
    await p.query('SELECT 1');
    return true;
  } catch (err) {
    const safeCode = sanitizeDbErrorCode(err.code);
    console.error('MySQL connection failed:', { code: safeCode });
    return false;
  }
}

/**
 * Verifies database readiness by acquiring a connection from the pool and executing SELECT 1
 * within a bounded timeout.
 * If the check succeeds, releases the connection back to the pool.
 * If the check fails or times out, safely destroys the connection so a compromised or stuck
 * connection is never returned to the pool.
 * Throws a sanitized Error without leaking credentials or connection details.
 */
export async function verifyDatabaseReadiness(
  poolInstance = getPool(),
  { timeoutMs = Number(process.env.DB_READINESS_TIMEOUT_MS) || 5000 } = {}
) {
  const effectiveTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  let connection = null;
  let timerId;
  let timedOut = false;

  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      timedOut = true;
      const err = new Error('Database readiness check timed out');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, effectiveTimeout);
  });

  try {
    const checkPromise = (async () => {
      if (typeof poolInstance.getConnection === 'function') {
        const connPromise = poolInstance.getConnection();

        // Safely contain late acquisition to prevent leaks
        connPromise
          .then((lateConn) => {
            if (timedOut) {
              forceDestroyConnection(lateConn);
            }
          })
          .catch(() => {});

        connection = await connPromise;

        // Race check if timeout occurred during connection acquisition
        if (timedOut) {
          forceDestroyConnection(connection);
          connection = null;
          return;
        }

        const queryPromise = connection.query('SELECT 1');
        queryPromise.catch(() => {});
        await queryPromise;
      } else if (typeof poolInstance.query === 'function') {
        const queryPromise = poolInstance.query('SELECT 1');
        queryPromise.catch(() => {});
        await queryPromise;
      } else {
        throw new Error('Invalid database pool instance.');
      }
    })();

    await Promise.race([checkPromise, timeoutPromise]);
    return true;
  } catch (err) {
    if (connection) {
      forceDestroyConnection(connection);
      connection = null;
    }

    const safeCode = sanitizeDbErrorCode(err.code);
    const sanitizedError = new Error(`Database connection failed: ${safeCode}`);
    sanitizedError.code = safeCode;
    throw sanitizedError;
  } finally {
    clearTimeout(timerId);
    if (connection && !timedOut) {
      try {
        if (typeof connection.release === 'function') {
          connection.release();
        }
      } catch {}
      connection = null;
    }
  }
}
