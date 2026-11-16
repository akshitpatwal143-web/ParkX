import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { sanitizeDbErrorCode } from '../db.js';
import { wrapAsyncHandler } from '../asyncHandler.js';

const TOKEN_REGEX = /^pkx_[0-9a-fA-F]{64}$/;
const SESSION_ID_REGEX = /^vs_[0-9a-fA-F]{40,64}$/;
const CREDENTIAL_REGEX = /^vcred_[0-9a-fA-F]{64}$/;
const CLIENT_MESSAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_SESSION_TTL_HOURS = 24;

function sanitizeString(str) {
  return typeof str === 'string' ? str.trim() : '';
}

function extractVisitorCredential(req) {
  const headerCred = req.get('X-Visitor-Credential');
  if (headerCred && typeof headerCred === 'string') return headerCred.trim();
  const authHeader = req.get('Authorization');
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.body?.credential && typeof req.body.credential === 'string') {
    return req.body.credential.trim();
  }
  return '';
}

function compareHashes(hashA, hashB) {
  if (typeof hashA !== 'string' || typeof hashB !== 'string') return false;
  const bufA = Buffer.from(hashA, 'hex');
  const bufB = Buffer.from(hashB, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createPublicRouter({ pool, limiter, sessionCreateLimiter, sessionReadLimiter, messageCreateLimiter, logger, _testHook } = {}) {
  if (!pool) throw new Error('createPublicRouter requires a database pool');
  // Defense-in-depth: test hook is strictly disabled when NODE_ENV === 'production'
  const activeTestHook = process.env.NODE_ENV === 'production' ? null : _testHook;
  const router = Router();

  // Architectural Note on Rate Limiting:
  // Counters below use express-rate-limit's default in-memory MemoryStore.
  // Counters are process-local to the single Node.js runtime process.
  // This is safe and effective for single-instance deployments (such as Render's starter service).
  // Limitation: If ParkX is scaled horizontally across multiple instances or containers,
  // in-memory counters do not coordinate across instances. Before horizontal scaling,
  // a centralized shared store (such as Redis with rate-limit-redis) must be configured.

  // Rate limiter for public verification endpoint: 60 requests per 15 minutes per IP
  const defaultLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        status: 'rate_limited',
        message: 'Too many verification attempts. Please try again later.',
      });
    },
  });

  // Rate limiter for visitor session creation: 15 requests per 15 minutes per IP
  const defaultCreateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        status: 'rate_limited',
        message: 'Too many contact requests created. Please wait before trying again.',
      });
    },
  });

  // Rate limiter for reading/closing visitor sessions: 120 requests per 15 minutes per IP
  const defaultReadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        status: 'rate_limited',
        message: 'Too many session requests. Please wait a moment.',
      });
    },
  });

  // Rate limiter for visitor sending messages: 60 messages per 15 minutes per IP
  const defaultMessageLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        status: 'rate_limited',
        message: 'Too many messages sent. Please wait a moment before sending another.',
      });
    },
  });

  const verifyLimiter = limiter || defaultLimiter;
  const createLimiter = sessionCreateLimiter || defaultCreateLimiter;
  const readLimiter = sessionReadLimiter || defaultReadLimiter;
  const messageLimiter = messageCreateLimiter || defaultMessageLimiter;

  // ────────────────────────────────────────────────────────────
  // 1. GET /api/public/vehicles/:token — Verify QR pass telemetry
  // ────────────────────────────────────────────────────────────
  router.get('/vehicles/:token', verifyLimiter, wrapAsyncHandler(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    const rawToken = sanitizeString(req.params.token);

    if (!rawToken || !TOKEN_REGEX.test(rawToken)) {
      return res.status(400).json({
        status: 'invalid',
        message: 'Invalid or malformed QR pass token.',
      });
    }

    try {
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      const [rows] = await pool.query(
        `SELECT 
           q.status AS qr_status,
           v.vehicle_type,
           v.vehicle_model,
           v.color
         FROM qr_codes q
         JOIN vehicles v ON v.id = q.vehicle_id
         WHERE q.token_hash = ?
         LIMIT 1`,
        [tokenHash]
      );

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          status: 'invalid',
          message: 'QR pass unrecognized or does not exist.',
        });
      }

      const match = rows[0];

      if (match.qr_status === 'revoked') {
        return res.status(410).json({
          status: 'revoked',
          message: 'This ParkX pass has been revoked by the vehicle owner.',
        });
      }

      return res.status(200).json({
        status: 'valid',
        vehicle: {
          vehicleType: match.vehicle_type,
          vehicleModel: match.vehicle_model,
          color: match.color,
        },
      });
    } catch (err) {
      const safeCode = sanitizeDbErrorCode(err?.code);
      const logFn = logger && typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
      logFn('Public QR verification database error', { code: safeCode });
      return res.status(500).json({
        status: 'error',
        message: 'Verification service temporarily unavailable.',
      });
    }
  }));

  // ────────────────────────────────────────────────────────────
  // 2. POST /api/public/sessions — Create an anonymous visitor session
  // ────────────────────────────────────────────────────────────
  const handleCreateSession = wrapAsyncHandler(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    const rawToken = sanitizeString(req.body?.token || req.body?.qrToken || req.params?.token);

    if (!rawToken || !TOKEN_REGEX.test(rawToken)) {
      return res.status(400).json({
        status: 'invalid',
        message: 'A valid active QR pass token is required to contact the vehicle owner.',
      });
    }

    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    // Preliminary candidate vehicle discovery without locking
    let candidateVehicleId;
    try {
      const [candidateRows] = await pool.query(
        `SELECT vehicle_id, status FROM qr_codes WHERE token_hash = ? LIMIT 1`,
        [tokenHash]
      );

      if (!candidateRows || candidateRows.length === 0) {
        return res.status(404).json({
          status: 'invalid',
          message: 'QR pass unrecognized or does not exist.',
        });
      }

      if (candidateRows[0].status === 'revoked') {
        return res.status(410).json({
          status: 'revoked',
          message: 'This ParkX pass has been revoked by the vehicle owner.',
        });
      }

      candidateVehicleId = candidateRows[0].vehicle_id;
    } catch (err) {
      const safeCode = sanitizeDbErrorCode(err?.code);
      const logFn = logger && typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
      logFn('Visitor session candidate lookup error', { code: safeCode });
      return res.status(500).json({
        status: 'error',
        message: 'Unable to initiate contact session at this time. Please retry.',
      });
    }

    // Bounded retry transaction loop with standardized vehicle-first lock ordering
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Standardized lock ordering: Lock the corresponding VEHICLE row FIRST
        const [vehicleRows] = await connection.query(
          `SELECT id, vehicle_type, vehicle_model, color
           FROM vehicles
           WHERE id = ?
           FOR UPDATE`,
          [candidateVehicleId]
        );

        if (!vehicleRows || vehicleRows.length === 0) {
          await connection.rollback();
          return res.status(404).json({
            status: 'invalid',
            message: 'QR pass unrecognized or does not exist.',
          });
        }
        const lockedVehicle = vehicleRows[0];

        // 2. Lock and verify the QR row SECOND
        const [qrRows] = await connection.query(
          `SELECT id, status, vehicle_id
           FROM qr_codes
           WHERE token_hash = ? AND vehicle_id = ?
           FOR UPDATE`,
          [tokenHash, candidateVehicleId]
        );

        if (!qrRows || qrRows.length === 0) {
          await connection.rollback();
          return res.status(404).json({
            status: 'invalid',
            message: 'QR pass unrecognized or does not exist.',
          });
        }

        const lockedQr = qrRows[0];
        if (lockedQr.status === 'revoked') {
          await connection.rollback();
          return res.status(410).json({
            status: 'revoked',
            message: 'This ParkX pass has been revoked by the vehicle owner.',
          });
        }

        if (lockedQr.status !== 'active') {
          await connection.rollback();
          return res.status(400).json({
            status: 'invalid',
            message: 'This ParkX pass is not active.',
          });
        }

        // 3. Count active pending sessions for this vehicle inside the locked transaction
        const [pendingCountRows] = await connection.query(
          `SELECT COUNT(*) AS active_pending
           FROM visitor_sessions
           WHERE vehicle_id = ? AND status = 'pending' AND expires_at > NOW()`,
          [candidateVehicleId]
        );

        const activePending = Number(pendingCountRows[0]?.active_pending || 0);
        if (activePending >= 5) {
          await connection.rollback();
          return res.status(429).json({
            status: 'rate_limited',
            message: 'Active contact requests are already pending for this vehicle. Please wait before creating another.',
          });
        }

        // 4. Generate cryptographically secure visitor credentials
        const publicId = 'vs_' + randomBytes(24).toString('hex');
        const rawCredential = 'vcred_' + randomBytes(32).toString('hex');
        const credentialHash = createHash('sha256').update(rawCredential).digest('hex');

        const now = new Date();
        const expiresAt = new Date(now.getTime() + DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000);

        // 5. Insert visitor session record inside transaction
        await connection.query(
          `INSERT INTO visitor_sessions
             (public_id, vehicle_id, credential_hash, status, created_at, expires_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
          [publicId, candidateVehicleId, credentialHash, now, expiresAt]
        );

        await connection.commit();

        return res.status(201).json({
          status: 'pending',
          sessionId: publicId,
          visitorCredential: rawCredential,
          createdAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          vehicle: {
            vehicleType: lockedVehicle.vehicle_type,
            vehicleModel: lockedVehicle.vehicle_model,
            color: lockedVehicle.color,
          },
        });
      } catch (err) {
        if (connection) {
          try { await connection.rollback(); } catch {}
        }
        if (err?.code === 'ER_LOCK_DEADLOCK' && attempt < MAX_RETRIES - 1) {
          // Bounded retry with jittered backoff on deadlock
          await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
          continue;
        }

        const safeCode = sanitizeDbErrorCode(err?.code);
        const logFn = logger && typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
        logFn('Visitor session creation error', { code: safeCode });

        if (err?.code === 'ER_LOCK_DEADLOCK' || err?.code === 'ER_LOCK_WAIT_TIMEOUT') {
          return res.status(503).json({
            status: 'error',
            message: 'Contact service is temporarily busy. Please retry.',
          });
        }

        return res.status(500).json({
          status: 'error',
          message: 'Unable to initiate contact session at this time. Please retry.',
        });
      } finally {
        if (connection) {
          try { connection.release(); } catch {}
        }
      }
    }
  });

  router.post('/sessions', createLimiter, handleCreateSession);
  router.post('/vehicles/:token/sessions', createLimiter, handleCreateSession);

  // ────────────────────────────────────────────────────────────
  // 3. GET /api/public/sessions/:id — Retrieve own visitor session
  // ────────────────────────────────────────────────────────────
  router.get('/sessions/:id', readLimiter, wrapAsyncHandler(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    const sessionId = sanitizeString(req.params.id);
    if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
      return res.status(400).json({
        status: 'invalid',
        message: 'Invalid session identifier format.',
      });
    }

    const suppliedCredential = extractVisitorCredential(req);
    if (!suppliedCredential || !CREDENTIAL_REGEX.test(suppliedCredential)) {
      return res.status(401).json({
        status: 'unauthorized',
        message: 'Visitor credential is required to access this session.',
      });
    }

    try {
      const [rows] = await pool.query(
        `SELECT
           s.id,
           s.public_id,
           s.credential_hash,
           s.status,
           s.created_at,
           s.expires_at,
           s.accepted_at,
           s.closed_at,
           v.vehicle_type,
           v.vehicle_model,
           v.color
         FROM visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         WHERE s.public_id = ?
         LIMIT 1`,
        [sessionId]
      );

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          status: 'not_found',
          message: 'Contact session not found.',
        });
      }

      const sessionRow = rows[0];

      // Verify presented credential hash timing-safely
      const presentedHash = createHash('sha256').update(suppliedCredential).digest('hex');
      if (!compareHashes(sessionRow.credential_hash, presentedHash)) {
        return res.status(403).json({
          status: 'forbidden',
          message: 'Invalid visitor credential for this session.',
        });
      }

      // Check if session has expired
      let effectiveStatus = sessionRow.status;
      const isPastExpiry = new Date(sessionRow.expires_at).getTime() <= Date.now();
      if (isPastExpiry && sessionRow.status !== 'closed' && sessionRow.status !== 'expired') {
        effectiveStatus = 'expired';
        // Conditional update ensures we never overwrite 'closed'
        await pool.query(
          `UPDATE visitor_sessions
           SET status = 'expired'
           WHERE id = ? AND status IN ('pending', 'accepted') AND expires_at <= NOW()`,
          [sessionRow.id]
        );
      }

      return res.status(200).json({
        sessionId: sessionRow.public_id,
        status: effectiveStatus,
        createdAt: sessionRow.created_at,
        expiresAt: sessionRow.expires_at,
        acceptedAt: sessionRow.accepted_at,
        closedAt: sessionRow.closed_at,
        vehicle: {
          vehicleType: sessionRow.vehicle_type,
          vehicleModel: sessionRow.vehicle_model,
          color: sessionRow.color,
        },
      });
    } catch (err) {
      const safeCode = sanitizeDbErrorCode(err?.code);
      const logFn = logger && typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
      logFn('Visitor session retrieval error', { code: safeCode });
      return res.status(500).json({
        status: 'error',
        message: 'Session service temporarily unavailable.',
      });
    }
  }));

  // ────────────────────────────────────────────────────────────
  // 4. POST /api/public/sessions/:id/close — Visitor closes own session
  // ────────────────────────────────────────────────────────────
  router.post('/sessions/:id/close', readLimiter, wrapAsyncHandler(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    const sessionId = sanitizeString(req.params.id);
    if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
      return res.status(400).json({
        status: 'invalid',
        message: 'Invalid session identifier format.',
      });
    }

    const suppliedCredential = extractVisitorCredential(req);
    if (!suppliedCredential || !CREDENTIAL_REGEX.test(suppliedCredential)) {
      return res.status(401).json({
        status: 'unauthorized',
        message: 'Visitor credential is required to close this session.',
      });
    }

    let connection;
    try {
      connection = await pool.getConnection();
      if (typeof activeTestHook?.onConnectionAcquired === 'function') {
        await activeTestHook.onConnectionAcquired({
          route: 'visitor_close',
          sessionId,
          connection,
          processlistId: connection.threadId,
        });
      }
      await connection.beginTransaction();

      const [rows] = await connection.query(
        `SELECT id, public_id, credential_hash, status, expires_at, closed_at
         FROM visitor_sessions
         WHERE public_id = ?
         FOR UPDATE`,
        [sessionId]
      );

      if (!rows || rows.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          status: 'not_found',
          message: 'Contact session not found.',
        });
      }

      const sessionRow = rows[0];

      // Verify credential
      const presentedHash = createHash('sha256').update(suppliedCredential).digest('hex');
      if (!compareHashes(sessionRow.credential_hash, presentedHash)) {
        await connection.rollback();
        return res.status(403).json({
          status: 'forbidden',
          message: 'Invalid visitor credential for this session.',
        });
      }

      // Check current state before attempting conditional update
      if (sessionRow.status === 'closed') {
        await connection.rollback();
        return res.status(200).json({
          status: 'closed',
          message: 'Session is already closed.',
          closedAt: sessionRow.closed_at,
        });
      }

      const now = new Date();
      const isPastExpiry = new Date(sessionRow.expires_at).getTime() <= now.getTime();
      if (isPastExpiry || sessionRow.status === 'expired') {
        if (sessionRow.status !== 'expired') {
          await connection.query(
            `UPDATE visitor_sessions SET status = 'expired' WHERE id = ? AND status != 'closed'`,
            [sessionRow.id]
          );
          await connection.commit();
        } else {
          await connection.rollback();
        }
        return res.status(410).json({
          status: 'expired',
          message: 'Session has already expired and cannot be closed.',
        });
      }

      // Atomic conditional update ensuring status is pending or accepted and not expired
      const [updateResult] = await connection.query(
        `UPDATE visitor_sessions
         SET status = 'closed', closed_at = ?
         WHERE id = ? AND status IN ('pending', 'accepted') AND expires_at > ?`,
        [now, sessionRow.id, now]
      );

      if (updateResult?.affectedRows === 1) {
        await connection.commit();
        return res.status(200).json({
          status: 'closed',
          closedAt: now.toISOString(),
        });
      }

      // If affectedRows === 0, state changed concurrently. Inspect persisted outcome:
      const [refreshedRows] = await connection.query(
        `SELECT status, expires_at, closed_at FROM visitor_sessions WHERE id = ?`,
        [sessionRow.id]
      );
      const refreshed = refreshedRows[0];

      if (refreshed?.status === 'closed') {
        await connection.commit();
        return res.status(200).json({
          status: 'closed',
          message: 'Session is already closed.',
          closedAt: refreshed.closed_at,
        });
      }

      if (refreshed?.status === 'expired' || new Date(refreshed?.expires_at).getTime() <= now.getTime()) {
        await connection.query(
          `UPDATE visitor_sessions SET status = 'expired' WHERE id = ? AND status != 'closed'`,
          [sessionRow.id]
        );
        await connection.commit();
        return res.status(410).json({
          status: 'expired',
          message: 'Session has already expired and cannot be closed.',
        });
      }

      await connection.rollback();
      return res.status(400).json({
        status: refreshed?.status || 'invalid',
        message: 'Session cannot be closed in its current state.',
      });
    } catch (err) {
      if (connection) {
        try { await connection.rollback(); } catch {}
      }
      const safeCode = sanitizeDbErrorCode(err?.code);
      const logFn = logger && typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
      logFn('Visitor session close error', { code: safeCode });
      return res.status(500).json({
        status: 'error',
        message: 'Unable to close session at this time. Please retry.',
      });
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }));

  // ────────────────────────────────────────────────────────────
  // 5. POST /api/public/sessions/:id/messages — Visitor sends a message
  // ────────────────────────────────────────────────────────────
  router.post('/sessions/:id/messages', messageLimiter, wrapAsyncHandler(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    const sessionId = sanitizeString(req.params.id);
    if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
      return res.status(400).json({
        status: 'invalid',
        message: 'Invalid session identifier format.',
      });
    }

    const suppliedCredential = extractVisitorCredential(req);
    if (!suppliedCredential || !CREDENTIAL_REGEX.test(suppliedCredential)) {
      return res.status(401).json({
        status: 'unauthorized',
        message: 'Visitor credential is required to send messages.',
      });
    }

    if (typeof req.body?.body !== 'string') {
      return res.status(400).json({
        status: 'invalid',
        message: 'Message body is required.',
      });
    }

    const trimmedBody = req.body.body.trim();
    if (!trimmedBody) {
      return res.status(400).json({
        status: 'invalid',
        message: 'Message body cannot be empty.',
      });
    }

    if (trimmedBody.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        status: 'invalid',
        message: `Message body must not exceed ${MAX_MESSAGE_LENGTH} characters.`,
      });
    }

    let clientMessageId = null;
    if (req.body?.clientMessageId !== undefined && req.body?.clientMessageId !== null) {
      if (typeof req.body.clientMessageId !== 'string' || !CLIENT_MESSAGE_ID_REGEX.test(req.body.clientMessageId)) {
        return res.status(400).json({
          status: 'invalid',
          message: 'Invalid clientMessageId format.',
        });
      }
      clientMessageId = req.body.clientMessageId;
    }

    let connection;
    try {
      connection = await pool.getConnection();
      if (typeof activeTestHook?.onConnectionAcquired === 'function') {
        await activeTestHook.onConnectionAcquired({
          route: 'visitor_message',
          sessionId,
          connection,
          processlistId: connection.threadId,
        });
      }
      await connection.beginTransaction();

      const [rows] = await connection.query(
        `SELECT id, public_id, credential_hash, status, expires_at
         FROM visitor_sessions
         WHERE public_id = ?
         FOR UPDATE`,
        [sessionId]
      );

      if (!rows || rows.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          status: 'not_found',
          message: 'Contact session not found.',
        });
      }

      const sessionRow = rows[0];

      const presentedHash = createHash('sha256').update(suppliedCredential).digest('hex');
      if (!compareHashes(sessionRow.credential_hash, presentedHash)) {
        await connection.rollback();
        return res.status(403).json({
          status: 'forbidden',
          message: 'Invalid visitor credential for this session.',
        });
      }

      // Test-only synchronization hook: invoked while holding session row lock before commit
      if (typeof activeTestHook?.onMessageRowLocked === 'function') {
        await activeTestHook.onMessageRowLocked({
          route: 'visitor_message',
          sessionId: sessionRow.public_id,
          sessionDbId: sessionRow.id,
          connection,
          processlistId: connection.threadId,
        });
      }

      const now = new Date();
      const isPastExpiry = new Date(sessionRow.expires_at).getTime() <= now.getTime();
      if (isPastExpiry || sessionRow.status === 'expired') {
        if (sessionRow.status !== 'expired' && sessionRow.status !== 'closed') {
          await connection.query(
            `UPDATE visitor_sessions SET status = 'expired' WHERE id = ? AND status != 'closed'`,
            [sessionRow.id]
          );
          await connection.commit();
        } else {
          await connection.rollback();
        }
        return res.status(400).json({
          status: 'expired',
          message: 'Session has expired and cannot accept messages.',
        });
      }

      if (sessionRow.status === 'closed') {
        await connection.rollback();
        return res.status(400).json({
          status: 'closed',
          message: 'Session is closed and cannot accept messages.',
        });
      }

      if (sessionRow.status !== 'pending' && sessionRow.status !== 'accepted') {
        await connection.rollback();
        return res.status(400).json({
          status: sessionRow.status,
          message: 'Session cannot accept messages in its current state.',
        });
      }

      // If clientMessageId provided, handle idempotency
      if (clientMessageId) {
        try {
          const [insertResult] = await connection.query(
            `INSERT INTO visitor_messages (session_id, sender_type, body, client_message_id, created_at)
             VALUES (?, 'visitor', ?, ?, ?)`,
            [sessionRow.id, trimmedBody, clientMessageId, now]
          );

          await connection.commit();

          return res.status(201).json({
            status: 'sent',
            message: {
              id: insertResult.insertId,
              sessionId: sessionRow.public_id,
              senderType: 'visitor',
              body: trimmedBody,
              clientMessageId,
              createdAt: now.toISOString(),
            },
          });
        } catch (insertErr) {
          if (insertErr?.code === 'ER_DUP_ENTRY') {
            await connection.rollback();
            const [existingRows] = await pool.query(
              `SELECT id, session_id, sender_type, body, client_message_id, created_at
               FROM visitor_messages
               WHERE session_id = ? AND sender_type = 'visitor' AND client_message_id = ?
               LIMIT 1`,
              [sessionRow.id, clientMessageId]
            );
            if (existingRows.length > 0) {
              const existing = existingRows[0];
              return res.status(200).json({
                status: 'sent',
                message: {
                  id: existing.id,
                  sessionId: sessionRow.public_id,
                  senderType: existing.sender_type,
                  body: existing.body,
                  clientMessageId: existing.client_message_id,
                  createdAt: existing.created_at instanceof Date ? existing.created_at.toISOString() : existing.created_at,
                },
              });
            }
          }
          throw insertErr;
        }
      }

      // No clientMessageId: standard insert
      const [insertResult] = await connection.query(
        `INSERT INTO visitor_messages (session_id, sender_type, body, created_at)
         VALUES (?, 'visitor', ?, ?)`,
        [sessionRow.id, trimmedBody, now]
      );

      await connection.commit();

      return res.status(201).json({
        status: 'sent',
        message: {
          id: insertResult.insertId,
          sessionId: sessionRow.public_id,
          senderType: 'visitor',
          body: trimmedBody,
          clientMessageId: null,
          createdAt: now.toISOString(),
        },
      });
    } catch (err) {
      if (connection) {
        try { await connection.rollback(); } catch {}
      }
      const safeCode = sanitizeDbErrorCode(err?.code);
      const logFn = logger && typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
      logFn('Visitor message creation error', { code: safeCode });
      return res.status(500).json({
        status: 'error',
        message: 'Unable to send message at this time. Please retry.',
      });
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }));

  // ────────────────────────────────────────────────────────────
  // 6. GET /api/public/sessions/:id/messages — Visitor retrieves message history
  // ────────────────────────────────────────────────────────────
  router.get('/sessions/:id/messages', readLimiter, wrapAsyncHandler(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    const sessionId = sanitizeString(req.params.id);
    if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
      return res.status(400).json({
        status: 'invalid',
        message: 'Invalid session identifier format.',
      });
    }

    const suppliedCredential = extractVisitorCredential(req);
    if (!suppliedCredential || !CREDENTIAL_REGEX.test(suppliedCredential)) {
      return res.status(401).json({
        status: 'unauthorized',
        message: 'Visitor credential is required to access messages.',
      });
    }

    let afterId = 0;
    if (req.query.after !== undefined && req.query.after !== '') {
      const parsedAfter = Number(req.query.after);
      if (!Number.isInteger(parsedAfter) || parsedAfter < 0) {
        return res.status(400).json({
          status: 'invalid',
          message: 'Invalid after cursor; must be a non-negative integer.',
        });
      }
      afterId = parsedAfter;
    }

    let limit = 50;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      const parsedLimit = Number(req.query.limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        return res.status(400).json({
          status: 'invalid',
          message: 'Invalid limit; must be a positive integer.',
        });
      }
      limit = Math.min(parsedLimit, 100);
    }

    try {
      const [rows] = await pool.query(
        `SELECT id, public_id, credential_hash
         FROM visitor_sessions
         WHERE public_id = ?
         LIMIT 1`,
        [sessionId]
      );

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          status: 'not_found',
          message: 'Contact session not found.',
        });
      }

      const sessionRow = rows[0];

      const presentedHash = createHash('sha256').update(suppliedCredential).digest('hex');
      if (!compareHashes(sessionRow.credential_hash, presentedHash)) {
        return res.status(403).json({
          status: 'forbidden',
          message: 'Invalid visitor credential for this session.',
        });
      }

      const [msgRows] = await pool.query(
        `SELECT id, sender_type, body, client_message_id, created_at
         FROM visitor_messages
         WHERE session_id = ? AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
        [sessionRow.id, afterId, limit + 1]
      );

      const hasMore = msgRows.length > limit;
      const resultRows = hasMore ? msgRows.slice(0, limit) : msgRows;

      const messages = resultRows.map((r) => ({
        id: r.id,
        sessionId: sessionRow.public_id,
        senderType: r.sender_type,
        body: r.body,
        clientMessageId: r.client_message_id || null,
        createdAt: r.created_at,
      }));

      return res.status(200).json({
        sessionId: sessionRow.public_id,
        messages,
        hasMore,
      });
    } catch (err) {
      const safeCode = sanitizeDbErrorCode(err?.code);
      const logFn = logger && typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
      logFn('Visitor messages retrieval error', { code: safeCode });
      return res.status(500).json({
        status: 'error',
        message: 'Unable to retrieve messages at this time.',
      });
    }
  }));

  return router;
}

export default createPublicRouter;
