import { sanitizeDbErrorCode } from '../db.js';

/**
 * ParkX Visitor Session Retention Policy:
 * ----------------------------------------------------
 * 1. Active Lifespan (TTL):
 *    - Pending and accepted sessions have an active lifespan of 24 hours.
 *    - When expires_at <= NOW(), unclosed sessions are marked as 'expired'.
 *
 * 2. Retention Window:
 *    - Closed and expired sessions are retained for exactly 30 days to support
 *      owner audit/history and dispute resolution.
 *
 * 3. Purging:
 *    - After 30 days past closure or expiration:
 *      (status = 'closed' AND closed_at < NOW() - INTERVAL 30 DAY) OR
 *      (status = 'expired' AND expires_at < NOW() - INTERVAL 30 DAY)
 *    - Records are purged in bounded batches using indexed predicates:
 *      - idx_visitor_sessions_closed_status (closed_at, status)
 *      - idx_visitor_sessions_expires_status (expires_at, status)
 *    - Under NO circumstances are unexpired pending or accepted sessions deleted.
 *
 * 4. Process-Wide Singleton Execution & Graceful Shutdown:
 *    - A single process-wide timer runs periodically.
 *    - Multiple start calls do not spawn duplicate timers.
 *    - Concurrency/re-entrancy guard ensures cleanup never overlaps with itself.
 *    - Graceful shutdown clears the timer, prevents new work from starting,
 *      and awaits the completion of any currently in-flight run.
 *    - Cleanup failures are logged safely and never crash the process.
 */

export const RETENTION_DAYS = 30;
export const CLEANUP_BATCH_SIZE = 500;
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Executes a single bounded cleanup run.
 * Returns { expiredCount, deletedCount, error }.
 */
export async function runVisitorSessionCleanup(pool, {
  retentionDays = RETENTION_DAYS,
  batchSize = CLEANUP_BATCH_SIZE,
  logger = console,
} = {}) {
  if (!pool) return { expiredCount: 0, deletedCount: 0 };

  const safeLog = (level, message, meta) => {
    try {
      if (typeof logger?.[level] === 'function') logger[level](message, meta);
      else if (typeof console?.[level] === 'function') console[level](message, meta);
    } catch {}
  };

  try {
    // 1. Transition pending/accepted sessions that passed TTL to 'expired'
    // Uses index on (expires_at, status)
    const [expireResult] = await pool.query(
      `UPDATE visitor_sessions
       SET status = 'expired'
       WHERE status IN ('pending', 'accepted') AND expires_at <= NOW()
       LIMIT ?`,
      [batchSize]
    );
    const expiredCount = Number(expireResult?.affectedRows || 0);

    // 2. Delete closed sessions past the 30-day retention period
    // Uses index idx_visitor_sessions_closed_status (closed_at, status)
    const [closedDeleteResult] = await pool.query(
      `DELETE FROM visitor_sessions
       WHERE status = 'closed' AND closed_at < NOW() - INTERVAL ? DAY
       LIMIT ?`,
      [retentionDays, batchSize]
    );
    const closedDeleted = Number(closedDeleteResult?.affectedRows || 0);

    // 3. Delete expired sessions past the 30-day retention period
    // Uses index idx_visitor_sessions_expires_status (expires_at, status)
    const [expiredDeleteResult] = await pool.query(
      `DELETE FROM visitor_sessions
       WHERE status = 'expired' AND expires_at < NOW() - INTERVAL ? DAY
       LIMIT ?`,
      [retentionDays, batchSize]
    );
    const expiredDeleted = Number(expiredDeleteResult?.affectedRows || 0);

    const deletedCount = closedDeleted + expiredDeleted;

    if (expiredCount > 0 || deletedCount > 0) {
      safeLog('log', 'Visitor session retention cleanup finished', { expiredCount, deletedCount });
    }

    return { expiredCount, deletedCount };
  } catch (err) {
    const safeCode = sanitizeDbErrorCode(err?.code);
    safeLog('error', 'Visitor session retention cleanup failed', { code: safeCode });
    return { expiredCount: 0, deletedCount: 0, error: safeCode };
  }
}

// ────────────────────────────────────────────────────────────
// Process-Wide Singleton State
// ────────────────────────────────────────────────────────────
let activeTimerOwner = null;
let currentRunPromise = null;
let currentRunOwner = null;
let singletonInstance = null;

export function getCleanupTaskState() {
  return {
    hasTimer: Boolean(activeTimerOwner?.timer),
    isRunning: Boolean(currentRunPromise),
    isShuttingDown: Boolean(singletonInstance?.isShuttingDown),
  };
}

export function resetCleanupTaskForTesting() {
  if (activeTimerOwner?.timer) {
    clearInterval(activeTimerOwner.timer);
    activeTimerOwner.timer = null;
  }
  if (singletonInstance) singletonInstance.beginShutdown();
  singletonInstance = null;
}

/**
 * Starts or returns the process-wide singleton background cleanup task.
 */
export function startVisitorSessionCleanupTask({
  pool,
  intervalMs = CLEANUP_INTERVAL_MS,
  retentionDays = RETENTION_DAYS,
  batchSize = CLEANUP_BATCH_SIZE,
  logger = console,
} = {}) {
  // A stopping instance may still be draining. A new generation can start;
  // its stop closure only owns resources assigned to that generation.
  if (singletonInstance && !singletonInstance.isShuttingDown && singletonInstance.hasTimer) {
    return singletonInstance;
  }

  const instance = { timer: null, runPromise: null, stopPromise: null, shuttingDown: false };

  const runOnce = async () => {
    // Prevent work if shutdown has commenced
    if (instance.shuttingDown) return { skipped: true };
    // Prevent overlapping runs
    if (currentRunPromise) return { overlapping: true };

    let runResolve;
    const thisRun = new Promise((resolve) => {
      runResolve = resolve;
    });
    currentRunPromise = thisRun;
    currentRunOwner = instance;
    instance.runPromise = thisRun;

    try {
      const result = await runVisitorSessionCleanup(pool, { retentionDays, batchSize, logger });
      runResolve(result);
      return result;
    } catch {
      runResolve({ error: 'DB_CONNECTION_ERROR' });
      return { error: 'DB_CONNECTION_ERROR' };
    } finally {
      if (currentRunOwner === instance) {
        currentRunPromise = null;
        currentRunOwner = null;
      }
      if (instance.runPromise === thisRun) instance.runPromise = null;
    }
  };

  if (activeTimerOwner?.timer) {
    clearInterval(activeTimerOwner.timer);
    activeTimerOwner.timer = null;
  }

  instance.timer = setInterval(() => {
    runOnce().catch(() => {});
  }, intervalMs);

  if (typeof instance.timer.unref === 'function') {
    instance.timer.unref();
  }
  activeTimerOwner = instance;

  const beginShutdown = () => {
    instance.shuttingDown = true;
    if (instance.timer) {
      clearInterval(instance.timer);
      instance.timer = null;
      if (activeTimerOwner === instance) activeTimerOwner = null;
    }
  };

  const stop = () => {
    if (!instance.stopPromise) {
      beginShutdown();
      instance.stopPromise = (async () => {
        // Wait only for this generation's active cleanup. A later generation
        // may already own the process-wide timer while this run drains.
        if (instance.runPromise) {
          try {
            await instance.runPromise;
          } catch {}
        }
        if (singletonInstance === task) singletonInstance = null;
      })();
    }
    return instance.stopPromise;
  };

  const task = {
    stop,
    tick: runOnce,
    triggerNow: runOnce,
    beginShutdown,
    get isShuttingDown() {
      return instance.shuttingDown;
    },
    get isRunning() {
      return Boolean(instance.runPromise);
    },
    get hasTimer() {
      return Boolean(instance.timer);
    },
  };

  // Do not let an old stop() clear a newer task installed after restart.
  singletonInstance = task;
  return task;
}
