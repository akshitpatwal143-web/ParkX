/**
 * ParkX Phase 3.5: Safe Predefined Automatic Replies
 *
 * Rules:
 * - Only sent when vehicle owner availability is BUSY or AWAY, and auto_reply_enabled is TRUE.
 * - Anti-spam rule: At most ONE automatic reply per visitor session per availability period/status transition.
 *   Uses durable users.availability_version so BUSY -> AVAILABLE -> BUSY correctly permits a new auto-reply.
 * - Atomic claim and insert: Rechecks live session status and availability under FOR UPDATE row locks.
 * - Rolls back the claim if insertion fails.
 * - Clearly flagged as is_auto_reply = TRUE in database and API responses.
 * - Never makes arbitrary promises or alters/blocks visitor messages.
 * - Asynchronous and non-blocking: errors are safely logged and never bubble up to fail visitor requests.
 */

export const DEFAULT_BUSY_MESSAGE =
  'I am currently busy. I have received your message and will respond as soon as possible.';

export const DEFAULT_AWAY_MESSAGE =
  'I am currently away from my vehicle. I have received your message and will respond when I return.';

/**
 * Handles automatic reply evaluation and dispatch for an incoming visitor message.
 *
 * @param {object} params
 * @param {object} params.pool - MySQL connection pool
 * @param {number} params.sessionDbId - Numerical visitor_sessions.id
 * @param {string} params.sessionId - Public visitor session identifier (vs_...)
 * @param {number} params.vehicleId - Associated vehicle ID
 * @param {object} [params.logger] - Logger instance
 * @returns {Promise<{ sent: boolean, messageId?: number, body?: string, reason?: string }>}
 */
export async function handleAutoReplyForSession({
  pool,
  sessionDbId,
  sessionId,
  vehicleId,
  logger = console,
}) {
  if (!pool || !sessionDbId) {
    return { sent: false, reason: 'missing_parameters' };
  }

  const connection = typeof pool.getConnection === 'function' ? await pool.getConnection() : pool;
  const canTransact = typeof connection.beginTransaction === 'function';

  try {
    if (canTransact) await connection.beginTransaction();

    // 1. Lock session and join owner user row FOR UPDATE
    // Rechecks current owner availability and session status at the exact moment of claiming
    const [rows] = await connection.query(
      `SELECT u.id AS user_id, u.availability_status, u.availability_version,
              u.auto_reply_enabled, u.auto_reply_busy, u.auto_reply_away,
              s.id AS session_db_id, s.status AS session_status, s.expires_at,
              s.last_auto_reply_version
       FROM visitor_sessions s
       JOIN vehicles v ON v.id = s.vehicle_id
       JOIN users u ON u.id = v.user_id
       WHERE s.id = ?
       FOR UPDATE`,
      [sessionDbId]
    );

    if (!rows || rows.length === 0) {
      if (canTransact && typeof connection.rollback === 'function') await connection.rollback();
      return { sent: false, reason: 'session_not_found' };
    }

    const config = rows[0];

    // Recheck session status: MUST be live ('pending' or 'accepted')
    if (config.session_status !== 'pending' && config.session_status !== 'accepted') {
      if (canTransact && typeof connection.rollback === 'function') await connection.rollback();
      return { sent: false, reason: 'session_not_live' };
    }

    // Recheck session expiry: reject automatic replies if session has expired, even if cleanup has not yet marked it expired
    const now = new Date();
    if (config.expires_at && new Date(config.expires_at).getTime() <= now.getTime()) {
      if (canTransact && typeof connection.rollback === 'function') await connection.rollback();
      return { sent: false, reason: 'session_expired' };
    }

    // Owner must have auto-reply enabled
    if (!config.auto_reply_enabled) {
      if (canTransact && typeof connection.rollback === 'function') await connection.rollback();
      return { sent: false, reason: 'auto_reply_disabled' };
    }

    const currentStatus = config.availability_status;

    // Auto-reply is only dispatched for 'busy' or 'away'
    if (currentStatus !== 'busy' && currentStatus !== 'away') {
      if (canTransact && typeof connection.rollback === 'function') await connection.rollback();
      return { sent: false, reason: 'owner_available' };
    }

    // Anti-spam check with durable availability_version:
    // If an auto-reply was already sent during this availability period, do not send another.
    if (config.last_auto_reply_version !== null && config.last_auto_reply_version === config.availability_version) {
      if (canTransact && typeof connection.rollback === 'function') await connection.rollback();
      return { sent: false, reason: 'already_sent_for_period' };
    }

    // Determine predefined reply text (up to 500 characters)
    const autoReplyText = currentStatus === 'busy'
      ? (config.auto_reply_busy?.trim() || DEFAULT_BUSY_MESSAGE)
      : (config.auto_reply_away?.trim() || DEFAULT_AWAY_MESSAGE);

    // 2. Claim the auto-reply for this availability version atomically
    await connection.query(
      `UPDATE visitor_sessions
       SET last_auto_reply_status = ?,
           last_auto_reply_version = ?
       WHERE id = ?`,
      [currentStatus, config.availability_version, sessionDbId]
    );

    // 3. Insert the automated reply message into visitor_messages
    const [insertResult] = await connection.query(
      `INSERT INTO visitor_messages
         (session_id, sender_type, body, priority, priority_reason, is_auto_reply, created_at)
       VALUES (?, 'owner', ?, 'normal', 'Automated owner response', TRUE, ?)`,
      [sessionDbId, autoReplyText, now]
    );

    // 4. Commit transaction
    if (canTransact) await connection.commit();

    return {
      sent: true,
      messageId: insertResult.insertId,
      body: autoReplyText,
      status: currentStatus,
      createdAt: now.toISOString(),
    };
  } catch (err) {
    if (canTransact && typeof connection.rollback === 'function') {
      try { await connection.rollback(); } catch {}
    }
    if (logger?.error) {
      logger.error('Failed to process automatic reply', {
        sessionDbId,
        code: err?.code,
      });
    }
    throw err;
  } finally {
    if (typeof connection.release === 'function') {
      connection.release();
    }
  }
}
