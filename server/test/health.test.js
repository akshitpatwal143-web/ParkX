import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import session from 'express-session';
import mysql from 'mysql2';
import {
  createApp,
  createPoolConfig,
  DEFAULT_DB_CONNECTION_LIMIT,
  MAX_DB_CONNECTION_LIMIT,
  parseConnectionLimit,
  parseDbSsl,
} from '../src/index.js';

const origin = 'http://localhost:5173';
const env = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-secret-that-is-at-least-32-bytes-long',
  ALLOWED_ORIGINS: origin,
};

const openServers = [];
after(async () => {
  for (const s of openServers) {
    await new Promise((res) => s.close(res));
  }
});

function listenApp(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      openServers.push(s);
      const port = s.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => s.close(res)),
      });
    });
  });
}

test('Pool configuration: builds defaults with keepalive, idle timeout, and bounds', () => {
  const config = createPoolConfig({});
  assert.equal(config.enableKeepAlive, true);
  assert.equal(config.keepAliveInitialDelay, 10000);
  assert.equal(config.idleTimeout, 30000);
  assert.equal(config.connectionLimit, 10);
  // Sensible maxIdle below connectionLimit so idle cleanup timer starts
  assert.equal(config.maxIdle, 5);
  assert.equal(config.connectTimeout, 10000);
  assert.equal(config.waitForConnections, true);
  assert.equal(config.ssl, undefined, 'TLS must remain opt-in and disabled by default');
});

test('Pool configuration: idle connection cleanup takes effect in mysql2', () => {
  const config = createPoolConfig({});
  assert.ok(config.maxIdle < config.connectionLimit, 'maxIdle must be strictly less than connectionLimit');

  // Verify directly with mysql2 that maxIdle < connectionLimit starts the cleanup timer
  const pool = mysql.createPool(config);
  try {
    assert.equal(pool.config.connectionLimit, 10);
    assert.equal(pool.config.maxIdle, 5);
    assert.equal(pool.config.idleTimeout, 30000);
    assert.ok(pool._removeIdleTimeoutConnectionsTimer !== undefined, 'mysql2 idle timer must be active');
  } finally {
    pool.end();
  }
});

test('Pool configuration: respects valid custom environment variables and clamps maxIdle', () => {
  const customEnv = {
    DB_HOST: 'mysql.railway.internal',
    DB_PORT: '3307',
    DB_USER: 'parkx_custom',
    DB_PASSWORD: 'secretpassword',
    DB_NAME: 'parkx_custom_db',
    DB_CONNECTION_LIMIT: '20',
    DB_MAX_IDLE: '8',
    DB_IDLE_TIMEOUT_MS: '15000',
    DB_KEEPALIVE_INITIAL_DELAY_MS: '5000',
    DB_CONNECT_TIMEOUT_MS: '8000',
  };
  const config = createPoolConfig(customEnv);
  assert.equal(config.host, 'mysql.railway.internal');
  assert.equal(config.port, 3307);
  assert.equal(config.user, 'parkx_custom');
  assert.equal(config.password, 'secretpassword');
  assert.equal(config.database, 'parkx_custom_db');
  assert.equal(config.connectionLimit, 20);
  assert.equal(config.maxIdle, 8);
  assert.equal(config.idleTimeout, 15000);
  assert.equal(config.keepAliveInitialDelay, 5000);
  assert.equal(config.connectTimeout, 8000);
  assert.equal(config.enableKeepAlive, true);

  // Valid lower override
  const lowerOverride = createPoolConfig({
    DB_CONNECTION_LIMIT: '10',
    DB_MAX_IDLE: '3',
  });
  assert.equal(lowerOverride.connectionLimit, 10);
  assert.equal(lowerOverride.maxIdle, 3);
  assert.ok(lowerOverride.maxIdle < lowerOverride.connectionLimit);

  // DB_MAX_IDLE equal to DB_CONNECTION_LIMIT clamps to connectionLimit - 1
  const equalConfig = createPoolConfig({
    DB_CONNECTION_LIMIT: '10',
    DB_MAX_IDLE: '10',
  });
  assert.equal(equalConfig.connectionLimit, 10);
  assert.equal(equalConfig.maxIdle, 9, 'maxIdle must be strictly less than connectionLimit');
  const equalPool = mysql.createPool(equalConfig);
  try {
    assert.ok(equalPool._removeIdleTimeoutConnectionsTimer !== undefined, 'mysql2 idle timer must be active when equal is clamped');
  } finally {
    equalPool.end();
  }

  // DB_MAX_IDLE greater than DB_CONNECTION_LIMIT clamps to connectionLimit - 1
  const greaterConfig = createPoolConfig({
    DB_CONNECTION_LIMIT: '10',
    DB_MAX_IDLE: '15',
  });
  assert.equal(greaterConfig.connectionLimit, 10);
  assert.equal(greaterConfig.maxIdle, 9, 'maxIdle must not exceed connectionLimit - 1');
  const greaterPool = mysql.createPool(greaterConfig);
  try {
    assert.ok(greaterPool._removeIdleTimeoutConnectionsTimer !== undefined, 'mysql2 idle timer must be active when greater is clamped');
  } finally {
    greaterPool.end();
  }

  // Invalid, negative, and non-numeric values fall back to safe default below connection limit
  for (const badValue of ['-5', 'invalid', 'NaN', ' ']) {
    const fallbackConfig = createPoolConfig({
      DB_CONNECTION_LIMIT: '10',
      DB_MAX_IDLE: badValue,
    });
    assert.equal(fallbackConfig.connectionLimit, 10);
    assert.equal(fallbackConfig.maxIdle, 5, `Bad value "${badValue}" must fall back to 5`);
    assert.ok(fallbackConfig.maxIdle < fallbackConfig.connectionLimit);
  }

  // When connectionLimit is small (e.g. 4) and maxIdle is unset, maxIdle is below limit
  const smallPoolConfig = createPoolConfig({
    DB_CONNECTION_LIMIT: '4',
  });
  assert.equal(smallPoolConfig.connectionLimit, 4);
  assert.equal(smallPoolConfig.maxIdle, 3);
  assert.ok(smallPoolConfig.maxIdle < smallPoolConfig.connectionLimit);
});

test('Pool configuration: bounds and validates DB_CONNECTION_LIMIT safely', () => {
  // Normal valid values
  assert.equal(createPoolConfig({ DB_CONNECTION_LIMIT: '25' }).connectionLimit, 25);
  assert.equal(createPoolConfig({ DB_CONNECTION_LIMIT: 25 }).connectionLimit, 25);

  // Maximum allowed value
  assert.equal(createPoolConfig({ DB_CONNECTION_LIMIT: String(MAX_DB_CONNECTION_LIMIT) }).connectionLimit, MAX_DB_CONNECTION_LIMIT);
  assert.equal(createPoolConfig({ DB_CONNECTION_LIMIT: MAX_DB_CONNECTION_LIMIT }).connectionLimit, MAX_DB_CONNECTION_LIMIT);

  // Unset variable uses default
  assert.equal(createPoolConfig({}).connectionLimit, DEFAULT_DB_CONNECTION_LIMIT);
  assert.equal(createPoolConfig({ DB_CONNECTION_LIMIT: undefined }).connectionLimit, DEFAULT_DB_CONNECTION_LIMIT);

  // Value above maximum
  assert.throws(
    () => createPoolConfig({ DB_CONNECTION_LIMIT: String(MAX_DB_CONNECTION_LIMIT + 1) }),
    /Invalid DB_CONNECTION_LIMIT/
  );

  // Unsafe integer
  assert.throws(
    () => createPoolConfig({ DB_CONNECTION_LIMIT: '9007199254740992' }),
    /Invalid DB_CONNECTION_LIMIT/
  );
  assert.throws(
    () => createPoolConfig({ DB_CONNECTION_LIMIT: Number.MAX_SAFE_INTEGER + 10 }),
    /Invalid DB_CONNECTION_LIMIT/
  );

  // Scientific notation producing an unsafe integer
  assert.throws(
    () => createPoolConfig({ DB_CONNECTION_LIMIT: '1e25' }),
    /Invalid DB_CONNECTION_LIMIT/
  );

  // Zero, negative, fractional, empty, and non-numeric values
  const invalidLimits = ['0', 0, '-5', -5, '10.5', 10.5, '', '   ', 'invalid', 'NaN', null];
  for (const bad of invalidLimits) {
    assert.throws(
      () => createPoolConfig({ DB_CONNECTION_LIMIT: bad }),
      /Invalid DB_CONNECTION_LIMIT/,
      `Should reject invalid limit: ${JSON.stringify(bad)}`
    );
  }
});

test('Pool configuration: single-connection pool tradeoff preserves active idle cleanup timer', () => {
  const config = createPoolConfig({ DB_CONNECTION_LIMIT: '1' });
  assert.equal(config.connectionLimit, 1);
  // Single-connection pool tradeoff: maxIdle is clamped to 0 to preserve maxIdle < connectionLimit
  assert.equal(config.maxIdle, 0);
  assert.ok(config.maxIdle < config.connectionLimit, 'maxIdle must be strictly less than connectionLimit');

  const pool = mysql.createPool(config);
  try {
    assert.ok(pool._removeIdleTimeoutConnectionsTimer !== undefined, 'mysql2 idle timer must be active for 1-connection pool');
  } finally {
    pool.end();
  }
});

test('Pool configuration: strictly parses DB_SSL and rejects invalid values', () => {
  // Explicit true forms: true, TRUE, ' true ', 1
  for (const trueVal of ['true', 'TRUE', ' true ', '1', 1, true]) {
    const config = createPoolConfig({
      DB_SSL: trueVal,
      DB_HOST: 'mysql.railway.internal',
    });
    assert.deepEqual(config.ssl, { rejectUnauthorized: true, verifyIdentity: true }, `Should enable TLS for ${trueVal}`);
  }

  // Explicit false forms: false, FALSE, ' false ', 0
  for (const falseVal of ['false', 'FALSE', ' false ', '0', 0, false]) {
    const config = createPoolConfig({
      DB_SSL: falseVal,
      DB_HOST: '127.0.0.1',
    });
    assert.equal(config.ssl, undefined, `Should disable TLS for ${falseVal}`);
  }

  // Unset variable
  assert.equal(createPoolConfig({}).ssl, undefined);
  assert.equal(createPoolConfig({ DB_SSL: undefined }).ssl, undefined);

  // Empty string and invalid values must fail fast before opening connection
  const invalidSslValues = ['', '   ', 'yes', 'enabled', '2', 'tru', 'on', 'null'];
  for (const badSsl of invalidSslValues) {
    assert.throws(
      () => createPoolConfig({ DB_SSL: badSsl }),
      /Invalid DB_SSL configuration/,
      `Should reject invalid DB_SSL: ${JSON.stringify(badSsl)}`
    );
  }
});

test('Pool configuration: rejects IP literals when DB_SSL is enabled with a generic error (no host leaked)', () => {
  const ipHosts = ['127.0.0.1', '192.168.1.50', '::1', '0.0.0.0'];

  for (const ip of ipHosts) {
    assert.throws(
      () => createPoolConfig({ DB_SSL: 'true', DB_HOST: ip }),
      (err) => {
        assert.equal(
          err.message,
          'TLS hostname verification requires a DNS hostname for DB_HOST, but an IP literal was provided.'
        );
        // Explicitly confirm the actual host string is never leaked in the error
        assert.ok(!err.message.includes(ip), `Error message must not include IP ${ip}`);
        return true;
      },
      `Should reject IPv4/IPv6 literal ${ip} when DB_SSL=true`
    );
  }

  // When DB_HOST is omitted with DB_SSL=true, default 127.0.0.1 must be rejected without leaking 127.0.0.1
  assert.throws(
    () => createPoolConfig({ DB_SSL: 'true' }),
    (err) => {
      assert.equal(
        err.message,
        'TLS hostname verification requires a DNS hostname for DB_HOST, but an IP literal was provided.'
      );
      assert.ok(!err.message.includes('127.0.0.1'), 'Error message must not leak 127.0.0.1');
      return true;
    },
    'Should reject default 127.0.0.1 when DB_SSL=true without DB_HOST'
  );
});

test('Health endpoint: returns 200 ok and process uptime when database query succeeds', async () => {
  let queryCount = 0;
  const mockPool = {
    async query(sql) {
      if (sql === 'SELECT 1') {
        queryCount++;
        return [[{ 1: 1 }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const app = createApp({
    env,
    pool: mockPool,
    store: new session.MemoryStore(),
  });
  const { baseUrl } = await listenApp(app);

  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(typeof data.uptime, 'number');
  assert.ok(data.uptime >= 0);
  assert.equal(queryCount, 1);
});

test('Health endpoint: recovers transparently on stale connection reset (PROTOCOL_CONNECTION_LOST)', async () => {
  let queryCount = 0;
  const warnings = [];
  const errors = [];
  const mockLogger = {
    warn: (msg, meta) => warnings.push({ msg, meta }),
    error: (msg, meta) => errors.push({ msg, meta }),
  };

  const mockPool = {
    async query(sql) {
      if (sql === 'SELECT 1') {
        queryCount++;
        if (queryCount === 1) {
          const err = new Error('Connection lost: The server closed the connection.');
          err.code = 'PROTOCOL_CONNECTION_LOST';
          throw err;
        }
        return [[{ 1: 1 }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const app = createApp({
    env,
    pool: mockPool,
    store: new session.MemoryStore(),
    logger: mockLogger,
  });
  const { baseUrl } = await listenApp(app);

  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(typeof data.uptime, 'number');
  assert.equal(queryCount, 2, 'Should have retried query on fresh connection');

  // Verify warning was logged for connection reset
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].meta.code, 'PROTOCOL_CONNECTION_LOST');
  assert.equal(errors.length, 0, 'No error should be logged when retry succeeds');
});

test('Health endpoint: recovers transparently on ECONNRESET and EPIPE', async () => {
  for (const resetCode of ['ECONNRESET', 'EPIPE']) {
    let queryCount = 0;
    const warnings = [];
    const mockLogger = {
      warn: (msg, meta) => warnings.push({ msg, meta }),
      error: () => {},
    };

    const mockPool = {
      async query(sql) {
        if (sql === 'SELECT 1') {
          queryCount++;
          if (queryCount === 1) {
            const err = new Error('read ECONNRESET');
            err.code = resetCode;
            throw err;
          }
          return [[{ 1: 1 }]];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const app = createApp({
      env,
      pool: mockPool,
      store: new session.MemoryStore(),
      logger: mockLogger,
    });
    const { baseUrl } = await listenApp(app);

    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(queryCount, 2);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].meta.code, resetCode);
  }
});

test('Health endpoint: logs sanitized error and returns 503 when stale connection retry also fails', async () => {
  let queryCount = 0;
  const warnings = [];
  const errors = [];
  const mockLogger = {
    warn: (msg, meta) => warnings.push({ msg, meta }),
    error: (msg, meta) => errors.push({ msg, meta }),
  };

  const mockPool = {
    async query(sql) {
      if (sql === 'SELECT 1') {
        queryCount++;
        const err = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const app = createApp({
    env,
    pool: mockPool,
    store: new session.MemoryStore(),
    logger: mockLogger,
  });
  const { baseUrl } = await listenApp(app);

  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.status, 'db_error');
  assert.equal(typeof data.uptime, 'number');
  assert.equal(queryCount, 2, 'Should have attempted initial query and 1 retry');

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].meta.code, 'ECONNRESET');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].meta.code, 'ECONNRESET');
});

test('Health endpoint: does not retry on non-stale database failure and logs sanitized error', async () => {
  let queryCount = 0;
  const warnings = [];
  const errors = [];
  const mockLogger = {
    warn: (msg, meta) => warnings.push({ msg, meta }),
    error: (msg, meta) => errors.push({ msg, meta }),
  };

  const mockPool = {
    async query(sql) {
      if (sql === 'SELECT 1') {
        queryCount++;
        const err = new Error('connect ECONNREFUSED 127.0.0.1:3306');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const app = createApp({
    env,
    pool: mockPool,
    store: new session.MemoryStore(),
    logger: mockLogger,
  });
  const { baseUrl } = await listenApp(app);

  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.status, 'db_error');
  assert.equal(typeof data.uptime, 'number');
  assert.equal(queryCount, 1, 'Should NOT retry on non-stale connection failures');

  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].meta.code, 'ECONNREFUSED');
});

test('Health endpoint: sanitizes unknown error codes and never leaks credentials or raw messages', async () => {
  const errors = [];
  const mockLogger = {
    warn: () => {},
    error: (msg, meta) => errors.push({ msg, meta, full: JSON.stringify({ msg, meta }) }),
  };

  const secretMessage = 'Access denied for user \'parkx_app\'@\'railway.internal\' (using password: YES)';
  const mockPool = {
    async query() {
      const err = new Error(secretMessage);
      err.code = 'ER_ACCESS_SECRET_LEAK_1234';
      err.sql = 'SELECT 1 -- contains sensitive token';
      throw err;
    },
  };

  const app = createApp({
    env,
    pool: mockPool,
    store: new session.MemoryStore(),
    logger: mockLogger,
  });
  const { baseUrl } = await listenApp(app);

  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.status, 'db_error');

  assert.equal(errors.length, 1);
  assert.equal(errors[0].meta.code, 'DB_CONNECTION_ERROR', 'Unapproved code must be mapped to safe identifier');

  // Verify secretLeak is completely absent from all log fields
  const serializedLogs = JSON.stringify(errors);
  assert.ok(!serializedLogs.includes('railway'), 'Must not log host details');
  assert.ok(!serializedLogs.includes('parkx_app'), 'Must not log database username');
  assert.ok(!serializedLogs.includes('password'), 'Must not log password info');
  assert.ok(!serializedLogs.includes('ER_ACCESS_SECRET_LEAK_1234'), 'Must not log raw unapproved code');
  assert.ok(!serializedLogs.includes('SELECT 1 -- contains sensitive token'), 'Must not log SQL');
});

test('Health endpoint: logger failures are best-effort and do not break responses', async () => {
  const throwingLogger = {
    warn: () => {
      throw new Error('Logger disk full during warn');
    },
    error: () => {
      throw new Error('Logger network failure during error');
    },
  };

  // Case 1: Database failure with throwing error logger still returns 503 db_error
  const failingPool = {
    async query() {
      const err = new Error('Connection refused');
      err.code = 'ECONNREFUSED';
      throw err;
    },
  };

  const app1 = createApp({
    env,
    pool: failingPool,
    store: new session.MemoryStore(),
    logger: throwingLogger,
  });
  const { baseUrl: url1 } = await listenApp(app1);

  const res1 = await fetch(`${url1}/api/health`);
  assert.equal(res1.status, 503);
  const body1 = await res1.json();
  assert.equal(body1.status, 'db_error');

  // Case 2: Stale disconnect with throwing warn logger still retries and succeeds (200)
  let attempt = 0;
  const staleThenRecoverPool = {
    async query(sql) {
      if (sql === 'SELECT 1') {
        attempt++;
        if (attempt === 1) {
          const err = new Error('Socket closed');
          err.code = 'ECONNRESET';
          throw err;
        }
        return [[{ 1: 1 }]];
      }
      throw new Error('Unexpected');
    },
  };

  const app2 = createApp({
    env,
    pool: staleThenRecoverPool,
    store: new session.MemoryStore(),
    logger: throwingLogger,
  });
  const { baseUrl: url2 } = await listenApp(app2);

  const res2 = await fetch(`${url2}/api/health`);
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.status, 'ok');
  assert.equal(attempt, 2);

  // Case 3: Stale disconnect with throwing warn and error loggers that fails on retry returns 503
  const permanentResetPool = {
    async query() {
      const err = new Error('Socket closed permanently');
      err.code = 'ECONNRESET';
      throw err;
    },
  };

  const app3 = createApp({
    env,
    pool: permanentResetPool,
    store: new session.MemoryStore(),
    logger: throwingLogger,
  });
  const { baseUrl: url3 } = await listenApp(app3);

  const res3 = await fetch(`${url3}/api/health`);
  assert.equal(res3.status, 503);
  const body3 = await res3.json();
  assert.equal(body3.status, 'db_error');
});
