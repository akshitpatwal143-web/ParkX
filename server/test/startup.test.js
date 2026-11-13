import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import session from 'express-session';
import {
  startServer,
  verifyDatabaseReadiness,
  sanitizeDbErrorCode,
  resolveServerListenOptions,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, '../src/index.js');

const validTestEnv = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-secret-that-is-at-least-32-bytes-long',
  ALLOWED_ORIGINS: 'http://localhost:5173',
};

function createControllableMockPool({
  hangQuery = false,
  hangAcquisition = false,
  failOnQuery = false,
  failureCode = 'ECONNREFUSED',
  errorDetails = '',
} = {}) {
  let connectionAcquired = false;
  let connectionReleased = false;
  let connectionDestroyed = false;
  let streamDestroyed = false;
  let removedFromPool = false;
  let queryPromiseTerminated = false;
  let queryExecuted = false;

  let queryRejectFn = null;
  let acquisitionResolveFn = null;

  const mockStream = {
    get destroyed() {
      return streamDestroyed;
    },
    destroy() {
      streamDestroyed = true;
      if (queryRejectFn) {
        queryPromiseTerminated = true;
        queryRejectFn(new Error('Connection stream terminated: query cancelled'));
        queryRejectFn = null;
      }
    },
  };

  const mockConnection = {
    _released: false,
    stream: mockStream,
    connection: {
      stream: mockStream,
      _released: false,
      _removeFromPool() {
        removedFromPool = true;
      },
      destroy() {
        connectionDestroyed = true;
        mockStream.destroy();
      },
    },
    _removeFromPool() {
      removedFromPool = true;
    },
    release() {
      if (this._released) {
        throw new Error('Cannot release connection that has already been released or destroyed');
      }
      connectionReleased = true;
      this._released = true;
    },
    destroy() {
      connectionDestroyed = true;
      this.connection.destroy();
    },
    query(sql) {
      if (hangQuery) {
        return new Promise((resolve, reject) => {
          queryRejectFn = reject;
        });
      }
      if (failOnQuery) {
        return Promise.reject(
          Object.assign(new Error(`Query error: ${errorDetails || 'db error'}`), {
            code: failureCode,
          })
        );
      }
      if (sql === 'SELECT 1') {
        queryExecuted = true;
        return Promise.resolve([[{ 1: 1 }]]);
      }
      return Promise.reject(new Error(`Unexpected query: ${sql}`));
    },
  };

  return {
    get connectionAcquired() {
      return connectionAcquired;
    },
    get connectionReleased() {
      return connectionReleased;
    },
    get connectionDestroyed() {
      return connectionDestroyed;
    },
    get streamDestroyed() {
      return streamDestroyed;
    },
    get removedFromPool() {
      return removedFromPool;
    },
    get queryPromiseTerminated() {
      return queryPromiseTerminated;
    },
    get queryExecuted() {
      return queryExecuted;
    },
    get mockConnection() {
      return mockConnection;
    },
    getConnection() {
      if (hangAcquisition) {
        return new Promise((resolve) => {
          acquisitionResolveFn = resolve;
        });
      }
      connectionAcquired = true;
      return Promise.resolve(mockConnection);
    },
    resolveLateAcquisition() {
      if (acquisitionResolveFn) {
        connectionAcquired = true;
        acquisitionResolveFn(mockConnection);
        acquisitionResolveFn = null;
      }
    },
    query(sql) {
      if (hangQuery) {
        return new Promise((resolve, reject) => {
          queryRejectFn = reject;
        });
      }
      if (sql === 'SELECT 1') {
        queryExecuted = true;
        return Promise.resolve([[{ 1: 1 }]]);
      }
      return Promise.reject(new Error(`Unexpected query: ${sql}`));
    },
  };
}

const openServers = [];
after(async () => {
  for (const s of openServers) {
    await new Promise((res) => s.close(res));
  }
});

test('Database readiness: acquires connection, runs SELECT 1, and releases connection back to pool on success', async () => {
  const pool = createControllableMockPool();
  const ready = await verifyDatabaseReadiness(pool);
  assert.equal(ready, true);
  assert.equal(pool.connectionAcquired, true);
  assert.equal(pool.queryExecuted, true);
  assert.equal(pool.connectionReleased, true);
  assert.equal(pool.connectionDestroyed, false);
  assert.equal(pool.streamDestroyed, false);
});

test('Database readiness timeout: bounded check forcibly tears down socket stream, unregisters from pool, and terminates query', async () => {
  const pool = createControllableMockPool({ hangQuery: true });
  const start = Date.now();

  await assert.rejects(
    async () => {
      await verifyDatabaseReadiness(pool, { timeoutMs: 50 });
    },
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      assert.ok(!err.message.includes('password'), 'Error must not leak secrets');
      return true;
    }
  );

  const duration = Date.now() - start;
  assert.ok(duration < 500, `Timeout check should fail promptly around 50ms, took ${duration}ms`);
  assert.equal(pool.connectionAcquired, true, 'Connection should have been acquired');
  assert.equal(pool.streamDestroyed, true, 'Socket stream must be forcibly destroyed');
  assert.equal(pool.removedFromPool, true, 'Connection must be removed from pool');
  assert.equal(pool.connectionDestroyed, true, 'Connection destroy must be triggered');
  assert.equal(pool.queryPromiseTerminated, true, 'In-flight query promise must be actively terminated');
  assert.equal(pool.connectionReleased, false, 'Invalidated connection must NOT be released back to the pool');
  assert.equal(pool.mockConnection._released, true, 'Connection must be marked as unusable/released');
});

test('Database readiness timeout: late connection acquisition is contained and destroyed, never leaked or returned to pool', async () => {
  const pool = createControllableMockPool({ hangAcquisition: true });

  await assert.rejects(
    async () => {
      await verifyDatabaseReadiness(pool, { timeoutMs: 30 });
    },
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      return true;
    }
  );

  assert.equal(pool.connectionAcquired, false, 'Connection was not acquired within timeout window');

  // Simulate MySQL pool late connection resolution after timeout fired
  pool.resolveLateAcquisition();
  // Allow next-tick microtasks to execute
  await new Promise((res) => setTimeout(res, 10));

  assert.equal(pool.connectionAcquired, true, 'Late acquisition occurred');
  assert.equal(pool.streamDestroyed, true, 'Late connection must be immediately force-destroyed');
  assert.equal(pool.removedFromPool, true, 'Late connection must be removed from pool');
  assert.equal(pool.connectionReleased, false, 'Late connection must NOT be released to pool');
});

test('Database readiness failure: query rejection triggers forced socket teardown and never returns connection to pool', async () => {
  const pool = createControllableMockPool({
    failOnQuery: true,
    failureCode: 'ECONNRESET',
    errorDetails: 'Connection reset by peer: secret_token_xyz',
  });

  await assert.rejects(
    async () => {
      await verifyDatabaseReadiness(pool);
    },
    (err) => {
      assert.equal(err.code, 'ECONNRESET');
      assert.ok(!err.message.includes('secret_token_xyz'), 'Error must not leak credentials');
      return true;
    }
  );

  assert.equal(pool.connectionAcquired, true);
  assert.equal(pool.streamDestroyed, true, 'Stream must be destroyed on query failure');
  assert.equal(pool.removedFromPool, true, 'Failed connection must be removed from pool');
  assert.equal(pool.connectionReleased, false, 'Failed connection must NOT be released to pool');
});

test('Database error code sanitization: strict whitelist permits only approved codes and rejects regex patterns, credentials, and arbitrary values', () => {
  // 1. Whitelisted and recognized codes strictly preserved
  assert.equal(sanitizeDbErrorCode('ER_ACCESS_DENIED_ERROR'), 'ER_ACCESS_DENIED_ERROR');
  assert.equal(sanitizeDbErrorCode('ECONNREFUSED'), 'ECONNREFUSED');
  assert.equal(sanitizeDbErrorCode('ETIMEDOUT'), 'ETIMEDOUT');
  assert.equal(sanitizeDbErrorCode('ER_BAD_DB_ERROR'), 'ER_BAD_DB_ERROR');
  assert.equal(sanitizeDbErrorCode('PROTOCOL_CONNECTION_LOST'), 'PROTOCOL_CONNECTION_LOST');

  // 2. Former regex patterns matching ER_* or E* that are NOT in the whitelist MUST be rejected
  assert.equal(sanitizeDbErrorCode('ER_PASSWORD_SECRET_VALUE'), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode('E_SECRET_DATA'), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode('ER_USER_CREDENTIALS'), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode('ER_MY_INVENTED_CODE'), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode('E_ANYTHING_UNLISTED'), 'DB_CONNECTION_ERROR');

  // 3. Arbitrary strings, credentials, connection strings, SQL statements
  assert.equal(sanitizeDbErrorCode('super_secret_password_123'), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode('mysql://root:secret@127.0.0.1:3306'), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode('SELECT * FROM users'), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode('invalid-code-with-dashes'), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode('password=admin'), 'DB_CONNECTION_ERROR');

  // 4. Non-strings and empty values
  assert.equal(sanitizeDbErrorCode(null), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode(undefined), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode(12345), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode({ code: 'ECONNREFUSED' }), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode(''), 'DB_CONNECTION_ERROR');
  assert.equal(sanitizeDbErrorCode('   '), 'DB_CONNECTION_ERROR');
});

test('Server startup: logs sanitized error identifier when database code is unapproved', async () => {
  const pool = createControllableMockPool({
    failOnQuery: true,
    failureCode: 'ER_PASSWORD_SECRET_VALUE',
    errorDetails: 'Raw database error details should never be logged',
  });

  const errorLogs = [];
  const customLogger = {
    log: () => {},
    error: (msg) => errorLogs.push(msg),
  };

  await assert.rejects(
    async () => {
      await startServer({
        env: validTestEnv,
        pool,
        store: new session.MemoryStore(),
        port: 0,
        logger: customLogger,
      });
    },
    (err) => {
      assert.equal(err.code, 'DB_CONNECTION_ERROR');
      return true;
    }
  );

  assert.ok(errorLogs.length > 0);
  const logOutput = errorLogs.join(' ');
  assert.ok(logOutput.includes('DB_CONNECTION_ERROR'));
  assert.ok(!logOutput.includes('ER_PASSWORD_SECRET_VALUE'), 'Unapproved code must never be logged');
  assert.ok(!logOutput.includes('Raw database error details'));
});

test('Server startup: binds to 0.0.0.0 and PORT env variable when database is ready', async () => {
  const pool = createControllableMockPool();
  const logs = [];
  const customLogger = {
    log: (msg) => logs.push(msg),
    error: (msg) => logs.push(msg),
  };

  const server = await startServer({
    env: { ...validTestEnv, PORT: '0' },
    pool,
    store: new session.MemoryStore(),
    logger: customLogger,
  });
  openServers.push(server);

  const addr = server.address();
  assert.ok(addr, 'Server must have an address');
  assert.equal(addr.address, '0.0.0.0', 'Server must listen on 0.0.0.0 for container / Render compatibility');
  assert.ok(addr.port > 0, 'Server must be listening on assigned port');
  assert.ok(pool.queryExecuted, 'Database readiness check must have executed before listening');
  assert.ok(logs.some((l) => l.includes(`PARKX server listening on 0.0.0.0:${addr.port}`)));
});

test('Server startup fallback resolution: omitted PORT resolves to 5001 on host 0.0.0.0 without occupying fixed port', () => {
  const envWithoutPort = { ...validTestEnv };
  delete envWithoutPort.PORT;

  // 1. Verify clean omission resolves to port 5001 on host 0.0.0.0
  const omittedResult = resolveServerListenOptions({ env: envWithoutPort });
  assert.equal(omittedResult.port, 5001, 'Omitted PORT must resolve to default port 5001');
  assert.equal(omittedResult.host, '0.0.0.0', 'Omitted host must resolve to 0.0.0.0');

  // 2. Verify invalid, empty, or whitespace PORT values safely fallback to 5001
  assert.equal(resolveServerListenOptions({ env: { PORT: '' } }).port, 5001);
  assert.equal(resolveServerListenOptions({ env: { PORT: '   ' } }).port, 5001);
  assert.equal(resolveServerListenOptions({ env: { PORT: 'abc' } }).port, 5001);
  assert.equal(resolveServerListenOptions({ env: { PORT: '-1' } }).port, 5001);

  // 3. Verify valid PORT values are respected
  const customResult = resolveServerListenOptions({ env: { PORT: '10000' } });
  assert.equal(customResult.port, 10000);
  assert.equal(customResult.host, '0.0.0.0');
});

test('Server startup: aborts startup, starts no HTTP listener, and logs sanitized error when database is unavailable', async () => {
  const pool = createControllableMockPool({
    failOnQuery: true,
    failureCode: 'ECONNREFUSED',
    errorDetails: 'Connection refused with password super_secret_password',
  });

  const errorLogs = [];
  const customLogger = {
    log: () => {},
    error: (msg) => errorLogs.push(msg),
  };

  await assert.rejects(
    async () => {
      await startServer({
        env: validTestEnv,
        pool,
        store: new session.MemoryStore(),
        port: 0,
        logger: customLogger,
      });
    },
    (err) => {
      assert.equal(err.code, 'ECONNREFUSED');
      return true;
    }
  );

  assert.ok(errorLogs.length > 0, 'Must log error message');
  const combinedLogs = errorLogs.join(' ');
  assert.ok(combinedLogs.includes('Database readiness check failed'));
  assert.ok(combinedLogs.includes('ECONNREFUSED'));
  assert.ok(!combinedLogs.includes('super_secret_password'), 'Must never log credentials');
});

test('CLI startup: exits with non-zero status and sanitized output when database cannot be reached', async () => {
  const child = spawn(
    process.execPath,
    [serverEntry],
    {
      env: {
        ...process.env,
        ...validTestEnv,
        PORT: '0',
        DB_HOST: '127.0.0.1',
        DB_PORT: '39999', // Non-existent MySQL port
        DB_USER: 'parkx_test_user',
        DB_PASSWORD: 'plain_text_test_password',
      },
    }
  );

  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', (d) => { stdout += d.toString(); });

  const exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
  });

  assert.equal(exitCode, 1, 'Process must exit with non-zero status code 1');
  const output = stderr + stdout;
  assert.ok(output.includes('Database readiness check failed'), 'Output must indicate readiness failure');
  assert.ok(!output.includes('plain_text_test_password'), 'Output must NEVER leak credentials');
});
