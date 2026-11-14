/**
 * Reliable Database Work Tracker
 *
 * Independently tracks database activity across pool queries, connection checkouts,
 * queries executed on checked-out connections, and transactions.
 *
 * Guarantees:
 * 1. An in-flight pool.query() or pool.execute() is tracked until its promise settles.
 * 2. A checked-out connection (pool.getConnection()) is tracked from acquisition until
 *    safe release (connection.release() or connection.destroy()).
 * 3. Connection operations (query, execute, beginTransaction, commit, rollback) are tracked
 *    so any query that outlives release or connection checkout remains tracked until settled.
 * 4. Release is idempotent and safe; no double-decrement or counter leakage on error paths.
 * 5. Lifecycle seal (seal(), isSealed()):
 *    - Once sealed, any attempt to start new database operations or check out new connections
 *      is rejected immediately with EDB_SEALED.
 *    - Operations in flight before sealing are allowed to complete.
 *    - Connection commit/rollback/release/destroy are never blocked by the seal.
 * 6. Connection reuse safety & deferred release:
 *    - If release() is called while queries are still in-flight on a connection,
 *      physical release back to the pool is deferred until all in-flight queries settle to prevent
 *      unsafe connection reuse on the wire.
 *    - The connection's pending queries remain tracked in dbTracker until settlement.
 *    - If destroy() is called, physical release is cancelled, deferred release cannot run,
 *      and subsequent release() calls are safe no-ops.
 * 7. Identity & Tracker preservation (non-forgeable):
 *    - A module-scoped WeakMap is the sole authority linking an instrumented pool to its
 *      DatabaseTracker. Reassigning pool.dbTracker or forging public markers cannot change
 *      which tracker the query/execute/getConnection wrappers close over.
 *    - getInstrumentedPoolTracker() is the only sanctioned way to retrieve the authoritative tracker.
 */

// Private, non-forgeable association: the WeakMap is not exported.
// Pools are registered here only by instrumentPool(); no external code can add entries.
const instrumentedPools = new WeakMap();

// Module-private unregistered symbol — cannot be reproduced by Symbol.for() from outside.
const INSTRUMENTED_POOL_MARKER = Symbol('parkx.instrumented_pool');

export class DatabaseTracker {
  constructor() {
    this.activePoolOperations = new Set();
    this.activeConnections = new Set();
    this.connectionCheckoutCounts = new Map(); // conn -> number
    this.connectionOperations = new Map(); // connection -> Set of active operation tokens
    this._isSealed = false;
  }

  seal() {
    this._isSealed = true;
  }

  isSealed() {
    return this._isSealed;
  }

  createSealedError() {
    const error = new Error('Database is sealed for shutdown: cannot admit new database operations');
    error.code = 'EDB_SEALED';
    return error;
  }

  trackPoolOperation(promise) {
    if (!promise || typeof promise.then !== 'function') return promise;
    const token = Symbol('poolOp');
    this.activePoolOperations.add(token);
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        this.activePoolOperations.delete(token);
      }
    };
    promise.then(done, done);
    return promise;
  }

  trackConnectionCheckout(conn) {
    if (!conn) return;
    const current = this.connectionCheckoutCounts.get(conn) || 0;
    this.connectionCheckoutCounts.set(conn, current + 1);
    this.activeConnections.add(conn);
    if (!this.connectionOperations.has(conn)) {
      this.connectionOperations.set(conn, new Set());
    }
  }

  trackConnectionRelease(conn) {
    if (!conn) return;
    const current = this.connectionCheckoutCounts.get(conn) || 0;
    if (current <= 1) {
      this.connectionCheckoutCounts.delete(conn);
      this.activeConnections.delete(conn);
    } else {
      this.connectionCheckoutCounts.set(conn, current - 1);
    }
  }

  trackConnectionOperation(conn, promise) {
    if (!promise || typeof promise.then !== 'function') return promise;
    let ops = this.connectionOperations.get(conn);
    if (!ops) {
      ops = new Set();
      this.connectionOperations.set(conn, ops);
    }
    const token = Symbol('connOp');
    ops.add(token);
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        ops.delete(token);
        if (ops.size === 0) {
          if (!this.activeConnections.has(conn)) {
            this.connectionOperations.delete(conn);
          }
          if (typeof conn._onDeferredRelease === 'function') {
            const deferred = conn._onDeferredRelease;
            conn._onDeferredRelease = null;
            deferred();
          }
        }
      }
    };
    promise.then(done, done);
    return promise;
  }

  getActiveCount() {
    let count = this.activePoolOperations.size;
    for (const checkouts of this.connectionCheckoutCounts.values()) {
      count += checkouts;
    }
    for (const [conn, ops] of this.connectionOperations.entries()) {
      if (!this.activeConnections.has(conn)) {
        count += ops.size;
      }
    }
    return count;
  }
}

function validatePoolWrappers(pool, record) {
  if (!pool || typeof pool !== 'object' || !record || !record.wrappers) {
    return false;
  }
  for (const [methodName, expectedFn] of Object.entries(record.wrappers)) {
    if (pool[methodName] !== expectedFn) {
      return false;
    }
  }
  return true;
}

/**
 * Returns true if the pool was instrumented by this module's instrumentPool()
 * and its installed wrapper methods have not been replaced or corrupted.
 */
export function isInstrumentedPool(pool) {
  if (!pool || typeof pool !== 'object') return false;
  const record = instrumentedPools.get(pool);
  if (!record) return false;
  return validatePoolWrappers(pool, record);
}

/**
 * Returns the authoritative DatabaseTracker for an instrumented pool,
 * or null if the pool was never instrumented by this module.
 *
 * If the pool was instrumented but any wrapper method reference has been
 * replaced or corrupted, fails closed with EINVALID_INSTRUMENTATION.
 */
export function getInstrumentedPoolTracker(pool) {
  if (!pool || typeof pool !== 'object') return null;
  const record = instrumentedPools.get(pool);
  if (!record) return null;
  if (!validatePoolWrappers(pool, record)) {
    const err = new Error('Pool is marked instrumented but its wrappers have been replaced or corrupted');
    err.code = 'EINVALID_INSTRUMENTATION';
    throw err;
  }
  return record.tracker;
}

// Legacy alias — retained for any external callers during transition.
export const getInstrumentedTracker = getInstrumentedPoolTracker;

export function instrumentConnection(conn, dbTracker) {
  if (!conn || typeof conn !== 'object') {
    return conn;
  }

  const underlying = conn._rawConn || conn;

  dbTracker.trackConnectionCheckout(underlying);

  let released = false;
  let releaseRequested = false;
  let releaseArgs = null;
  let destroyed = false;

  const doRelease = () => {
    if (!released) {
      released = true;
      dbTracker.trackConnectionRelease(underlying);
    }
  };

  const instrumented = Object.create(underlying);
  instrumented._isInstrumented = true;
  instrumented._rawConn = underlying;

  if (typeof underlying.query === 'function') {
    instrumented.query = function trackedConnQuery(...args) {
      if (dbTracker.isSealed()) {
        return Promise.reject(dbTracker.createSealedError());
      }
      const p = underlying.query.apply(underlying, args);
      return dbTracker.trackConnectionOperation(underlying, p);
    };
  }

  if (typeof underlying.execute === 'function') {
    instrumented.execute = function trackedConnExecute(...args) {
      if (dbTracker.isSealed()) {
        return Promise.reject(dbTracker.createSealedError());
      }
      const p = underlying.execute.apply(underlying, args);
      return dbTracker.trackConnectionOperation(underlying, p);
    };
  }

  if (typeof underlying.beginTransaction === 'function') {
    instrumented.beginTransaction = function trackedBeginTransaction(...args) {
      if (dbTracker.isSealed()) {
        return Promise.reject(dbTracker.createSealedError());
      }
      const p = underlying.beginTransaction.apply(underlying, args);
      return dbTracker.trackConnectionOperation(underlying, p);
    };
  }

  if (typeof underlying.commit === 'function') {
    instrumented.commit = function trackedCommit(...args) {
      const p = underlying.commit.apply(underlying, args);
      return dbTracker.trackConnectionOperation(underlying, p);
    };
  }

  if (typeof underlying.rollback === 'function') {
    instrumented.rollback = function trackedRollback(...args) {
      const p = underlying.rollback.apply(underlying, args);
      return dbTracker.trackConnectionOperation(underlying, p);
    };
  }

  if (typeof underlying.release === 'function') {
    instrumented.release = function trackedRelease(...args) {
      if (destroyed) {
        // Destroyed connection must never schedule deferred release or invoke underlying.release
        return;
      }
      doRelease();
      const ops = dbTracker.connectionOperations.get(underlying);
      if (ops && ops.size > 0) {
        // Defer physical pool release until all in-flight queries settle
        // to prevent commands out of sync / unsafe connection reuse on the wire
        releaseRequested = true;
        releaseArgs = args;
        underlying._onDeferredRelease = () => {
          if (releaseRequested && !destroyed) {
            releaseRequested = false;
            try {
              underlying.release.apply(underlying, releaseArgs || []);
            } catch {}
          }
        };
        return;
      }
      return underlying.release.apply(underlying, args);
    };
  }

  if (typeof underlying.destroy === 'function') {
    instrumented.destroy = function trackedDestroy(...args) {
      if (destroyed) return;
      destroyed = true;
      doRelease();
      releaseRequested = false;
      underlying._onDeferredRelease = null;
      return underlying.destroy.apply(underlying, args);
    };
  }

  return instrumented;
}

export function instrumentPool(targetPool, dbTracker = new DatabaseTracker()) {
  if (!targetPool || typeof targetPool !== 'object') {
    return targetPool;
  }

  // Check authoritative WeakMap first: if already instrumented, validate wrappers.
  const existingRecord = instrumentedPools.get(targetPool);
  if (existingRecord) {
    if (!validatePoolWrappers(targetPool, existingRecord)) {
      const err = new Error('Pool is marked instrumented but its wrappers have been replaced or corrupted');
      err.code = 'EINVALID_INSTRUMENTATION';
      throw err;
    }
    return targetPool;
  }

  // Detect forgery: pool claims instrumentation via public markers but has no WeakMap entry.
  if (targetPool[INSTRUMENTED_POOL_MARKER] || targetPool._isInstrumented) {
    const err = new Error('Pool is marked instrumented but has an invalid or corrupted DatabaseTracker');
    err.code = 'EINVALID_INSTRUMENTATION';
    throw err;
  }

  if (!(dbTracker instanceof DatabaseTracker)) {
    const err = new Error('Cannot instrument pool: dbTracker must be an instance of DatabaseTracker');
    err.code = 'EINVALID_TRACKER';
    throw err;
  }

  const instrumented = Object.create(targetPool);
  instrumented[INSTRUMENTED_POOL_MARKER] = true;
  instrumented._isInstrumented = true;
  instrumented._rawPool = targetPool;
  instrumented.dbTracker = dbTracker;
  instrumented.seal = () => dbTracker.seal();
  instrumented.isSealed = () => dbTracker.isSealed();

  if (typeof targetPool.query === 'function') {
    instrumented.query = function trackedPoolQuery(...args) {
      if (dbTracker.isSealed()) {
        return Promise.reject(dbTracker.createSealedError());
      }
      const p = targetPool.query.apply(targetPool, args);
      return dbTracker.trackPoolOperation(p);
    };
  }

  if (typeof targetPool.execute === 'function') {
    instrumented.execute = function trackedPoolExecute(...args) {
      if (dbTracker.isSealed()) {
        return Promise.reject(dbTracker.createSealedError());
      }
      const p = targetPool.execute.apply(targetPool, args);
      return dbTracker.trackPoolOperation(p);
    };
  }

  if (typeof targetPool.getConnection === 'function') {
    instrumented.getConnection = async function trackedGetConnection(...args) {
      if (dbTracker.isSealed()) {
        throw dbTracker.createSealedError();
      }
      const acquirePromise = targetPool.getConnection.apply(targetPool, args);
      dbTracker.trackPoolOperation(acquirePromise);

      const conn = await acquirePromise;
      return instrumentConnection(conn, dbTracker);
    };
  }

  if (typeof targetPool.end === 'function') {
    instrumented.end = function trackedPoolEnd(...args) {
      return targetPool.end.apply(targetPool, args);
    };
  }

  // Record the exact wrapper method references installed during instrumentation
  const wrappers = {
    seal: instrumented.seal,
    isSealed: instrumented.isSealed,
  };
  if (typeof instrumented.query === 'function') wrappers.query = instrumented.query;
  if (typeof instrumented.execute === 'function') wrappers.execute = instrumented.execute;
  if (typeof instrumented.getConnection === 'function') wrappers.getConnection = instrumented.getConnection;
  if (typeof instrumented.end === 'function') wrappers.end = instrumented.end;

  // Register the authoritative pool→tracker association and wrapper references in the private WeakMap.
  // This is the ONLY place entries are added; no external code can insert or modify them.
  instrumentedPools.set(instrumented, { tracker: dbTracker, wrappers });

  return instrumented;
}
