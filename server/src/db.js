import mysql from 'mysql2/promise';

let pool;

/**
 * Returns a singleton mysql2 connection pool.
 * Reads credentials from process.env (loaded by dotenv in index.js).
 */
export function getPool() {
  if (!pool) {
    if (process.env.NODE_ENV === 'production' && (!process.env.DB_USER || process.env.DB_USER === 'root' || !process.env.DB_PASSWORD)) {
      throw new Error('Production requires DB_USER for a dedicated account and DB_PASSWORD.');
    }
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'parkx_app',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'parkx_db',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
    });
  }
  return pool;
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
    console.error('MySQL connection failed:', { code: err.code || 'DB_CONNECTION_ERROR' });
    return false;
  }
}
