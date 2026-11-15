import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import session from 'express-session';
import {
  createApp,
  wrapAsyncHandler,
  startServer,
  closeServerGracefully,
  verifyDatabaseReadiness,
  sanitizeDbErrorCode,
  resolveServerListenOptions,
} from '../src/index.js';
import { verifyVisitorSessionsSchema } from '../src/migrate.js';
import { DatabaseTracker, instrumentPool, isInstrumentedPool, getInstrumentedPoolTracker } from '../src/dbTracker.js';
import { startVisitorSessionCleanupTask } from '../src/services/sessionCleanup.js';
import MySQLStoreFactory from 'express-mysql-session';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, '../src/index.js');

const validTestEnv = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-secret-that-is-at-least-32-bytes-long',
  ALLOWED_ORIGINS: 'http://localhost:5173',
};

test('Graceful server shutdown waits for cleanup before completing', async () => {
  let closeCalled = false;
  let finishCleanup;
  let poolEnded = false;
  const cleanupGate = new Promise((resolve) => { finishCleanup = resolve; });
  const fakeServer = {
    close(callback) {
      closeCalled = true;
      callback();
    },
  };
  const cleanupTask = { stop: () => cleanupGate };
  const pool = { async end() { poolEnded = true; } };

  let shutdownCompleted = false;
  const shutdown = closeServerGracefully(fakeServer, cleanupTask, pool).then(() => {
    shutdownCompleted = true;
  });
  await Promise.resolve();
  assert.equal(closeCalled, true, 'HTTP listener begins closing immediately');
  assert.equal(shutdownCompleted, false, 'shutdown cannot complete while cleanup is draining');
  assert.equal(poolEnded, false, 'database pool remains open until cleanup finishes');
  finishCleanup();
  await shutdown;
  assert.equal(shutdownCompleted, true);
  assert.equal(poolEnded, true);
});

test('closeServerGracefully: successful shutdown closes server, drains cleanup, and closes pool in order', async () => {
  const order = [];
  const fakeServer = {
    close(cb) {
      order.push('server.close');
      cb();
    },
  };
  const fakeCleanup = {
    stop: async () => {
      order.push('cleanup.stop');
    },
  };
  const fakePool = {
    end: async () => {
      order.push('pool.end');
    },
  };

  await closeServerGracefully(fakeServer, fakeCleanup, fakePool);
  assert.deepEqual(order, ['server.close', 'cleanup.stop', 'pool.end']);
});

test('closeServerGracefully: HTTP server close failure still attempts cleanup and pool closure, and preserves HTTP error', async () => {
  let cleanupCalled = false;
  let poolEnded = false;
  const fakeServer = {
    close(cb) {
      cb(new Error('HTTP_CLOSE_FAILURE'));
    },
  };
  const fakeCleanup = {
    stop: async () => {
      cleanupCalled = true;
    },
  };
  const fakePool = {
    end: async () => {
      poolEnded = true;
    },
  };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, fakeCleanup, fakePool),
    /HTTP_CLOSE_FAILURE/
  );
  assert.equal(cleanupCalled, true, 'Cleanup must still be drained when HTTP server close fails');
  assert.equal(poolEnded, true, 'Database pool must still be closed when HTTP server close fails');
});

test('closeServerGracefully: cleanup shutdown failure still closes database pool and preserves cleanup error', async () => {
  let serverClosed = false;
  let poolEnded = false;
  const fakeServer = {
    close(cb) {
      serverClosed = true;
      cb();
    },
  };
  const fakeCleanup = {
    stop: async () => {
      throw new Error('CLEANUP_DRAIN_FAILURE');
    },
  };
  const fakePool = {
    end: async () => {
      poolEnded = true;
    },
  };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, fakeCleanup, fakePool),
    /CLEANUP_DRAIN_FAILURE/
  );
  assert.equal(serverClosed, true, 'HTTP server must be closed');
  assert.equal(poolEnded, true, 'Database pool must still be closed when cleanup shutdown fails');
});

test('closeServerGracefully: cleanup and pool both failing preserves original cleanup error', async () => {
  const fakeServer = {
    close(cb) {
      cb();
    },
  };
  const fakeCleanup = {
    stop: async () => {
      throw new Error('PRIMARY_CLEANUP_ERROR');
    },
  };
  const fakePool = {
    end: async () => {
      throw new Error('SECONDARY_POOL_ERROR');
    },
  };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, fakeCleanup, fakePool),
    (err) => {
      assert.equal(err.message, 'PRIMARY_CLEANUP_ERROR', 'Original cleanup error must be preserved');
      return true;
    }
  );
});

test('closeServerGracefully: repeated shutdown calls are idempotent', async () => {
  let serverCloseCount = 0;
  let cleanupStopCount = 0;
  let poolEndCount = 0;

  const fakeServer = {
    close(cb) {
      serverCloseCount += 1;
      cb();
    },
  };
  const fakeCleanup = {
    stop: async () => {
      cleanupStopCount += 1;
    },
  };
  const fakePool = {
    end: async () => {
      poolEndCount += 1;
    },
  };

  // First sequential shutdown
  await closeServerGracefully(fakeServer, fakeCleanup, fakePool);
  assert.equal(serverCloseCount, 1);
  assert.equal(cleanupStopCount, 1);
  assert.equal(poolEndCount, 1);

  // Second sequential shutdown (must be a no-op)
  await closeServerGracefully(fakeServer, fakeCleanup, fakePool);
  assert.equal(serverCloseCount, 1, 'server.close must not be called again');
  assert.equal(cleanupStopCount, 1, 'cleanup.stop must not be called again');
  assert.equal(poolEndCount, 1, 'pool.end must not be called again');

  // Concurrent shutdown calls on a new instance
  let sCount2 = 0;
  let cCount2 = 0;
  let pCount2 = 0;
  const server2 = { close: (cb) => { sCount2 += 1; cb(); } };
  const cleanup2 = { stop: async () => { cCount2 += 1; } };
  const pool2 = { end: async () => { pCount2 += 1; } };

  await Promise.all([
    closeServerGracefully(server2, cleanup2, pool2),
    closeServerGracefully(server2, cleanup2, pool2),
  ]);
  assert.equal(sCount2, 1);
  assert.equal(cCount2, 1);
  assert.equal(pCount2, 1);
});

test('closeServerGracefully: HTTP closure timeout terminates connections and rejects with ETIMEDOUT', async () => {
  let idleClosed = false;
  let allClosed = false;
  let poolEnded = false;

  const fakeServer = {
    close(cb) {
      // Intentionally hangs and does not invoke cb
    },
    closeIdleConnections() {
      idleClosed = true;
    },
    closeAllConnections() {
      allClosed = true;
    },
  };
  const fakeCleanup = {
    stop: async () => {},
  };
  const fakePool = {
    end: async () => {
      poolEnded = true;
    },
  };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, fakeCleanup, fakePool, {
      timeoutMs: 50,
      httpGraceMs: 15,
      httpTimeoutMs: 30,
      cleanupTimeoutMs: 20,
    }),
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      assert.match(err.message, /HTTP server closure timed out/);
      return true;
    }
  );

  assert.equal(idleClosed, true, 'closeIdleConnections must be called after grace period');
  assert.equal(allClosed, true, 'closeAllConnections must be called on timeout');
  assert.equal(poolEnded, true, 'pool.end must still be attempted despite HTTP timeout');
});

test('closeServerGracefully: cleanup operation timeout triggers hard-stop callback and skips pool closure', async () => {
  let serverClosed = false;
  let forceExitCalled = false;
  let forceExitCode = null;
  let poolEnded = false;

  const fakeServer = {
    close(cb) {
      serverClosed = true;
      cb();
    },
  };
  const fakeCleanup = {
    isRunning: true,
    stop: () => new Promise(() => {}), // hangs indefinitely
  };
  const fakePool = {
    end: async () => {
      poolEnded = true;
    },
  };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, fakeCleanup, fakePool, {
      timeoutMs: 50,
      httpGraceMs: 10,
      cleanupTimeoutMs: 25,
      onForceExit: (code, err) => {
        forceExitCalled = true;
        forceExitCode = code;
      },
    }),
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      assert.match(err.message, /Cleanup shutdown timed out/);
      return true;
    }
  );

  assert.equal(serverClosed, true, 'HTTP server must close before cleanup');
  assert.equal(forceExitCalled, true, 'onForceExit must be invoked when cleanup times out');
  assert.equal(forceExitCode, 1, 'onForceExit exit code must be 1');
  assert.equal(poolEnded, false, 'pool.end must NOT be called while cleanup query is still pending');
});

test('closeServerGracefully: cleanup completing within deadline completes normally and closes pool', async () => {
  let serverClosed = false;
  let cleanupStopped = false;
  let poolEnded = false;
  let forceExitCalled = false;

  const fakeServer = {
    close(cb) {
      serverClosed = true;
      cb();
    },
  };
  const fakeCleanup = {
    isRunning: false,
    stop: async () => {
      cleanupStopped = true;
    },
  };
  const fakePool = {
    end: async () => {
      poolEnded = true;
    },
  };

  await closeServerGracefully(fakeServer, fakeCleanup, fakePool, {
    timeoutMs: 100,
    httpGraceMs: 30,
    cleanupTimeoutMs: 50,
    onForceExit: () => {
      forceExitCalled = true;
    },
  });

  assert.equal(serverClosed, true);
  assert.equal(cleanupStopped, true);
  assert.equal(poolEnded, true, 'pool.end must be safely closed when cleanup completes within deadline');
  assert.equal(forceExitCalled, false, 'onForceExit must not be invoked on successful shutdown');
});

test('closeServerGracefully: pool closure does not race with actively executing cleanup queries', async () => {
  let serverClosed = false;
  let poolEndCalled = false;

  const fakeServer = {
    close(cb) {
      serverClosed = true;
      cb();
    },
  };
  const fakeCleanup = {
    isRunning: true,
    stop: async () => {},
  };
  const fakePool = {
    end: async () => {
      poolEndCalled = true;
    },
  };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, fakeCleanup, fakePool),
    (err) => {
      assert.equal(err.code, 'ECLEANUPBUSY');
      assert.match(err.message, /cleanup queries are still active/);
      return true;
    }
  );

  assert.equal(serverClosed, true);
  assert.equal(poolEndCalled, false, 'pool.end must NOT be called when cleanup is running queries');
});

test('closeServerGracefully: HTTP request drain never completes, skips pool closure and triggers hard-stop callback', async () => {
  let serverClosed = false;
  let poolEndCalled = false;
  let forceExitCalled = false;
  let forceExitCode = null;

  const fakeServer = {
    close(cb) {
      serverClosed = true;
      cb();
    },
    // Handler is still active and never finishes
    getActiveRequests: () => 1,
    closeAllConnections() {},
  };
  const fakeCleanup = {
    isRunning: false,
    stop: async () => {},
  };
  const fakePool = {
    end: async () => {
      poolEndCalled = true;
    },
  };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, fakeCleanup, fakePool, {
      timeoutMs: 40,
      httpGraceMs: 10,
      httpTimeoutMs: 20,
      onForceExit: (code) => {
        forceExitCalled = true;
        forceExitCode = code;
      },
    }),
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      return true;
    }
  );

  assert.equal(serverClosed, true);
  assert.equal(poolEndCalled, false, 'pool.end must NOT be called while HTTP request handlers are still active');
  assert.equal(forceExitCalled, true, 'onForceExit must be invoked when HTTP request drain fails');
  assert.equal(forceExitCode, 1);
});

test('closeServerGracefully: pool.end() never completes, bounded by remaining overall deadline', async () => {
  let serverClosed = false;
  let cleanupStopped = false;
  let forceExitCalled = false;
  let forceExitCode = null;

  const fakeServer = {
    close(cb) {
      serverClosed = true;
      cb();
    },
    getActiveRequests: () => 0,
  };
  const fakeCleanup = {
    isRunning: false,
    stop: async () => {
      cleanupStopped = true;
    },
  };
  const fakePool = {
    end: () => new Promise(() => {}), // hangs indefinitely
  };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, fakeCleanup, fakePool, {
      timeoutMs: 40,
      httpGraceMs: 10,
      httpTimeoutMs: 15,
      cleanupTimeoutMs: 10,
      onForceExit: (code) => {
        forceExitCalled = true;
        forceExitCode = code;
      },
    }),
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      assert.match(err.message, /Database pool closure timed out/);
      return true;
    }
  );

  assert.equal(serverClosed, true);
  assert.equal(cleanupStopped, true);
  assert.equal(forceExitCalled, true, 'onForceExit must be invoked when pool.end times out');
  assert.equal(forceExitCode, 1);
});

test('closeServerGracefully: overall deadline is respected across all stages', async () => {
  const start = Date.now();
  const fakeServer = {
    close(cb) {
      // hangs for 100ms if not bounded
    },
    getActiveRequests: () => 0,
    closeAllConnections() {},
  };
  const fakeCleanup = {
    isRunning: false,
    stop: () => new Promise(() => {}), // hangs if not bounded
  };
  const fakePool = {
    end: () => new Promise(() => {}), // hangs if not bounded
  };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, fakeCleanup, fakePool, {
      timeoutMs: 50,
      httpGraceMs: 15,
      httpTimeoutMs: 30,
      cleanupTimeoutMs: 20,
    }),
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      return true;
    }
  );

  const duration = Date.now() - start;
  assert.ok(duration < 150, `Overall shutdown must be bounded by the overall deadline (elapsed: ${duration}ms)`);
});

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

test('startServer graceful shutdown closes HTTP listener and drains its cleanup task', async () => {
  const pool = createControllableMockPool();
  let poolEnded = false;
  pool.end = async () => { poolEnded = true; };
  const server = await startServer({
    env: { ...validTestEnv, PORT: '0' },
    pool,
    store: new session.MemoryStore(),
    logger: { log() {}, error() {} },
  });
  assert.equal(typeof server.shutdown, 'function');
  await server.shutdown();
  assert.equal(server.address(), null, 'HTTP listener is closed when shutdown resolves');
  assert.equal(poolEnded, true, 'Database pool closes after cleanup has drained');
  await server.shutdown();
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

test('Importing migrate.js does not load .env into process.env', async () => {
  const code = `
    import fs from 'node:fs';
    import path from 'node:path';
    const initialKeys = new Set(Object.keys(process.env));
    const migrateModule = await import('../src/migrate.js');
    const { applyMigrations, verifyVisitorSessionsSchema, runMigrations } = migrateModule;
    if (typeof applyMigrations !== 'function' || typeof verifyVisitorSessionsSchema !== 'function' || typeof runMigrations !== 'function') {
      console.error('FAIL: Expected migration functions not exported properly');
      process.exit(2);
    }
    const newKeys = Object.keys(process.env).filter((k) => !initialKeys.has(k));
    const sensitiveKeys = ['DB_PASSWORD', 'SESSION_SECRET', 'APP_SESSION_SECRET', 'MIGRATION_DB_PASSWORD', 'DB_HOST', 'DB_USER', 'DB_NAME'];
    for (const key of sensitiveKeys) {
      if (newKeys.includes(key) || (process.env[key] !== undefined && !initialKeys.has(key))) {
        console.error('FAIL: Sensitive env var found in process.env after import:', key);
        process.exit(1);
      }
    }
    // Also check if .env file exists in the directory and ensure none of its keys were loaded
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const varName = trimmed.split('=')[0].trim();
          if (varName && !initialKeys.has(varName) && process.env[varName] !== undefined) {
            console.error('FAIL: .env variable was loaded on import:', varName);
            process.exit(1);
          }
        }
      }
    }
    process.exit(0);
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', code],
    {
      cwd: path.dirname(serverEntry),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
      },
    }
  );

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
  });

  assert.equal(exitCode, 0, `Importing migrate.js must not load .env (stderr: ${stderr})`);
});

function createMigrationFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parkx-mig-fixture-'));
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // Symlink node_modules and copy package.json so ESM bare specifiers like 'mysql2' resolve
  const serverDir = path.resolve(__dirname, '../');
  try {
    fs.symlinkSync(path.join(serverDir, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  } catch {}
  try {
    fs.copyFileSync(path.join(serverDir, 'package.json'), path.join(tmpDir, 'package.json'));
  } catch {}

  // Write temporary isolated fixture .env with sentinel and test inspect variable
  const fixtureEnvPath = path.join(tmpDir, '.env');
  fs.writeFileSync(
    fixtureEnvPath,
    'MIGRATION_ENV_SENTINEL=fixture_secret_token_12345\nTEST_INSPECT_VAR=from_dotenv_fixture\n'
  );

  // Copy migrate.js into src/migrate.js so resolveMigrationEnvPath resolves this fixture's .env
  const realMigratePath = path.resolve(__dirname, '../src/migrate.js');
  fs.copyFileSync(realMigratePath, path.join(srcDir, 'migrate.js'));

  return {
    tmpDir,
    srcDir,
    scriptPath: path.join(srcDir, 'migrate.js'),
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    },
  };
}

test('Migration CLI resolves module-relative .env when invoked from repository root', async () => {
  const fixture = createMigrationFixture();
  try {
    const repoRoot = path.resolve(__dirname, '../../');
    const child = spawn(
      process.execPath,
      [fixture.scriptPath, '--inspect-env'],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
        },
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
    });

    assert.equal(exitCode, 0, `CLI execution from repository root must succeed (stderr: ${stderr})`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.sentinelLoaded, true, 'Sentinel from intended module-relative .env must be loaded');
    assert.equal(parsed.sentinelKey, 'MIGRATION_ENV_SENTINEL');
    // Ensure sentinel value and passwords are NEVER exposed in stdout
    assert.ok(!stdout.includes('fixture_secret_token_12345'), 'Sentinel value must NEVER be printed in output');
    assert.ok(!stdout.includes('password'), 'Passwords must NEVER be printed in output');
  } finally {
    fixture.cleanup();
  }
});

test('Migration CLI resolves module-relative .env when invoked from server directory', async () => {
  const fixture = createMigrationFixture();
  try {
    const child = spawn(
      process.execPath,
      ['migrate.js', '--inspect-env'],
      {
        cwd: fixture.srcDir,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
        },
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
    });

    assert.equal(exitCode, 0, `CLI execution from server directory must succeed (stderr: ${stderr})`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.sentinelLoaded, true, 'Sentinel from intended module-relative .env must be loaded');
    assert.ok(!stdout.includes('fixture_secret_token_12345'), 'Sentinel value must NEVER be printed in output');
    assert.ok(!stdout.includes('password'), 'Passwords must NEVER be printed in output');
  } finally {
    fixture.cleanup();
  }
});

test('Migration CLI preserves existing process environment values (precedence)', async () => {
  const fixture = createMigrationFixture();
  try {
    const repoRoot = path.resolve(__dirname, '../../');
    const child = spawn(
      process.execPath,
      [fixture.scriptPath, '--inspect-env'],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          TEST_INSPECT_VAR: 'precedence_value_from_process',
        },
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
    });

    assert.equal(exitCode, 0, `CLI execution must succeed (stderr: ${stderr})`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.sentinelLoaded, true, 'Sentinel must be loaded');
    assert.equal(parsed.testInspectVarMatches, true, 'Existing process.env values must take precedence over .env file');
    assert.ok(!stdout.includes('fixture_secret_token_12345'), 'Sentinel value must NEVER be printed in output');
    assert.ok(!stdout.includes('password'), 'Passwords must NEVER be printed in output');
  } finally {
    fixture.cleanup();
  }
});

test('Test A — Response sent before handler completes: work remains active and prevents pool.end until handler settles', async () => {
  let poolEnded = false;
  const fakePool = {
    async query() { return [[]]; },
    async end() { poolEnded = true; },
  };
  const store = new session.MemoryStore();
  const app = createApp({ env: validTestEnv, pool: fakePool, store });

  let finishHandler;
  const handlerGate = new Promise((resolve) => { finishHandler = resolve; });

  app.get('/test-handler-after-response', wrapAsyncHandler(async (req, res) => {
    res.json({ status: 'sent_early' });
    await handlerGate;
  }));

  const server = app.listen(0);
  const port = server.address().port;

  try {
    // 1. Client sends request and receives full HTTP response
    const res = await fetch(`http://127.0.0.1:${port}/test-handler-after-response`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'sent_early');

    // 2. Response was sent and completed, but handler is still awaiting handlerGate!
    assert.equal(server.getActiveWork(), 1, 'Active work must remain nonzero after response is sent while handler runs');
    assert.equal(server.getActiveHandlerWork(), 1, 'Handler work must be 1 while promise is in-flight');

    // 3. Start shutdown while handler is still in-flight
    let shutdownSettled = false;
    const shutdownPromise = closeServerGracefully(server, null, fakePool).then(() => {
      shutdownSettled = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    // 4. Verify pool.end() is NOT called and shutdown cannot finish
    assert.equal(shutdownSettled, false, 'Shutdown cannot complete while handler promise is pending');
    assert.equal(poolEnded, false, 'pool.end() must NOT be called while handler promise is pending');
    assert.equal(server.getActiveWork(), 1);

    // 5. Resolve handlerGate
    finishHandler();
    await shutdownPromise;

    // 6. Work drains and pool is closed
    assert.equal(server.getActiveWork(), 0, 'Active work must drain to zero');
    assert.equal(poolEnded, true, 'pool.end() must be called after handler settles');
    assert.equal(shutdownSettled, true);
  } finally {
    if (typeof finishHandler === 'function') finishHandler();
    try { server.close(); } catch {}
  }
});

test('Test B — Client disconnect after response: keeps work tracked until handler promise settles', async () => {
  let poolEnded = false;
  const fakePool = {
    async query() { return [[]]; },
    async end() { poolEnded = true; },
  };
  const store = new session.MemoryStore();
  const app = createApp({ env: validTestEnv, pool: fakePool, store });

  let finishHandler;
  const handlerGate = new Promise((resolve) => { finishHandler = resolve; });

  app.get('/test-disconnect-after-response', wrapAsyncHandler(async (req, res) => {
    res.write('HTTP response body chunk');
    res.end();
    await handlerGate;
  }));

  const server = app.listen(0);
  const port = server.address().port;

  try {
    let clientSocket;
    await new Promise((resolve) => {
      clientSocket = net.connect(port, '127.0.0.1', () => {
        clientSocket.write('GET /test-disconnect-after-response HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      });
      clientSocket.on('data', (chunk) => {
        if (chunk.toString().includes('HTTP response body chunk')) {
          // Response received; now disconnect client socket
          clientSocket.destroy();
          resolve();
        }
      });
    });

    // Wait ticks for socket close event
    await new Promise((r) => setTimeout(r, 20));

    // Verify work remains tracked despite client socket disconnect
    assert.equal(server.getActiveWork(), 1, 'Work must remain tracked after disconnect while handler promise is active');

    // Resolving handler promise releases work
    finishHandler();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(server.getActiveWork(), 0, 'Work must reach zero after handler promise settles');
  } finally {
    if (typeof finishHandler === 'function') finishHandler();
    try { server.close(); } catch {}
  }
});

test('Test C — Rejected handler promise: decrements tracker exactly once without unhandled rejection and reaches error handler', async () => {
  const unhandledRejections = [];
  const onUnhandled = (err) => { unhandledRejections.push(err); };
  process.on('unhandledRejection', onUnhandled);

  let errorReceived = null;
  const fakePool = {
    async query() { return [[]]; },
    async end() {},
  };
  const store = new session.MemoryStore();
  const app = createApp({ env: validTestEnv, pool: fakePool, store });

  let finishDelay;
  const delayGate = new Promise((resolve) => { finishDelay = resolve; });

  app.get('/test-reject-after-response', wrapAsyncHandler(async (req, res) => {
    res.json({ status: 'sent_before_error' });
    await delayGate;
    throw new Error('post_response_async_failure');
  }));

  // Custom error handler to verify Express error handling receives it
  app.use((err, req, res, next) => {
    errorReceived = err;
    if (res.headersSent) {
      return next(err);
    }
    res.status(500).json({ error: err.message });
  });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    // 1. Send request and receive response
    const res = await fetch(`http://127.0.0.1:${port}/test-reject-after-response`);
    assert.equal(res.status, 200);
    assert.equal(server.getActiveWork(), 1, 'Tracker must be 1 while post-response async work is active');

    // 2. Trigger the rejection
    finishDelay();
    await new Promise((r) => setTimeout(r, 30));

    // 3. Verify tracker decremented exactly once
    assert.equal(server.getActiveWork(), 0, 'Tracker must decrement to 0 after rejection');

    // 4. Verify Express error handling received the error
    assert.ok(errorReceived, 'Express error handler must receive the rejection');
    assert.equal(errorReceived.message, 'post_response_async_failure');

    // 5. Verify no unhandledRejection event was fired on process
    assert.equal(unhandledRejections.length, 0, 'Must not produce unhandled promise rejections');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    if (typeof finishDelay === 'function') finishDelay();
    try { server.close(); } catch {}
  }
});

test('Test D — Database operation outlives response: database tracker prevents pool closure until operation completes', async () => {
  let poolEnded = false;
  let finishDbQuery;
  const dbGate = new Promise((resolve) => { finishDbQuery = resolve; });

  const rawPool = {
    async query(sql) {
      if (typeof sql === 'string' && sql.includes('SELECT 1')) return [[]];
      return dbGate;
    },
    async end() {
      poolEnded = true;
    },
  };

  const store = new session.MemoryStore();
  const app = createApp({ env: validTestEnv, pool: rawPool, store });

  app.get('/test-db-outlives-response', wrapAsyncHandler(async (req, res) => {
    // Start controllable DB operation on actual instrumented pool without awaiting it
    app.pool.query('SELECT outlive_query');
    // Send response immediately
    res.json({ message: 'response_sent_early' });
  }));

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/test-db-outlives-response`);
    assert.equal(res.status, 200);

    // Response has finished, handler returned, but DB operation is still pending in dbTracker!
    assert.equal(server.getActiveDatabaseWork(), 1, 'Database work must be active');
    assert.equal(server.getActiveWork(), 1, 'Total active work must be 1');

    // Start shutdown
    let shutdownSettled = false;
    const shutdownPromise = closeServerGracefully(server, null, rawPool).then(() => {
      shutdownSettled = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(shutdownSettled, false, 'Shutdown cannot complete while DB operation is pending');
    assert.equal(poolEnded, false, 'pool.end() must NOT be called while DB operation is pending');

    // Finish the DB query
    finishDbQuery([[]]);
    await shutdownPromise;

    assert.equal(server.getActiveDatabaseWork(), 0);
    assert.equal(server.getActiveWork(), 0);
    assert.equal(poolEnded, true, 'pool.end() must be called after DB operation completes');
    assert.equal(shutdownSettled, true);
  } finally {
    if (typeof finishDbQuery === 'function') finishDbQuery([[]]);
    try { server.close(); } catch {}
  }
});

test('Test E — Untracked fire-and-forget work: independently tracked by database tracker to prevent observing zero', async () => {
  let poolEnded = false;
  let finishFireAndForget;
  const dbGate = new Promise((resolve) => { finishFireAndForget = resolve; });

  const rawPool = {
    async query(sql) {
      if (typeof sql === 'string' && sql.includes('SELECT 1')) return [[]];
      return dbGate;
    },
    async end() {
      poolEnded = true;
    },
  };

  const store = new session.MemoryStore();
  const app = createApp({ env: validTestEnv, pool: rawPool, store });

  app.get('/test-fire-and-forget', (req, res) => {
    // Starts actual instrumented pool query WITHOUT awaiting it and WITHOUT returning a promise
    app.pool.query('SELECT fire_and_forget');
    res.json({ fired: true });
  });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/test-fire-and-forget`);
    assert.equal(res.status, 200);

    // Handler has returned, response ended, but independent DB tracker prevents observing zero
    assert.equal(server.getActiveDatabaseWork(), 1, 'Database tracker must track fire-and-forget operation');
    assert.equal(server.getActiveWork(), 1, 'Shutdown must NOT observe zero while fire-and-forget query is active');

    // Attempting shutdown cannot close pool while DB query is active
    let shutdownSettled = false;
    const shutdownPromise = closeServerGracefully(server, null, rawPool).then(() => {
      shutdownSettled = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(shutdownSettled, false);
    assert.equal(poolEnded, false, 'pool.end() must NOT be called while fire-and-forget DB work is active');

    // Complete the fire-and-forget operation
    finishFireAndForget([[]]);
    await shutdownPromise;

    assert.equal(server.getActiveDatabaseWork(), 0);
    assert.equal(server.getActiveWork(), 0);
    assert.equal(poolEnded, true);
    assert.equal(shutdownSettled, true);
  } finally {
    if (typeof finishFireAndForget === 'function') finishFireAndForget([[]]);
    try { server.close(); } catch {}
  }
});

test('Admission guard: rejects requests with 503 and starts no database work once shutdown begins', async () => {
  let dbQueriesExecuted = 0;
  const fakePool = {
    async query() {
      dbQueriesExecuted++;
      return [[]];
    },
    async end() {},
  };
  const store = new session.MemoryStore();

  const app = createApp({ env: validTestEnv, pool: fakePool, store });

  app.get('/test-db-work', wrapAsyncHandler(async (req, res) => {
    await fakePool.query('SELECT 1');
    res.json({ ok: true });
  }));

  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Before shutdown: normal request succeeds and runs DB query
    const resBefore = await fetch(`http://127.0.0.1:${port}/test-db-work`);
    assert.equal(resBefore.status, 200);
    assert.equal(dbQueriesExecuted, 1, 'Before shutdown, DB query runs');

    // Begin shutdown (sets shuttingDown = true on app and server)
    server.setShuttingDown(true);

    // After shutdown begins: new request must be rejected with 503 without starting DB work
    const resAfter = await fetch(`http://127.0.0.1:${port}/test-db-work`);
    assert.equal(resAfter.status, 503, 'Admission guard must return 503 Service Unavailable');
    assert.equal(resAfter.headers.get('connection'), 'close', 'Connection header must be close');
    const data = await resAfter.json();
    assert.equal(data.error, 'SERVER_SHUTTING_DOWN');
    assert.equal(data.message, 'Server is shutting down');

    // Also verify built-in /api/health is rejected by admission guard without executing database queries
    const resHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(resHealth.status, 503);
    assert.equal(resHealth.headers.get('connection'), 'close');
    const healthData = await resHealth.json();
    assert.equal(healthData.error, 'SERVER_SHUTTING_DOWN');

    // Assert: DB queries must NOT have increased!
    assert.equal(dbQueriesExecuted, 1, 'Admission guard must NOT admit new database work');
  } finally {
    try { server.close(); } catch {}
  }
});

test('Migration verifier: rejects foreign key with wrong constraint name', async () => {
  const standardColumns = [
    { COLUMN_NAME: 'id', DATA_TYPE: 'bigint', COLUMN_TYPE: 'bigint unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: 'auto_increment', COLLATION_NAME: null },
    { COLUMN_NAME: 'public_id', DATA_TYPE: 'varchar', COLUMN_TYPE: 'varchar(64)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', COLLATION_NAME: 'utf8mb4_unicode_ci' },
    { COLUMN_NAME: 'vehicle_id', DATA_TYPE: 'int', COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', COLLATION_NAME: null },
    { COLUMN_NAME: 'credential_hash', DATA_TYPE: 'varchar', COLUMN_TYPE: 'varchar(64)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', COLLATION_NAME: 'utf8mb4_unicode_ci' },
    { COLUMN_NAME: 'status', DATA_TYPE: 'enum', COLUMN_TYPE: "enum('pending','accepted','closed','expired')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'pending', EXTRA: '', COLLATION_NAME: 'utf8mb4_unicode_ci' },
    { COLUMN_NAME: 'created_at', DATA_TYPE: 'timestamp', COLUMN_TYPE: 'timestamp', IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'CURRENT_TIMESTAMP', EXTRA: 'DEFAULT_GENERATED', COLLATION_NAME: null },
    { COLUMN_NAME: 'expires_at', DATA_TYPE: 'timestamp', COLUMN_TYPE: 'timestamp', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', COLLATION_NAME: null },
    { COLUMN_NAME: 'accepted_at', DATA_TYPE: 'timestamp', COLUMN_TYPE: 'timestamp', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, EXTRA: '', COLLATION_NAME: null },
    { COLUMN_NAME: 'closed_at', DATA_TYPE: 'timestamp', COLUMN_TYPE: 'timestamp', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, EXTRA: '', COLLATION_NAME: null },
  ];

  const standardIndexes = [
    { INDEX_NAME: 'PRIMARY', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1, NON_UNIQUE: 0, SUB_PART: null, IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE', COLLATION: 'A' },
    { INDEX_NAME: 'uq_visitor_sessions_public_id', COLUMN_NAME: 'public_id', SEQ_IN_INDEX: 1, NON_UNIQUE: 0, SUB_PART: null, IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE', COLLATION: 'A' },
    { INDEX_NAME: 'idx_visitor_sessions_vehicle_status', COLUMN_NAME: 'vehicle_id', SEQ_IN_INDEX: 1, NON_UNIQUE: 1, SUB_PART: null, IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE', COLLATION: 'A' },
    { INDEX_NAME: 'idx_visitor_sessions_vehicle_status', COLUMN_NAME: 'status', SEQ_IN_INDEX: 2, NON_UNIQUE: 1, SUB_PART: null, IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE', COLLATION: 'A' },
    { INDEX_NAME: 'idx_visitor_sessions_vehicle_status', COLUMN_NAME: 'created_at', SEQ_IN_INDEX: 3, NON_UNIQUE: 1, SUB_PART: null, IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE', COLLATION: 'A' },
    { INDEX_NAME: 'idx_visitor_sessions_credential_hash', COLUMN_NAME: 'credential_hash', SEQ_IN_INDEX: 1, NON_UNIQUE: 1, SUB_PART: null, IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE', COLLATION: 'A' },
    { INDEX_NAME: 'idx_visitor_sessions_expires_status', COLUMN_NAME: 'expires_at', SEQ_IN_INDEX: 1, NON_UNIQUE: 1, SUB_PART: null, IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE', COLLATION: 'A' },
    { INDEX_NAME: 'idx_visitor_sessions_expires_status', COLUMN_NAME: 'status', SEQ_IN_INDEX: 2, NON_UNIQUE: 1, SUB_PART: null, IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE', COLLATION: 'A' },
    { INDEX_NAME: 'idx_visitor_sessions_closed_status', COLUMN_NAME: 'closed_at', SEQ_IN_INDEX: 1, NON_UNIQUE: 1, SUB_PART: null, IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE', COLLATION: 'A' },
    { INDEX_NAME: 'idx_visitor_sessions_closed_status', COLUMN_NAME: 'status', SEQ_IN_INDEX: 2, NON_UNIQUE: 1, SUB_PART: null, IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE', COLLATION: 'A' },
  ];

  const standardCreateTable = `CREATE TABLE \`visitor_sessions\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`public_id\` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  \`vehicle_id\` int unsigned NOT NULL,
  \`credential_hash\` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  \`status\` enum('pending','accepted','closed','expired') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`expires_at\` timestamp NOT NULL,
  \`accepted_at\` timestamp NULL DEFAULT NULL,
  \`closed_at\` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_visitor_sessions_public_id\` (\`public_id\`),
  KEY \`idx_visitor_sessions_vehicle_status\` (\`vehicle_id\`,\`status\`,\`created_at\`),
  KEY \`idx_visitor_sessions_credential_hash\` (\`credential_hash\`),
  KEY \`idx_visitor_sessions_expires_status\` (\`expires_at\`,\`status\`),
  KEY \`idx_visitor_sessions_closed_status\` (\`closed_at\`,\`status\`),
  CONSTRAINT \`fk_visitor_sessions_vehicle_id\` FOREIGN KEY (\`vehicle_id\`) REFERENCES \`vehicles\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

  const makeMockConn = (fkConstraintName) => ({
    async query(sql) {
      if (sql.includes('information_schema.TABLES')) {
        return [[{ TABLE_NAME: 'visitor_sessions', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_unicode_ci' }]];
      }
      if (sql.includes('SHOW CREATE TABLE')) {
        return [[{ 'Create Table': standardCreateTable }]];
      }
      if (sql.includes('FROM information_schema.COLUMNS')) {
        return [standardColumns];
      }
      if (sql.includes('FROM information_schema.STATISTICS')) {
        return [standardIndexes];
      }
      if (sql.includes('SELECT DATABASE()')) {
        return [[{ schemaName: 'parkx_test_db' }]];
      }
      if (sql.includes('information_schema.TABLE_CONSTRAINTS')) {
        return [[{
          CONSTRAINT_NAME: fkConstraintName,
          COLUMN_NAME: 'vehicle_id',
          ORDINAL_POSITION: 1,
          REFERENCED_TABLE_SCHEMA: 'parkx_test_db',
          REFERENCED_TABLE_NAME: 'vehicles',
          REFERENCED_COLUMN_NAME: 'id',
          DELETE_RULE: 'CASCADE',
          UPDATE_RULE: 'NO ACTION',
        }]];
      }
      return [[]];
    },
  });

  // 1. Wrong foreign key name must be rejected
  await assert.rejects(
    () => verifyVisitorSessionsSchema(makeMockConn('fk_visitor_sessions_vehicle_wrong_name')),
    /foreign key must be named fk_visitor_sessions_vehicle_id/
  );

  // 2. Exact foreign key name fk_visitor_sessions_vehicle_id must pass
  await assert.doesNotReject(
    () => verifyVisitorSessionsSchema(makeMockConn('fk_visitor_sessions_vehicle_id'))
  );
});

test('Session-store expiration timer: shutdown invokes store.close(), stops timer, and handles repeated calls safely', async () => {
  let closeCallCount = 0;
  let intervalCleared = false;
  const intervalHandle = setInterval(() => {}, 60000);

  const fakeStore = {
    _expirationInterval: intervalHandle,
    clearExpirationInterval() {
      intervalCleared = true;
      if (this._expirationInterval) {
        clearInterval(this._expirationInterval);
        this._expirationInterval = null;
      }
    },
    async close() {
      closeCallCount += 1;
      this.clearExpirationInterval();
    },
  };

  const fakeServer = { close: (cb) => cb() };
  const fakePool = { end: async () => {} };

  // First graceful shutdown
  await closeServerGracefully(fakeServer, null, fakePool, { sessionStore: fakeStore });
  assert.equal(closeCallCount, 1, 'store.close() must be called during shutdown');
  assert.equal(intervalCleared, true, 'Expiration interval must be cleared');
  assert.equal(fakeStore._expirationInterval, null, 'Interval handle must be null');

  // Repeated graceful shutdown
  await closeServerGracefully(fakeServer, null, fakePool, { sessionStore: fakeStore });
  assert.equal(closeCallCount, 1, 'Repeated shutdown must not re-invoke store.close()');
});

test('Database admission seal: rejects new pool queries and connection checkouts after seal, while allowing in-flight operations to complete', async () => {
  const dbTracker = new DatabaseTracker();
  let rawQueryCallCount = 0;
  let rawConnCheckoutCount = 0;

  const rawPool = {
    query: async () => {
      rawQueryCallCount += 1;
      return [{ ok: 1 }];
    },
    execute: async () => {
      rawQueryCallCount += 1;
      return [{ ok: 1 }];
    },
    getConnection: async () => {
      rawConnCheckoutCount += 1;
      return {
        query: async () => [{ ok: 1 }],
        execute: async () => [{ ok: 1 }],
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        destroy: () => {},
      };
    },
    end: async () => {},
  };

  const instrumented = instrumentPool(rawPool, dbTracker);

  // Before seal: operations succeed
  assert.equal(dbTracker.isSealed(), false);
  const beforeRes = await instrumented.query('SELECT 1');
  assert.deepEqual(beforeRes, [{ ok: 1 }]);

  // In-flight query started before seal
  let resolveInFlight;
  const inFlightPromise = new Promise((resolve) => {
    resolveInFlight = resolve;
  });
  rawPool.query = () => inFlightPromise;

  const pendingOp = instrumented.query('SELECT in_flight');
  assert.equal(dbTracker.getActiveCount(), 1, 'In-flight operation is tracked');

  // Seal database
  dbTracker.seal();
  assert.equal(dbTracker.isSealed(), true);

  // Attempting new operations after seal must reject immediately with EDB_SEALED
  await assert.rejects(
    () => instrumented.query('SELECT after_seal'),
    (err) => {
      assert.equal(err.code, 'EDB_SEALED');
      assert.match(err.message, /Database is sealed for shutdown/);
      return true;
    }
  );

  await assert.rejects(
    () => instrumented.execute('INSERT INTO foo VALUES (1)'),
    (err) => {
      assert.equal(err.code, 'EDB_SEALED');
      assert.match(err.message, /Database is sealed for shutdown/);
      return true;
    }
  );

  await assert.rejects(
    () => instrumented.getConnection(),
    (err) => {
      assert.equal(err.code, 'EDB_SEALED');
      assert.match(err.message, /Database is sealed for shutdown/);
      return true;
    }
  );

  // In-flight operation is allowed to complete
  assert.equal(dbTracker.getActiveCount(), 1, 'In-flight operation still tracked');
  resolveInFlight([{ ok: 'done' }]);
  const completedRes = await pendingOp;
  assert.deepEqual(completedRes, [{ ok: 'done' }]);
  assert.equal(dbTracker.getActiveCount(), 0, 'Active count reaches zero after completion');
});

test('End-to-end shutdown sequencing: strict order HTTP stop -> producer stop -> handler drain -> DB seal -> DB drain -> pool.end', async () => {
  const events = [];
  const dbTracker = new DatabaseTracker();

  // Create an in-flight handler work token
  let handlerFinish = true;

  const fakeServer = {
    handlerTracker: {
      getActiveCount() {
        return handlerFinish ? 1 : 0;
      },
    },
    close(cb) {
      events.push('1_HTTP_STOP');
      cb();
    },
  };

  const fakeStore = {
    clearExpirationInterval() {},
    async close() {
      events.push('2_SESSION_STORE_STOP');
    },
  };

  const fakeCleanup = {
    async stop() {
      events.push('2_CLEANUP_STOP');
    },
  };

  const rawPool = {
    dbTracker,
    end: async () => {
      events.push('7_POOL_END');
    },
  };

  // Instrument pool and wrap seal to record event
  const pool = instrumentPool(rawPool, dbTracker);
  const originalSeal = dbTracker.seal.bind(dbTracker);
  dbTracker.seal = () => {
    events.push('4_DB_SEAL');
    originalSeal();
  };

  let shutdownDone = false;
  const shutdownPromise = closeServerGracefully(fakeServer, fakeCleanup, pool, {
    sessionStore: fakeStore,
  }).then(() => {
    shutdownDone = true;
  });

  // Give Phase 1 and Phase 2 time to run
  await new Promise((r) => setTimeout(r, 25));

  // Assert Phase 1 and 2 happened, but Phase 4 and 7 did NOT happen yet (waiting for handler drain)
  assert.ok(events.includes('1_HTTP_STOP'), 'Phase 1 must stop HTTP');
  assert.ok(events.includes('2_SESSION_STORE_STOP'), 'Phase 2 must stop session store');
  assert.ok(events.includes('2_CLEANUP_STOP'), 'Phase 2 must stop cleanup');
  assert.ok(!events.includes('4_DB_SEAL'), 'DB seal must NOT occur while handlers are active');
  assert.ok(!events.includes('7_POOL_END'), 'Pool end must NOT occur while handlers are active');
  assert.equal(shutdownDone, false);

  // Now release handler
  events.push('3_HANDLER_DRAINED');
  handlerFinish = false;

  await shutdownPromise;
  assert.equal(shutdownDone, true);
  assert.ok(events.includes('4_DB_SEAL'), 'DB seal occurs after handlers drain');
  assert.ok(events.includes('7_POOL_END'), 'Pool end occurs after DB seal and drain');

  // Verify the exact relative ordering
  const idxHttp = events.indexOf('1_HTTP_STOP');
  const idxStore = events.indexOf('2_SESSION_STORE_STOP');
  const idxCleanup = events.indexOf('2_CLEANUP_STOP');
  const idxHandlerDrain = events.indexOf('3_HANDLER_DRAINED');
  const idxDbSeal = events.indexOf('4_DB_SEAL');
  const idxPoolEnd = events.indexOf('7_POOL_END');

  assert.ok(idxHttp < idxStore, 'HTTP stop before producer stop');
  assert.ok(idxStore < idxHandlerDrain, 'Session store stop before handler drain completes');
  assert.ok(idxCleanup < idxHandlerDrain, 'Cleanup stop before handler drain completes');
  assert.ok(idxHandlerDrain < idxDbSeal, 'Handler drain completes before DB seal');
  assert.ok(idxDbSeal < idxPoolEnd, 'DB seal occurs before pool.end');
});

test('Instrumented pool: connection released while query is pending maintains tracking and prevents premature pool.end()', async () => {
  let poolEnded = false;
  let finishPendingQuery;
  const queryGate = new Promise((resolve) => { finishPendingQuery = resolve; });
  let underlyingReleaseCalled = false;

  const rawConn = {
    query: async () => queryGate,
    release: () => {
      underlyingReleaseCalled = true;
    },
    destroy: () => {},
  };

  const rawPool = {
    getConnection: async () => rawConn,
    query: async () => [[]],
    end: async () => { poolEnded = true; },
  };

  const dbTracker = new DatabaseTracker();
  const pool = instrumentPool(rawPool, dbTracker);

  // 1. Obtain a connection through instrumentedPool.getConnection()
  const conn = await pool.getConnection();
  assert.equal(dbTracker.getActiveCount(), 1, 'Connection checkout is tracked');

  // 2. Start a pending query through the instrumented connection
  const pendingQueryPromise = conn.query('SELECT 1');
  assert.equal(dbTracker.getActiveCount(), 1, 'Connection + query tracked without double counting');

  // 3. Call release() before query settles
  conn.release();

  // 4. Assert: query remains tracked, and underlying connection is NOT released back to pool yet (safe against reuse)
  assert.equal(dbTracker.getActiveCount(), 1, 'Query remains tracked in dbTracker after release');
  assert.equal(underlyingReleaseCalled, false, 'Physical release is deferred while query is running on wire');

  // 5. Begin graceful shutdown
  const fakeServer = { close: (cb) => cb() };
  let shutdownFinished = false;
  const shutdownPromise = closeServerGracefully(fakeServer, null, pool).then(() => {
    shutdownFinished = true;
  });

  await new Promise((r) => setTimeout(r, 25));
  assert.equal(shutdownFinished, false, 'Shutdown cannot complete while query is pending');
  assert.equal(poolEnded, false, 'pool.end() must not be called while query is pending');

  // 6. Resolve the query
  finishPendingQuery([{ result: 1 }]);
  await pendingQueryPromise;
  await shutdownPromise;

  assert.equal(dbTracker.getActiveCount(), 0, 'Active database count is 0');
  assert.equal(underlyingReleaseCalled, true, 'Deferred release called after query settled');
  assert.equal(poolEnded, true, 'pool.end() called after query settled');
  assert.equal(shutdownFinished, true);
});

test('Instrumented pool: rejected queries and failed connection operations settle tracking counts correctly and propagate errors', async () => {
  const dbTracker = new DatabaseTracker();

  const rawConn = {
    query: async () => {
      throw new Error('CONN_QUERY_ERROR');
    },
    beginTransaction: async () => {
      throw new Error('BEGIN_TRANS_ERROR');
    },
    release: () => {},
    destroy: () => {},
  };

  const rawPool = {
    query: async () => {
      throw new Error('POOL_QUERY_ERROR');
    },
    execute: async () => {
      throw new Error('POOL_EXECUTE_ERROR');
    },
    getConnection: async () => rawConn,
    end: async () => {},
  };

  const pool = instrumentPool(rawPool, dbTracker);

  // 1. Rejected pool query
  await assert.rejects(
    () => pool.query('SELECT fail'),
    /POOL_QUERY_ERROR/
  );
  assert.equal(dbTracker.getActiveCount(), 0, 'Tracker count must be 0 after rejected pool query');

  // 2. Rejected pool execute
  await assert.rejects(
    () => pool.execute('INSERT fail'),
    /POOL_EXECUTE_ERROR/
  );
  assert.equal(dbTracker.getActiveCount(), 0, 'Tracker count must be 0 after rejected pool execute');

  // 3. Rejected connection query
  const conn = await pool.getConnection();
  assert.equal(dbTracker.getActiveCount(), 1, 'Connection checked out');
  await assert.rejects(
    () => conn.query('SELECT fail_conn'),
    /CONN_QUERY_ERROR/
  );
  assert.equal(dbTracker.getActiveCount(), 1, 'Connection still held, query error settled');
  conn.release();
  assert.equal(dbTracker.getActiveCount(), 0, 'Count reaches 0 after release');

  // 4. Failed getConnection acquisition
  const failingPool = instrumentPool({
    getConnection: async () => {
      throw new Error('POOL_EXHAUSTED');
    },
    end: async () => {},
  }, dbTracker);

  await assert.rejects(
    () => failingPool.getConnection(),
    /POOL_EXHAUSTED/
  );
  assert.equal(dbTracker.getActiveCount(), 0, 'Tracker count must be 0 after getConnection failure');
});

test('Real session-store expiration race: already-admitted cleanup query is awaited across shutdown while timer is stopped and DB is sealed', async () => {
  let poolEnded = false;
  let resolveExpirationQuery;
  const expirationQueryPromise = new Promise((resolve) => {
    resolveExpirationQuery = resolve;
  });

  const rawPool = {
    async query(sql) {
      if (typeof sql === 'string' && sql.includes('DELETE FROM')) {
        return expirationQueryPromise;
      }
      return [[]];
    },
    async end() {
      poolEnded = true;
    },
  };

  const dbTracker = new DatabaseTracker();
  const instrumentedPool = instrumentPool(rawPool, dbTracker);

  const MySQLStore = MySQLStoreFactory(session);
  const store = new MySQLStore(
    {
      clearExpired: true,
      checkExpirationInterval: 50,
      createDatabaseTable: false,
      endConnectionOnClose: false,
      schema: {
        tableName: 'sessions',
        columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' },
      },
    },
    instrumentedPool
  );

  // 1. Start an expiration cleanup operation
  // 2. Hold its database query pending
  const cleanupOperationPromise = store.clearExpiredSessions();
  // Allow express-mysql-session's internal Promise.resolve().then() to enter instrumentedPool.query()
  await Promise.resolve();

  // Verify the query is tracked in dbTracker
  assert.equal(dbTracker.getActiveCount(), 1, 'Admitted expiration query must be tracked in dbTracker');

  // 3. Begin graceful shutdown
  const fakeServer = { close: (cb) => cb() };
  let shutdownDone = false;
  const shutdownPromise = closeServerGracefully(fakeServer, null, instrumentedPool, {
    sessionStore: store,
  }).then(() => {
    shutdownDone = true;
  });

  // Give Phase 1, Phase 2, Phase 3, Phase 4 time to execute
  await new Promise((r) => setTimeout(r, 30));

  // 4. Verify the store timer is stopped
  assert.equal(store._expirationInterval, null, 'Store expiration interval timer must be cleared');

  // 5. Verify database admission is eventually sealed in the expected shutdown order
  assert.equal(dbTracker.isSealed(), true, 'Database tracker must be sealed in Phase 4');

  // 6. Verify the already-admitted expiration query remains tracked
  assert.equal(dbTracker.getActiveCount(), 1, 'In-flight expiration query remains tracked');

  // 7. Verify pool.end() is not called while that query is pending
  assert.equal(poolEnded, false, 'pool.end() must NOT be called while expiration query is pending');
  assert.equal(shutdownDone, false, 'Shutdown cannot complete while expiration query is pending');

  // 8. Resolve the query and verify shutdown completes
  resolveExpirationQuery([[]]);
  await cleanupOperationPromise;
  await shutdownPromise;

  assert.equal(dbTracker.getActiveCount(), 0, 'Database tracker reaches zero active operations');
  assert.equal(poolEnded, true, 'pool.end() called after expiration query completes');
  assert.equal(shutdownDone, true, 'Graceful shutdown completes successfully');

  // 9. Verify a later timer tick cannot start another database operation
  await assert.rejects(
    () => store.clearExpiredSessions(),
    (err) => {
      assert.equal(err.code, 'EDB_SEALED');
      assert.match(err.message, /Database is sealed for shutdown/);
      return true;
    }
  );
});

test('Visitor cleanup task integration: instrumented pool tracking, stop() prevents timer callbacks, already-running cleanup is awaited, and post-stop tick is sealed', async () => {
  let poolEnded = false;
  let resolveCleanupQuery;
  const cleanupQueryGate = new Promise((resolve) => {
    resolveCleanupQuery = resolve;
  });

  const rawPool = {
    async query(sql) {
      if (typeof sql === 'string' && sql.includes('UPDATE visitor_sessions')) {
        return cleanupQueryGate;
      }
      return [[]];
    },
    async end() {
      poolEnded = true;
    },
  };

  const dbTracker = new DatabaseTracker();
  const instrumentedPool = instrumentPool(rawPool, dbTracker);

  const cleanupTask = startVisitorSessionCleanupTask({
    pool: instrumentedPool,
    intervalMs: 10000,
    logger: { log() {}, error() {} },
  });

  // 1. Trigger cleanup run and hold its DB query pending
  const runPromise = cleanupTask.tick();
  assert.equal(cleanupTask.isRunning, true, 'Cleanup task must be running');

  // Give instrumentedPool.query time to be invoked and tracked
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(dbTracker.getActiveCount(), 1, 'Cleanup DB query must be tracked in dbTracker');

  // 2. Begin graceful shutdown
  const fakeServer = { close: (cb) => cb() };
  let shutdownDone = false;
  const shutdownPromise = closeServerGracefully(fakeServer, cleanupTask, instrumentedPool).then(() => {
    shutdownDone = true;
  });

  await new Promise((r) => setTimeout(r, 25));

  // 3. Verify stop() was invoked: timer is cleared, shutdown in progress
  assert.equal(cleanupTask.isShuttingDown, true, 'Cleanup task is in shutting down state');
  assert.equal(cleanupTask.hasTimer, false, 'Timer must be stopped');

  // 4. Verify pool.end() is not called and shutdown cannot finish while cleanup is active
  assert.equal(poolEnded, false, 'pool.end() must NOT be called while cleanup is active');
  assert.equal(shutdownDone, false, 'Shutdown cannot complete while cleanup is active');

  // 5. Resolve the query
  resolveCleanupQuery([{ affectedRows: 0 }]);
  await runPromise;
  await shutdownPromise;

  assert.equal(shutdownDone, true, 'Shutdown completes after cleanup finishes');
  assert.equal(poolEnded, true, 'pool.end() is called after cleanup finishes');
  assert.equal(dbTracker.getActiveCount(), 0);

  // 6. Post-stop tick: cannot start work on task (returns skipped) and cannot issue queries on sealed pool
  const postStopResult = await cleanupTask.tick();
  assert.deepEqual(postStopResult, { skipped: true });
  await assert.rejects(
    () => instrumentedPool.query('SELECT 1'),
    (err) => {
      assert.equal(err.code, 'EDB_SEALED');
      return true;
    }
  );
});

test('Regression: createApp preserves existing DatabaseTracker on already-instrumented pool', async () => {
  let poolEnded = false;
  let resolveQuery;
  const queryGate = new Promise((resolve) => { resolveQuery = resolve; });

  // 1. Create raw fake pool
  const rawPool = {
    async query(sql) {
      if (typeof sql === 'string' && sql.includes('SELECT 1')) return [[]];
      return queryGate;
    },
    async end() {
      poolEnded = true;
    },
  };

  // 2. Instrument it with tracker A
  const trackerA = new DatabaseTracker();
  const instrumentedPool = instrumentPool(rawPool, trackerA);

  // 3. Pass the instrumented pool to createApp()
  const store = new session.MemoryStore();
  const app = createApp({ env: validTestEnv, pool: instrumentedPool, store });

  // 5. Verify app.dbTracker is tracker A
  assert.equal(app.dbTracker, trackerA, 'app.dbTracker must be the original tracker A');
  assert.equal(app.pool.dbTracker, trackerA, 'app.pool.dbTracker must be tracker A');

  // 4. Start a pending query through app.pool.query()
  const pendingQueryPromise = app.pool.query('SELECT pending_test');
  assert.equal(trackerA.getActiveCount(), 1, 'Tracker A must track the in-flight query');

  // 6. Start shutdown
  const fakeServer = { close: (cb) => cb() };
  let shutdownDone = false;
  const shutdownPromise = closeServerGracefully(fakeServer, null, instrumentedPool).then(() => {
    shutdownDone = true;
  });

  await new Promise((r) => setTimeout(r, 25));

  // 7. Verify the same tracker is sealed and shutdown waits for the pending query
  assert.equal(trackerA.isSealed(), true, 'Tracker A must be sealed by shutdown');
  assert.equal(shutdownDone, false, 'Shutdown cannot complete while query is pending');
  assert.equal(poolEnded, false, 'pool.end() must not be called while query is pending');

  // 8. Resolve the query and verify pool closure completes safely
  resolveQuery([[]]);
  await pendingQueryPromise;
  await shutdownPromise;

  assert.equal(trackerA.getActiveCount(), 0, 'Tracker A count reaches zero');
  assert.equal(poolEnded, true, 'pool.end() must be called after query settles');
  assert.equal(shutdownDone, true, 'Shutdown must complete safely');
});

test('Session store shutdown: callback-style close that never fires is bounded by deadline and skips pool.end()', async () => {
  let poolEnded = false;
  const rawPool = {
    end: async () => { poolEnded = true; },
  };

  const fakeStore = {
    clearExpirationInterval() {},
    // close(cb) accepts callback but never calls it
    close(cb) {
      // Intentionally hangs
    },
  };

  const fakeServer = { close: (cb) => cb() };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, null, rawPool, {
      sessionStore: fakeStore,
      timeoutMs: 40,
      httpGraceMs: 10,
      httpTimeoutMs: 15,
      cleanupTimeoutMs: 15,
    }),
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      assert.match(err.message, /Session store close timed out/);
      return true;
    }
  );

  // Pool end must be skipped because cleanup/store work timed out
  assert.equal(poolEnded, false, 'pool.end() must NOT be called when session store close times out');
});

test('Connection deferred release: Test A — Multiple simultaneous operations defer release until all settle', async () => {
  let physicalReleaseCount = 0;
  let resolveQuery1;
  let resolveQuery2;
  const queryGate1 = new Promise((resolve) => { resolveQuery1 = resolve; });
  const queryGate2 = new Promise((resolve) => { resolveQuery2 = resolve; });

  const rawConn = {
    async query(sql) {
      if (sql === 'QUERY_1') return queryGate1;
      if (sql === 'QUERY_2') return queryGate2;
      return [[]];
    },
    release() {
      physicalReleaseCount += 1;
    },
    destroy() {},
  };

  const rawPool = {
    getConnection: async () => rawConn,
    end: async () => {},
  };

  const dbTracker = new DatabaseTracker();
  const pool = instrumentPool(rawPool, dbTracker);

  const conn = await pool.getConnection();

  // Start two pending queries on the connection
  const p1 = conn.query('QUERY_1');
  const p2 = conn.query('QUERY_2');
  assert.equal(dbTracker.getActiveCount(), 1, 'Connection checked out with 2 active queries');

  // Call release() while both queries are pending
  conn.release();
  assert.equal(physicalReleaseCount, 0, 'Physical release must NOT occur while queries are pending');
  assert.equal(dbTracker.getActiveCount(), 2, '2 pending queries tracked after handle release');

  // Resolve one query
  resolveQuery1([{ q: 1 }]);
  await p1;
  assert.equal(physicalReleaseCount, 0, 'Physical release must remain deferred while second query is pending');
  assert.equal(dbTracker.getActiveCount(), 1, '1 query still tracked');

  // Resolve second query
  resolveQuery2([{ q: 2 }]);
  await p2;
  assert.equal(physicalReleaseCount, 1, 'Physical release must occur exactly once when all queries settle');
  assert.equal(dbTracker.getActiveCount(), 0, 'Tracker count reaches zero');
});

test('Connection deferred release: Test B — Rejection during deferred release settles token without count leak', async () => {
  let physicalReleaseCount = 0;
  let rejectQuery1;
  let resolveQuery2;
  const queryGate1 = new Promise((_, reject) => { rejectQuery1 = reject; });
  const queryGate2 = new Promise((resolve) => { resolveQuery2 = resolve; });

  const rawConn = {
    async query(sql) {
      if (sql === 'FAIL_QUERY') return queryGate1;
      if (sql === 'OK_QUERY') return queryGate2;
      return [[]];
    },
    release() {
      physicalReleaseCount += 1;
    },
    destroy() {},
  };

  const rawPool = {
    getConnection: async () => rawConn,
    end: async () => {},
  };

  const dbTracker = new DatabaseTracker();
  const pool = instrumentPool(rawPool, dbTracker);

  const conn = await pool.getConnection();
  const p1 = conn.query('FAIL_QUERY');
  const p2 = conn.query('OK_QUERY');

  conn.release();
  assert.equal(physicalReleaseCount, 0, 'Release deferred');
  assert.equal(dbTracker.getActiveCount(), 2);

  // Reject first operation
  rejectQuery1(new Error('QUERY_FAILED'));
  await assert.rejects(() => p1, /QUERY_FAILED/);

  // Tracking token for failed query must settle, but physical release remains deferred for second query
  assert.equal(physicalReleaseCount, 0, 'Physical release remains deferred while OK_QUERY is pending');
  assert.equal(dbTracker.getActiveCount(), 1, 'Only OK_QUERY remains tracked, no leak from failed query');

  // Resolve second operation
  resolveQuery2([[]]);
  await p2;

  assert.equal(physicalReleaseCount, 1, 'Physical release occurs once when all operations have settled');
  assert.equal(dbTracker.getActiveCount(), 0, 'Active count reaches zero without leakage');
});

test('Connection deferred release: Test C — Destroy followed by repeated release prevents physical release', async () => {
  let physicalReleaseCount = 0;
  let physicalDestroyCount = 0;
  let resolveQuery;
  const queryGate = new Promise((resolve) => { resolveQuery = resolve; });

  const rawConn = {
    async query() {
      return queryGate;
    },
    release() {
      physicalReleaseCount += 1;
    },
    destroy() {
      physicalDestroyCount += 1;
    },
  };

  const rawPool = {
    getConnection: async () => rawConn,
    end: async () => {},
  };

  const dbTracker = new DatabaseTracker();
  const pool = instrumentPool(rawPool, dbTracker);

  const conn = await pool.getConnection();
  const pendingQuery = conn.query('SELECT 1');

  // Call destroy()
  conn.destroy();
  assert.equal(physicalDestroyCount, 1, 'Physical destroy must be invoked');
  assert.equal(physicalReleaseCount, 0, 'Physical release must not be called on destroy');

  // Call release() repeatedly afterward
  conn.release();
  conn.release();
  conn.release();
  assert.equal(physicalReleaseCount, 0, 'Repeated release() after destroy must be safe no-op');
  assert.equal(physicalDestroyCount, 1, 'Destroy remains idempotent');

  // Settle query
  resolveQuery([[]]);
  await pendingQuery;

  // Deferred release must NOT execute after destroy
  assert.equal(physicalReleaseCount, 0, 'Deferred release must not execute on a destroyed connection');
  assert.equal(dbTracker.getActiveCount(), 0, 'Active count reaches zero');
});


// =========================================================================
// Non-forgeable pool-to-tracker association regression tests
// =========================================================================

test('WeakMap tracker: Test A — Replacing pool.dbTracker does not change the authoritative tracker used by shutdown', async () => {
  let poolEnded = false;
  let resolveQuery;
  const queryGate = new Promise((resolve) => { resolveQuery = resolve; });

  const rawPool = {
    async query(sql) {
      if (typeof sql === 'string' && sql.includes('SELECT 1')) return [[]];
      return queryGate;
    },
    async end() { poolEnded = true; },
  };

  // Instrument with tracker A
  const trackerA = new DatabaseTracker();
  const instrumentedPool = instrumentPool(rawPool, trackerA);

  // Verify WeakMap association
  assert.equal(getInstrumentedPoolTracker(instrumentedPool), trackerA, 'WeakMap must return tracker A');
  assert.equal(isInstrumentedPool(instrumentedPool), true, 'Pool must be recognized as instrumented');

  // Replace the public dbTracker property with tracker B (the attack vector)
  const trackerB = new DatabaseTracker();
  instrumentedPool.dbTracker = trackerB;

  // Pass the tampered pool to createApp — it must still use tracker A
  const store = new session.MemoryStore();
  const app = createApp({ env: validTestEnv, pool: instrumentedPool, store });
  assert.equal(app.dbTracker, trackerA, 'app.dbTracker must be the authoritative tracker A, not the replaced tracker B');

  // Start a query — wrappers close over tracker A
  const pendingQuery = app.pool.query('SELECT pending_tampered');
  assert.equal(trackerA.getActiveCount(), 1, 'Tracker A must track the in-flight query');
  assert.equal(trackerB.getActiveCount(), 0, 'Tracker B must have zero active operations');

  // Start shutdown
  const fakeServer = { close: (cb) => cb() };
  let shutdownDone = false;
  const shutdownPromise = closeServerGracefully(fakeServer, null, instrumentedPool).then(() => {
    shutdownDone = true;
  });

  await new Promise((r) => setTimeout(r, 25));

  // Shutdown must seal tracker A (not B)
  assert.equal(trackerA.isSealed(), true, 'Tracker A must be sealed by shutdown');
  assert.equal(trackerB.isSealed(), false, 'Tracker B must NOT be sealed');
  assert.equal(shutdownDone, false, 'Shutdown cannot complete while query is pending');
  assert.equal(poolEnded, false, 'pool.end() must not be called while query is pending');

  // Resolve
  resolveQuery([[]]);
  await pendingQuery;
  await shutdownPromise;

  assert.equal(trackerA.getActiveCount(), 0, 'Tracker A count reaches zero');
  assert.equal(poolEnded, true, 'pool.end() must be called after query settles');
  assert.equal(shutdownDone, true, 'Shutdown must complete');
});

test('WeakMap tracker: Test B — Forged public markers without instrumentPool() are rejected with EINVALID_INSTRUMENTATION', () => {
  const rawPool = {
    async query() { return [[]]; },
    async end() {},
  };

  // Forge the public markers that the old isInstrumentedPool() would have trusted
  rawPool._isInstrumented = true;
  rawPool.dbTracker = new DatabaseTracker();

  // isInstrumentedPool must reject (no WeakMap entry)
  assert.equal(isInstrumentedPool(rawPool), false, 'Forged pool must NOT pass isInstrumentedPool');
  assert.equal(getInstrumentedPoolTracker(rawPool), null, 'Forged pool must return null tracker');

  // instrumentPool must throw EINVALID_INSTRUMENTATION
  assert.throws(
    () => instrumentPool(rawPool),
    (err) => {
      assert.equal(err.code, 'EINVALID_INSTRUMENTATION');
      assert.match(err.message, /invalid or corrupted/);
      return true;
    }
  );

  // createApp must also reject the forged pool
  const store = new session.MemoryStore();
  assert.throws(
    () => createApp({ env: validTestEnv, pool: rawPool, store }),
    (err) => {
      assert.equal(err.code, 'EINVALID_INSTRUMENTATION');
      return true;
    }
  );
});

test('WeakMap tracker: Test C — Normal raw pool regression: createApp instruments and tracks correctly', async () => {
  let poolEnded = false;
  let resolveQuery;
  const queryGate = new Promise((resolve) => { resolveQuery = resolve; });

  const rawPool = {
    async query(sql) {
      if (typeof sql === 'string' && sql.includes('SELECT 1')) return [[]];
      return queryGate;
    },
    async end() { poolEnded = true; },
  };

  // Pass raw pool to createApp — it should instrument and create a new tracker
  const store = new session.MemoryStore();
  const app = createApp({ env: validTestEnv, pool: rawPool, store });

  assert.ok(app.dbTracker instanceof DatabaseTracker, 'app.dbTracker must be a DatabaseTracker');
  assert.equal(isInstrumentedPool(app.pool), true, 'app.pool must be instrumented');
  assert.equal(getInstrumentedPoolTracker(app.pool), app.dbTracker, 'WeakMap must return the same tracker');

  // Start a query
  const pendingQuery = app.pool.query('SELECT raw_pool_test');
  assert.equal(app.dbTracker.getActiveCount(), 1, 'Tracker must track the query');

  // Resolve and verify
  resolveQuery([[]]);
  await pendingQuery;
  assert.equal(app.dbTracker.getActiveCount(), 0, 'Tracker count reaches zero');
});

test('WeakMap tracker: Test D — Unknown instrumentation claim without WeakMap entry is deterministically rejected', () => {
  const rawPool = {
    async query() { return [[]]; },
    async end() {},
  };

  // Set only _isInstrumented (not the private symbol)
  rawPool._isInstrumented = true;
  // No pool.dbTracker, no Symbol marker — just the boolean flag

  assert.equal(isInstrumentedPool(rawPool), false, 'Must not pass isInstrumentedPool');
  assert.equal(getInstrumentedPoolTracker(rawPool), null, 'Must return null tracker');

  // instrumentPool must reject with EINVALID_INSTRUMENTATION
  assert.throws(
    () => instrumentPool(rawPool),
    (err) => {
      assert.equal(err.code, 'EINVALID_INSTRUMENTATION');
      return true;
    }
  );
});


// =========================================================================
// Codex Audit Findings: Finding 1 & Finding 2 Regressions
// =========================================================================

test('Finding 1 Regression: Raw-pool shutdown selects authoritative tracker, ignoring replaced targetPool.dbTracker', async () => {
  let poolEnded = false;
  let resolveQuery;
  const queryGate = new Promise((resolve) => { resolveQuery = resolve; });

  const targetPool = {
    async getConnection() {
      return {
        async query() { return [[]]; },
        release() {},
        destroy() {},
      };
    },
    async query(sql) {
      if (typeof sql === 'string' && sql.includes('SELECT 1')) return [[]];
      return queryGate;
    },
    async end() {
      poolEnded = true;
    },
  };

  // 1. Creates an app using a raw pool via startServer()
  const server = await startServer({
    env: validTestEnv,
    pool: targetPool,
    store: new session.MemoryStore(),
    port: 0,
    logger: { log() {}, error() {}, warn() {} },
  });

  // Retrieve the authoritative Tracker A associated with the app's instrumented pool
  const trackerA = server.dbTracker;
  assert.ok(trackerA instanceof DatabaseTracker, 'Tracker A must be a valid DatabaseTracker');

  // 2. Replaces targetPool.dbTracker with tracker B
  const trackerB = new DatabaseTracker();
  targetPool.dbTracker = trackerB;

  // 4. Keeps a query pending through the app's instrumented wrapper using tracker A
  const pendingQuery = server.pool.query('SELECT pending_raw_pool_shutdown');
  assert.equal(trackerA.getActiveCount(), 1, 'Tracker A must track the in-flight query');
  assert.equal(trackerB.getActiveCount(), 0, 'Tracker B must have zero active count');

  // 3. Starts shutdown through the actual startServer() shutdown path (server.shutdown())
  let shutdownDone = false;
  const shutdownPromise = server.shutdown().then(() => {
    shutdownDone = true;
  });

  await new Promise((r) => setTimeout(r, 35));

  // 5. Verifies tracker A is sealed and shutdown waits for its query
  assert.equal(trackerA.isSealed(), true, 'Tracker A must be sealed by shutdown');
  assert.equal(shutdownDone, false, 'Shutdown cannot complete while query is pending on tracker A');
  assert.equal(poolEnded, false, 'pool.end() must not be called while query is pending');

  // 6. Verifies tracker B is not used as the shutdown authority
  assert.equal(trackerB.isSealed(), false, 'Tracker B must NOT be sealed');
  assert.equal(trackerB.getActiveCount(), 0, 'Tracker B must have zero active count');

  // Resolve query and verify shutdown completes
  resolveQuery([[]]);
  await pendingQuery;
  await shutdownPromise;

  assert.equal(trackerA.getActiveCount(), 0, 'Tracker A active count reaches zero');
  assert.equal(poolEnded, true, 'pool.end() called after query completes');
  assert.equal(shutdownDone, true, 'Shutdown completes cleanly');
});

test('Finding 1: Shutdown fails closed when explicit tracker and pool tracker disagree', async () => {
  const trackerA = new DatabaseTracker();
  const rawPool = { end: async () => {} };
  const instrumented = instrumentPool(rawPool, trackerA);

  const trackerB = new DatabaseTracker();
  const fakeServer = { close: (cb) => cb() };

  await assert.rejects(
    () => closeServerGracefully(fakeServer, null, instrumented, { dbTracker: trackerB }),
    (err) => {
      assert.equal(err.code, 'EINVALID_TRACKER');
      assert.match(err.message, /Database tracker mismatch/);
      return true;
    }
  );

  assert.equal(trackerA.isSealed(), false, 'Tracker A must not be sealed on mismatch');
  assert.equal(trackerB.isSealed(), false, 'Tracker B must not be sealed on mismatch');
});

test('Finding 2 Regression: Replacing pool.query with unwrapped method fails closed', () => {
  const originalQuery = async function unwrappedQuery(sql) { return [[]]; };
  const rawPool = {
    query: originalQuery,
    execute: async function unwrappedExecute(sql) { return [[]]; },
    getConnection: async function unwrappedGetConnection() {
      return { query: originalQuery, release() {}, destroy() {} };
    },
    end: async function unwrappedEnd() {},
  };

  const tracker = new DatabaseTracker();
  const instrumented = instrumentPool(rawPool, tracker);

  assert.equal(isInstrumentedPool(instrumented), true, 'Must initially be validly instrumented');
  assert.equal(getInstrumentedPoolTracker(instrumented), tracker, 'Must return tracker initially');

  // Replace pool.query with its original unwrapped method
  instrumented.query = originalQuery;

  // 1. isInstrumentedPool() does not report the pool as validly instrumented
  assert.equal(isInstrumentedPool(instrumented), false, 'isInstrumentedPool must return false for mutated pool');

  // 2. instrumentPool() rejects the mutated pool
  assert.throws(
    () => instrumentPool(instrumented),
    (err) => {
      assert.equal(err.code, 'EINVALID_INSTRUMENTATION');
      assert.match(err.message, /wrappers have been replaced or corrupted/);
      return true;
    },
    'instrumentPool must reject the mutated pool'
  );

  // 3. createApp() rejects the mutated pool
  assert.throws(
    () => createApp({ env: validTestEnv, pool: instrumented, store: new session.MemoryStore() }),
    (err) => {
      assert.equal(err.code, 'EINVALID_INSTRUMENTATION');
      return true;
    },
    'createApp must reject the mutated pool'
  );

  // 4. getInstrumentedPoolTracker() fails closed with EINVALID_INSTRUMENTATION
  assert.throws(
    () => getInstrumentedPoolTracker(instrumented),
    (err) => {
      assert.equal(err.code, 'EINVALID_INSTRUMENTATION');
      return true;
    },
    'getInstrumentedPoolTracker must reject the mutated pool'
  );

  // 5. No untracked query can silently pass as instrumented:
  // Calling the replaced query executes untracked (tracker count stays 0),
  // proving that admission rejection was necessary to prevent untracked work.
  instrumented.query('SELECT untracked');
  assert.equal(tracker.getActiveCount(), 0, 'Replaced query runs untracked, proving danger of acceptance');
});

test('Finding 2: Tampering with other wrapper methods (execute, getConnection, seal) fails closed', () => {
  const rawPool = {
    query: async () => [[]],
    execute: async () => [[]],
    getConnection: async () => ({ query: async () => [[]], release() {}, destroy() {} }),
    end: async () => {},
  };

  // Tamper with execute
  const pool1 = instrumentPool(rawPool, new DatabaseTracker());
  pool1.execute = async () => [[]];
  assert.equal(isInstrumentedPool(pool1), false);
  assert.throws(() => instrumentPool(pool1), { code: 'EINVALID_INSTRUMENTATION' });

  // Tamper with getConnection
  const pool2 = instrumentPool(rawPool, new DatabaseTracker());
  pool2.getConnection = async () => null;
  assert.equal(isInstrumentedPool(pool2), false);
  assert.throws(() => instrumentPool(pool2), { code: 'EINVALID_INSTRUMENTATION' });

  // Tamper with seal
  const pool3 = instrumentPool(rawPool, new DatabaseTracker());
  pool3.seal = () => {};
  assert.equal(isInstrumentedPool(pool3), false);
  assert.throws(() => instrumentPool(pool3), { code: 'EINVALID_INSTRUMENTATION' });

  // Delete a wrapper
  const pool4 = instrumentPool(rawPool, new DatabaseTracker());
  delete pool4.isSealed;
  assert.equal(isInstrumentedPool(pool4), false);
  assert.throws(() => instrumentPool(pool4), { code: 'EINVALID_INSTRUMENTATION' });
});
