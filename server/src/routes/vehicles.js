import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { sanitizeDbErrorCode } from '../db.js';
import { wrapAsyncHandler } from '../asyncHandler.js';
import { DEFAULT_BUSY_MESSAGE, DEFAULT_AWAY_MESSAGE } from '../services/autoReply.js';

const ALLOWED_VEHICLE_TYPES = new Set(['car', 'suv', 'ev', 'motorcycle', 'truck', 'van', 'other']);
const MAX_REGISTRATION_RAW_LENGTH = 50;
const REGISTRATION_RE = /^[A-Za-z0-9 -]+$/;

function apiError(status, message, errors) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.validationErrors = errors;
  return error;
}

function sendError(res, error, logger = console) {
  const status = error.status || 500;
  const message = status >= 500 ? 'Internal server error' : error.publicMessage || 'Internal server error';
  if (status >= 500) {
    const safeCode = sanitizeDbErrorCode(error?.code);
    const meta = {
      code: safeCode,
      status,
    };
    if (typeof error?.errno === 'number' && Number.isSafeInteger(error.errno) && error.errno > 0 && error.errno < 65535) {
      meta.errno = error.errno;
    }
    const logFn = typeof logger?.error === 'function' ? logger.error.bind(logger) : console.error;
    logFn('Vehicle request failed', meta);
  }
  const body = { message };
  if (error.validationErrors) body.errors = error.validationErrors;
  return res.status(status).json(body);
}

function sanitizeText(value, maxLen = 100) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.slice(0, maxLen);
}

export function canonicalizeRegistrationNumber(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().replace(/[ -]+/g, '');
}

function validateVehicleInput(body, { isPatch = false } = {}) {
  const errors = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw apiError(400, 'Validation failed', { body: 'Request body must be a JSON object' });
  }

  let registrationNumber = undefined;
  if (!isPatch || body.registration_number !== undefined) {
    const rawRegistration = body.registration_number;
    if (typeof rawRegistration !== 'string' || !rawRegistration.trim()) {
      errors.registration_number = 'Registration number is required';
    } else if (rawRegistration.length > MAX_REGISTRATION_RAW_LENGTH) {
      errors.registration_number = `Registration number must be at most ${MAX_REGISTRATION_RAW_LENGTH} raw characters`;
    } else if (!REGISTRATION_RE.test(rawRegistration.trim())) {
      errors.registration_number = 'Use ASCII letters, digits, spaces, and hyphens only';
    } else {
      registrationNumber = canonicalizeRegistrationNumber(rawRegistration);
    }
    if (!errors.registration_number && (registrationNumber.length < 2 || registrationNumber.length > MAX_REGISTRATION_RAW_LENGTH)) {
      errors.registration_number = 'Registration number must be between 2 and 50 characters';
    }
  }

  let vehicleType = undefined;
  if (!isPatch || body.vehicle_type !== undefined) {
    const rawType = (body.vehicle_type || '').toString().trim().toLowerCase();
    if (!rawType) errors.vehicle_type = 'Vehicle type is required';
    else if (!ALLOWED_VEHICLE_TYPES.has(rawType)) {
      errors.vehicle_type = `Vehicle type must be one of: ${[...ALLOWED_VEHICLE_TYPES].join(', ')}`;
    } else {
      vehicleType = rawType;
    }
  }

  let vehicleModel = undefined;
  if (!isPatch || body.vehicle_model !== undefined) {
    vehicleModel = sanitizeText(body.vehicle_model, 100);
    if (!vehicleModel) errors.vehicle_model = 'Vehicle model is required';
    else if (vehicleModel.length < 2) errors.vehicle_model = 'Vehicle model must be at least 2 characters';
  }

  let color = undefined;
  if (!isPatch || body.color !== undefined) {
    color = sanitizeText(body.color, 50);
    if (!color) errors.color = 'Color is required';
    else if (color.length < 2) errors.color = 'Color must be at least 2 characters';
  }

  if (Object.keys(errors).length) throw apiError(400, 'Validation failed', errors);

  return { registrationNumber, vehicleType, vehicleModel, color };
}

function vehicleDTO(row, qrCode = null) {
  const dto = {
    id: row.id,
    userId: row.user_id,
    registrationNumber: row.registration_number,
    vehicleType: row.vehicle_type,
    vehicleModel: row.vehicle_model,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (qrCode) {
    dto.qrCode = qrCode;
  }
  return dto;
}

const SESSION_ID_REGEX = /^vs_[0-9a-fA-F]{40,64}$/;
const CLIENT_MESSAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MESSAGE_LENGTH = 2000;

function ownerSessionDTO(row) {
  const isPastExpiry = row.status !== 'closed' && new Date(row.expires_at).getTime() <= Date.now();
  const effectiveStatus = isPastExpiry ? 'expired' : row.status;
  return {
    sessionId: row.public_id,
    vehicleId: row.vehicle_id,
    status: effectiveStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    closedAt: row.closed_at,
    priority: row.session_priority || 'normal',
    priorityOverridden: Boolean(row.priority_overridden),
    vehicle: {
      id: row.vehicle_id,
      registrationNumber: row.registration_number,
      vehicleType: row.vehicle_type,
      vehicleModel: row.vehicle_model,
      color: row.color,
    },
    messageCount: Number(row.message_count || 0),
    unreadCount: Number(row.unread_count || 0),
    ownerLastReadMessageId: row.owner_last_read_message_id ? Number(row.owner_last_read_message_id) : null,
    lastMessage: row.last_message_body ? {
      body: row.last_message_body,
      senderType: row.last_message_sender,
      isAutoReply: Boolean(row.last_message_is_auto_reply),
      priority: row.last_message_priority || 'normal',
      createdAt: row.last_message_created_at,
    } : null,
  };
}

function generateSecureToken() {
  const rawToken = 'pkx_' + randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  return next();
}

function requireCsrf(origins) {
  const allowed = new Set(origins || []);
  return (req, res, next) => {
    // If origins are configured, verify Origin header
    if (allowed.size > 0) {
      const origin = req.get('Origin');
      if (!origin || !allowed.has(origin)) {
        return res.status(403).json({ message: 'Invalid or missing Origin header' });
      }
    }
    const supplied = req.get('X-CSRF-Token') || '';
    const expected = req.session?.csrfToken || '';
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    if (!expected || suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
      return res.status(403).json({ message: 'Invalid CSRF token' });
    }
    return next();
  };
}

export function createVehiclesRouter({ pool, origins, logger = console, ownerMessageLimiter, _testHook } = {}) {
  if (!pool) throw new Error('createVehiclesRouter requires a database pool');
  // Defense-in-depth: test hook is strictly disabled when NODE_ENV === 'production'
  const activeTestHook = process.env.NODE_ENV === 'production' ? null : _testHook;
  const router = Router();
  const csrf = requireCsrf(origins);

  const defaultOwnerMessageLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session?.userId || req.sessionID || req.ip || 'unknown'),
    validate: { xForwardedForHeader: false, default: false },
    handler: (_req, res) => res.status(429).json({
      status: 'rate_limited',
      message: 'Too many messages sent. Please wait before sending more.',
    }),
  });

  const messageLimiter = ownerMessageLimiter || defaultOwnerMessageLimiter;

  // All vehicle routes require authentication
  router.use(requireAuth);

  // ────────────────────────────────────────────────────────────
  // GET /api/vehicles — List authenticated owner's vehicles
  // ────────────────────────────────────────────────────────────
  router.get('/', wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const [rows] = await pool.query(
        `SELECT 
           v.*,
           q.id AS active_qr_id,
           q.status AS active_qr_status,
           q.created_at AS active_qr_created_at
         FROM vehicles v
         LEFT JOIN qr_codes q ON q.vehicle_id = v.id AND q.status = 'active'
         WHERE v.user_id = ?
         ORDER BY v.created_at DESC`,
        [userId]
      );

      const vehicles = rows.map((row) => {
        const qr = row.active_qr_id
          ? { id: row.active_qr_id, status: row.active_qr_status, createdAt: row.active_qr_created_at }
          : null;
        return vehicleDTO(row, qr);
      });

      return res.json({ vehicles });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }));

  // ────────────────────────────────────────────────────────────
  // POST /api/vehicles — Register a new vehicle
  // ────────────────────────────────────────────────────────────
  router.post('/', csrf, wrapAsyncHandler(async (req, res) => {
    let connection;
    try {
      const userId = req.session.userId;
      const { registrationNumber, vehicleType, vehicleModel, color } = validateVehicleInput(req.body);

      // Check duplicate registration number
      const [existing] = await pool.query(
        'SELECT id FROM vehicles WHERE registration_number = ? LIMIT 1',
        [registrationNumber]
      );
      if (existing.length) {
        return res.status(409).json({ message: 'A vehicle with this registration number is already registered' });
      }

      connection = await pool.getConnection();
      await connection.beginTransaction();
      let insertResult;
      try {
        [insertResult] = await connection.query(
          `INSERT INTO vehicles (user_id, registration_number, vehicle_type, vehicle_model, color)
           VALUES (?, ?, ?, ?, ?)`,
          [userId, registrationNumber, vehicleType, vehicleModel, color]
        );
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          await connection.rollback();
          return res.status(409).json({ message: 'A vehicle with this registration number is already registered' });
        }
        throw err;
      }

      const vehicleId = insertResult.insertId;

      // 2. Generate cryptographically random QR token & hash
      const { rawToken, tokenHash } = generateSecureToken();

      const [qrResult] = await connection.query(
        `INSERT INTO qr_codes (vehicle_id, token_hash, status, active_vehicle_id) VALUES (?, ?, 'active', ?)`,
        [vehicleId, tokenHash, vehicleId]
      );

      await connection.commit();

      // Fetch inserted record
      const [rows] = await pool.query('SELECT * FROM vehicles WHERE id = ?', [vehicleId]);
      const createdVehicle = rows[0];

      const qrPayload = {
        id: qrResult.insertId,
        status: 'active',
        // Opaque token returned ONLY upon generation to the authenticated owner:
        token: rawToken,
        createdAt: new Date().toISOString(),
      };

      return res.status(201).json({
        message: 'Vehicle registered successfully',
        vehicle: vehicleDTO(createdVehicle, qrPayload),
      });
    } catch (error) {
      if (connection) {
        try { await connection.rollback(); } catch {}
      }
      return sendError(res, error, logger);
    } finally {
      if (connection) connection.release();
    }
  }));

  // ────────────────────────────────────────────────────────────
  // GET /api/vehicles/sessions — List incoming visitor contact sessions
  // ────────────────────────────────────────────────────────────
  router.get(['/sessions', '/sessions/inbox'], wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const vehicleIdFilter = req.query.vehicleId ? Number(req.query.vehicleId) : null;
      const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : null;
      const priorityFilter = typeof req.query.priority === 'string' ? req.query.priority.trim().toLowerCase() : null;

      let query = `
        SELECT s.id, s.public_id, s.vehicle_id, s.status, s.created_at, s.expires_at, s.accepted_at, s.closed_at,
               s.session_priority, s.priority_overridden,
               s.owner_last_read_message_id,
               v.registration_number, v.vehicle_type, v.vehicle_model, v.color,
               lm.body AS last_message_body,
               lm.sender_type AS last_message_sender,
               lm.is_auto_reply AS last_message_is_auto_reply,
               lm.priority AS last_message_priority,
               lm.created_at AS last_message_created_at,
               COALESCE(mc.msg_count, 0) AS message_count,
               COALESCE(uc.unread_count, 0) AS unread_count
        FROM visitor_sessions s
        JOIN vehicles v ON v.id = s.vehicle_id
        LEFT JOIN (
          SELECT session_id, COUNT(*) AS msg_count
          FROM visitor_messages
          GROUP BY session_id
        ) mc ON mc.session_id = s.id
        LEFT JOIN (
          SELECT vm.session_id, COUNT(*) AS unread_count
          FROM visitor_messages vm
          JOIN visitor_sessions vs ON vs.id = vm.session_id
          WHERE vm.sender_type = 'visitor'
            AND (vs.owner_last_read_message_id IS NULL OR vm.id > vs.owner_last_read_message_id)
          GROUP BY vm.session_id
        ) uc ON uc.session_id = s.id
        LEFT JOIN (
          SELECT m1.session_id, m1.body, m1.sender_type, m1.is_auto_reply, m1.priority, m1.created_at
          FROM visitor_messages m1
          JOIN (
            SELECT session_id, MAX(id) AS max_id
            FROM visitor_messages
            GROUP BY session_id
          ) m2 ON m1.id = m2.max_id
        ) lm ON lm.session_id = s.id
        WHERE v.user_id = ?
      `;
      const params = [userId];

      if (vehicleIdFilter && Number.isInteger(vehicleIdFilter) && vehicleIdFilter > 0) {
        query += ' AND s.vehicle_id = ?';
        params.push(vehicleIdFilter);
      }
      if (statusFilter && ['pending', 'accepted', 'closed', 'expired'].includes(statusFilter)) {
        query += ' AND s.status = ?';
        params.push(statusFilter);
      }
      if (priorityFilter && ['urgent', 'high', 'normal', 'low'].includes(priorityFilter)) {
        query += ' AND s.session_priority = ?';
        params.push(priorityFilter);
      }

      query += " ORDER BY FIELD(s.session_priority, 'urgent', 'high', 'normal', 'low'), COALESCE(lm.created_at, s.created_at) DESC LIMIT 100";

      const [rows] = await pool.query(query, params);
      return res.json({ sessions: rows.map(ownerSessionDTO) });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }));

  // ────────────────────────────────────────────────────────────
  // GET /api/vehicles/availability — Retrieve owner availability & auto-reply config
  // ────────────────────────────────────────────────────────────
  router.get('/availability', wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const [rows] = await pool.query(
        `SELECT availability_status, auto_reply_enabled, auto_reply_busy, auto_reply_away, availability_updated_at
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [userId]
      );
      if (!rows.length) {
        return res.status(404).json({ message: 'User not found' });
      }
      const user = rows[0];
      return res.json({
        status: user.availability_status || 'available',
        autoReplyEnabled: Boolean(user.auto_reply_enabled),
        autoReplyBusy: user.auto_reply_busy || DEFAULT_BUSY_MESSAGE,
        autoReplyAway: user.auto_reply_away || DEFAULT_AWAY_MESSAGE,
        updatedAt: user.availability_updated_at,
      });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }));

  // ────────────────────────────────────────────────────────────
  // PATCH /api/vehicles/availability — Update owner availability & auto-reply config
  // ────────────────────────────────────────────────────────────
  router.patch('/availability', csrf, wrapAsyncHandler(async (req, res) => {
    const userId = req.session.userId;
    const body = req.body || {};

    const hasAnyField = body.status !== undefined || body.autoReplyEnabled !== undefined || body.autoReplyBusy !== undefined || body.autoReplyAway !== undefined;
    if (!hasAnyField) {
      return res.status(400).json({ message: 'No valid fields provided for update' });
    }

    let validatedStatus = null;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string') {
        return res.status(400).json({ message: 'Status must be a string' });
      }
      const rawStatus = body.status.toLowerCase().trim();
      if (!['available', 'busy', 'away'].includes(rawStatus)) {
        return res.status(400).json({ message: 'Status must be one of: available, busy, away' });
      }
      validatedStatus = rawStatus;
    }

    if (body.autoReplyEnabled !== undefined) {
      if (typeof body.autoReplyEnabled !== 'boolean') {
        return res.status(400).json({ message: 'autoReplyEnabled must be a boolean (true or false)' });
      }
    }

    let sanitizedBusy = null;
    if (body.autoReplyBusy !== undefined) {
      if (typeof body.autoReplyBusy !== 'string') {
        return res.status(400).json({ message: 'Busy auto-reply message must be a string' });
      }
      sanitizedBusy = sanitizeText(body.autoReplyBusy, 500);
      if (!sanitizedBusy) {
        return res.status(400).json({ message: 'Busy auto-reply message cannot be empty' });
      }
    }

    let sanitizedAway = null;
    if (body.autoReplyAway !== undefined) {
      if (typeof body.autoReplyAway !== 'string') {
        return res.status(400).json({ message: 'Away auto-reply message must be a string' });
      }
      sanitizedAway = sanitizeText(body.autoReplyAway, 500);
      if (!sanitizedAway) {
        return res.status(400).json({ message: 'Away auto-reply message cannot be empty' });
      }
    }

    let connection;
    try {
      connection = typeof pool.getConnection === 'function' ? await pool.getConnection() : pool;
      const canTransact = typeof connection.beginTransaction === 'function';
      if (canTransact) await connection.beginTransaction();

      // 1. Lock the user row to inspect current availability_status under row lock
      const [userRows] = await connection.query(
        `SELECT id, availability_status, availability_version
         FROM users
         WHERE id = ?
         FOR UPDATE`,
        [userId]
      );

      if (!userRows || userRows.length === 0) {
        if (canTransact && typeof connection.rollback === 'function') await connection.rollback();
        return res.status(404).json({ message: 'User not found' });
      }

      const currentUser = userRows[0];
      const updates = [];
      const params = [];

      if (validatedStatus !== null) {
        // Increment availability_version ONLY when the requested status actually differs from stored status
        if (validatedStatus !== currentUser.availability_status) {
          updates.push('availability_status = ?');
          params.push(validatedStatus);
          updates.push('availability_version = availability_version + 1');
        }
      }

      if (body.autoReplyEnabled !== undefined) {
        updates.push('auto_reply_enabled = ?');
        params.push(body.autoReplyEnabled);
      }

      if (sanitizedBusy !== null) {
        updates.push('auto_reply_busy = ?');
        params.push(sanitizedBusy);
      }

      if (sanitizedAway !== null) {
        updates.push('auto_reply_away = ?');
        params.push(sanitizedAway);
      }

      // If changes occurred, execute update query
      if (updates.length > 0) {
        params.push(userId);
        await connection.query(
          `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
          params
        );
      }

      if (canTransact) await connection.commit();

      const [rows] = await connection.query(
        `SELECT availability_status, auto_reply_enabled, auto_reply_busy, auto_reply_away, availability_updated_at
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [userId]
      );

      const updated = rows[0];
      return res.json({
        status: updated.availability_status || 'available',
        autoReplyEnabled: Boolean(updated.auto_reply_enabled),
        autoReplyBusy: updated.auto_reply_busy || DEFAULT_BUSY_MESSAGE,
        autoReplyAway: updated.auto_reply_away || DEFAULT_AWAY_MESSAGE,
        updatedAt: updated.availability_updated_at,
      });
    } catch (error) {
      if (connection && typeof connection.rollback === 'function') {
        try { await connection.rollback(); } catch {}
      }
      return sendError(res, error, logger);
    } finally {
      if (connection && typeof connection.release === 'function') {
        connection.release();
      }
    }
  }));

  // ────────────────────────────────────────────────────────────
  // GET /api/vehicles/notifications — Retrieve unread message summary
  // ────────────────────────────────────────────────────────────
  router.get('/notifications', wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const [rows] = await pool.query(
        `SELECT s.id, s.public_id AS session_id, s.vehicle_id, s.status, s.expires_at,
                v.registration_number, v.vehicle_type, v.vehicle_model,
                COALESCE(uc.unread_count, 0) AS unread_count,
                uc.latest_unread_at
         FROM visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         JOIN (
           SELECT vm.session_id,
                  COUNT(*) AS unread_count,
                  MAX(vm.created_at) AS latest_unread_at
           FROM visitor_messages vm
           JOIN visitor_sessions vs ON vs.id = vm.session_id
           WHERE vm.sender_type = 'visitor'
             AND (vs.owner_last_read_message_id IS NULL OR vm.id > vs.owner_last_read_message_id)
           GROUP BY vm.session_id
         ) uc ON uc.session_id = s.id
         WHERE v.user_id = ? AND uc.unread_count > 0
         ORDER BY uc.latest_unread_at DESC`,
        [userId]
      );

      let totalUnreadCount = 0;
      const unreadSessions = rows.map((r) => {
        const count = Number(r.unread_count || 0);
        totalUnreadCount += count;
        const isPastExpiry = r.status !== 'closed' && new Date(r.expires_at).getTime() <= Date.now();
        const effectiveStatus = isPastExpiry ? 'expired' : r.status;
        return {
          sessionId: r.session_id,
          vehicleId: r.vehicle_id,
          registrationNumber: r.registration_number,
          vehicleType: r.vehicle_type,
          vehicleModel: r.vehicle_model,
          status: effectiveStatus,
          unreadCount: count,
          lastMessageAt: r.latest_unread_at,
        };
      });

      return res.json({
        totalUnreadCount,
        sessions: unreadSessions,
      });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }));

  // ────────────────────────────────────────────────────────────
  // POST /api/vehicles/sessions/:sessionId/read — Mark conversation as read
  // ────────────────────────────────────────────────────────────
  router.post('/sessions/:sessionId/read', csrf, wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const sessionId = req.params.sessionId;
      if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
        return res.status(400).json({ message: 'Invalid session ID format' });
      }

      const [sessions] = await pool.query(
        `SELECT s.id, s.public_id, s.owner_last_read_message_id
         FROM visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         WHERE s.public_id = ? AND v.user_id = ?
         LIMIT 1`,
        [sessionId, userId]
      );

      if (!sessions || sessions.length === 0) {
        return res.status(404).json({ message: 'Session not found' });
      }

      const sessionRow = sessions[0];

      const [maxRows] = await pool.query(
        `SELECT COALESCE(MAX(id), 0) AS max_id
         FROM visitor_messages
         WHERE session_id = ?`,
        [sessionRow.id]
      );
      const maxId = Number(maxRows[0]?.max_id || 0);

      let targetId = maxId;
      if (req.body?.messageId !== undefined && req.body?.messageId !== null) {
        const parsed = Number(req.body.messageId);
        if (Number.isInteger(parsed) && parsed > 0) {
          targetId = Math.min(parsed, maxId);
        }
      }

      if (targetId > 0) {
        await pool.query(
          `UPDATE visitor_sessions
           SET owner_last_read_message_id = GREATEST(COALESCE(owner_last_read_message_id, 0), ?)
           WHERE id = ?`,
          [targetId, sessionRow.id]
        );
      }

      const [updatedRows] = await pool.query(
        `SELECT s.owner_last_read_message_id,
                COALESCE((
                  SELECT COUNT(*)
                  FROM visitor_messages vm
                  WHERE vm.session_id = s.id
                    AND vm.sender_type = 'visitor'
                    AND (s.owner_last_read_message_id IS NULL OR vm.id > s.owner_last_read_message_id)
                ), 0) AS unread_count
         FROM visitor_sessions s
         WHERE s.id = ?`,
        [sessionRow.id]
      );

      const updatedRow = updatedRows[0];
      return res.json({
        status: 'ok',
        sessionId,
        unreadCount: Number(updatedRow?.unread_count || 0),
        ownerLastReadMessageId: updatedRow?.owner_last_read_message_id
          ? Number(updatedRow.owner_last_read_message_id)
          : null,
      });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }));

  // ────────────────────────────────────────────────────────────
  // PATCH /api/vehicles/sessions/:sessionId/priority — Manual priority override
  // ────────────────────────────────────────────────────────────
  router.patch('/sessions/:sessionId/priority', csrf, wrapAsyncHandler(async (req, res) => {
    let connection;
    try {
      const userId = req.session.userId;
      const sessionId = req.params.sessionId;
      if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
        return res.status(400).json({ message: 'Invalid session ID format' });
      }

      const priority = String(req.body?.priority || '').toLowerCase().trim();
      if (!['urgent', 'high', 'normal', 'low'].includes(priority)) {
        return res.status(400).json({ message: 'Priority must be one of: urgent, high, normal, low' });
      }

      connection = typeof pool.getConnection === 'function' ? await pool.getConnection() : pool;
      const canTransact = typeof connection.beginTransaction === 'function';
      if (canTransact) await connection.beginTransaction();

      // Verify owner access to this session with FOR UPDATE
      const [sessions] = await connection.query(
        `SELECT s.id, s.public_id
         FROM visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         WHERE s.public_id = ? AND v.user_id = ?
         FOR UPDATE`,
        [sessionId, userId]
      );

      if (!sessions || sessions.length === 0) {
        if (canTransact && typeof connection.rollback === 'function') await connection.rollback();
        return res.status(404).json({ message: 'Contact session not found' });
      }

      const sessionRow = sessions[0];

      // If a specific messageId is given, override that message's priority as well
      if (req.body?.messageId !== undefined && req.body?.messageId !== null) {
        const messageId = Number(req.body.messageId);
        if (!Number.isInteger(messageId) || messageId <= 0) {
          if (canTransact && typeof connection.rollback === 'function') await connection.rollback();
          return res.status(400).json({ message: 'Invalid message ID format' });
        }
        const [msgResult] = await connection.query(
          `UPDATE visitor_messages
           SET priority = ?, priority_reason = 'Manually overridden by owner', priority_overridden = TRUE
           WHERE id = ? AND session_id = ?`,
          [priority, messageId, sessionRow.id]
        );
        if (msgResult.affectedRows === 0) {
          if (canTransact && typeof connection.rollback === 'function') await connection.rollback();
          return res.status(404).json({ message: 'Message not found in this session' });
        }
      }

      // Update session_priority and set priority_overridden = TRUE
      await connection.query(
        `UPDATE visitor_sessions
         SET session_priority = ?, priority_overridden = TRUE
         WHERE id = ?`,
        [priority, sessionRow.id]
      );

      if (canTransact) await connection.commit();

      return res.json({
        status: 'ok',
        sessionId,
        priority,
        priorityOverridden: true,
      });
    } catch (error) {
      if (connection && typeof connection.rollback === 'function') {
        try { await connection.rollback(); } catch {}
      }
      return sendError(res, error, logger);
    } finally {
      if (connection && typeof connection.release === 'function') {
        connection.release();
      }
    }
  }));

  // ────────────────────────────────────────────────────────────
  // POST /api/vehicles/sessions/:sessionId/accept — Accept visitor request
  // ────────────────────────────────────────────────────────────
  router.post('/sessions/:sessionId/accept', csrf, wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const sessionId = req.params.sessionId;
      if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
        return res.status(400).json({ message: 'Invalid session ID format' });
      }

      const now = new Date();

      // Atomic conditional update with ownership join:
      // Accepts only currently pending, unexpired sessions for vehicles owned by this user
      const [updateResult] = await pool.query(
        `UPDATE visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         SET s.status = 'accepted', s.accepted_at = ?
         WHERE s.public_id = ?
           AND v.user_id = ?
           AND s.status = 'pending'
           AND s.expires_at > ?`,
        [now, sessionId, userId, now]
      );

      if (updateResult?.affectedRows === 1) {
        return res.json({
          status: 'accepted',
          sessionId,
          acceptedAt: now.toISOString(),
        });
      }

      // If affectedRows === 0, investigate current persisted state preserving strict ownership check
      const [rows] = await pool.query(
        `SELECT s.id, s.public_id, s.status, s.expires_at, s.accepted_at, s.closed_at
         FROM visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         WHERE s.public_id = ? AND v.user_id = ?
         LIMIT 1`,
        [sessionId, userId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: 'Contact session not found' });
      }

      const session = rows[0];

      if (session.status === 'accepted') {
        return res.json({
          status: 'accepted',
          sessionId: session.public_id,
          message: 'Session is already accepted',
          acceptedAt: session.accepted_at,
        });
      }

      if (session.status === 'closed') {
        return res.status(400).json({ status: 'closed', message: 'Cannot accept a closed session' });
      }

      const isPastExpiry = new Date(session.expires_at).getTime() <= now.getTime();
      if (isPastExpiry || session.status === 'expired') {
        if (session.status !== 'expired') {
          await pool.query(
            `UPDATE visitor_sessions SET status = 'expired' WHERE id = ? AND status != 'closed'`,
            [session.id]
          );
        }
        return res.status(400).json({ status: 'expired', message: 'Cannot accept an expired session' });
      }

      return res.status(400).json({
        status: session.status,
        message: 'Session cannot be accepted in its current state',
      });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }));

  // ────────────────────────────────────────────────────────────
  // POST /api/vehicles/sessions/:sessionId/close — Owner closes session
  // ────────────────────────────────────────────────────────────
  router.post('/sessions/:sessionId/close', csrf, wrapAsyncHandler(async (req, res) => {
    let connection;
    try {
      const userId = req.session.userId;
      const sessionId = req.params.sessionId;
      if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
        return res.status(400).json({ message: 'Invalid session ID format' });
      }

      connection = await pool.getConnection();
      if (typeof activeTestHook?.onConnectionAcquired === 'function') {
        await activeTestHook.onConnectionAcquired({
          route: 'owner_close',
          sessionId,
          connection,
          processlistId: connection.threadId,
        });
      }
      await connection.beginTransaction();

      const [rows] = await connection.query(
        `SELECT s.id, s.public_id, s.status, s.expires_at, s.closed_at
         FROM visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         WHERE s.public_id = ? AND v.user_id = ?
         FOR UPDATE OF s`,
        [sessionId, userId]
      );

      if (!rows.length) {
        await connection.rollback();
        return res.status(404).json({ message: 'Contact session not found' });
      }

      const session = rows[0];

      if (session.status === 'closed') {
        await connection.rollback();
        return res.json({
          status: 'closed',
          sessionId: session.public_id,
          message: 'Session is already closed',
          closedAt: session.closed_at,
        });
      }

      const now = new Date();
      const isPastExpiry = new Date(session.expires_at).getTime() <= now.getTime();
      if (isPastExpiry || session.status === 'expired') {
        if (session.status !== 'expired') {
          await connection.query(
            `UPDATE visitor_sessions SET status = 'expired' WHERE id = ? AND status != 'closed'`,
            [session.id]
          );
          await connection.commit();
        } else {
          await connection.rollback();
        }
        return res.status(400).json({ status: 'expired', message: 'Session has already expired and cannot be closed' });
      }

      if (session.status !== 'pending' && session.status !== 'accepted') {
        await connection.rollback();
        return res.status(400).json({
          status: session.status,
          message: 'Session cannot be closed in its current state',
        });
      }

      const [updateResult] = await connection.query(
        `UPDATE visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         SET s.status = 'closed', s.closed_at = ?
         WHERE s.public_id = ?
           AND v.user_id = ?
           AND s.status IN ('pending', 'accepted')
           AND s.expires_at > ?`,
        [now, sessionId, userId, now]
      );

      if (updateResult?.affectedRows === 1) {
        await connection.commit();
        return res.json({
          status: 'closed',
          sessionId,
          closedAt: now.toISOString(),
        });
      }

      // If affectedRows === 0, state changed concurrently. Inspect persisted outcome:
      const [refreshedRows] = await connection.query(
        `SELECT s.id, s.public_id, s.status, s.expires_at, s.closed_at
         FROM visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         WHERE s.public_id = ? AND v.user_id = ?
         LIMIT 1`,
        [sessionId, userId]
      );

      if (!refreshedRows.length) {
        await connection.rollback();
        return res.status(404).json({ message: 'Contact session not found' });
      }

      const refreshed = refreshedRows[0];

      if (refreshed.status === 'closed') {
        await connection.commit();
        return res.json({
          status: 'closed',
          sessionId: refreshed.public_id,
          message: 'Session is already closed',
          closedAt: refreshed.closed_at,
        });
      }

      if (refreshed.status === 'expired' || new Date(refreshed.expires_at).getTime() <= now.getTime()) {
        await connection.query(
          `UPDATE visitor_sessions SET status = 'expired' WHERE id = ? AND status != 'closed'`,
          [refreshed.id]
        );
        await connection.commit();
        return res.status(400).json({ status: 'expired', message: 'Session has already expired and cannot be closed' });
      }

      await connection.rollback();
      return res.status(400).json({
        status: refreshed.status,
        message: 'Session cannot be closed in its current state',
      });
    } catch (error) {
      if (connection) {
        try { await connection.rollback(); } catch {}
      }
      return sendError(res, error, logger);
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }));

  // ────────────────────────────────────────────────────────────
  // GET /api/vehicles/sessions/:sessionId/messages — Owner retrieve message history
  // ────────────────────────────────────────────────────────────
  router.get('/sessions/:sessionId/messages', wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const sessionId = req.params.sessionId;
      if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
        return res.status(400).json({ message: 'Invalid session ID format' });
      }

      let afterId = 0;
      if (req.query.after !== undefined && req.query.after !== '') {
        const parsedAfter = Number(req.query.after);
        if (!Number.isInteger(parsedAfter) || parsedAfter < 0) {
          return res.status(400).json({ message: 'Invalid after cursor; must be a non-negative integer' });
        }
        afterId = parsedAfter;
      }

      let limit = 50;
      if (req.query.limit !== undefined && req.query.limit !== '') {
        const parsedLimit = Number(req.query.limit);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
          return res.status(400).json({ message: 'Invalid limit; must be a positive integer' });
        }
        limit = Math.min(parsedLimit, 100);
      }

      // Verify owner access via vehicle ownership join
      const [rows] = await pool.query(
        `SELECT s.id, s.public_id, s.status, s.expires_at
         FROM visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         WHERE s.public_id = ? AND v.user_id = ?
         LIMIT 1`,
        [sessionId, userId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: 'Contact session not found' });
      }

      const session = rows[0];

      const [msgRows] = await pool.query(
        `SELECT id, sender_type, body, client_message_id, created_at,
                priority, priority_reason, priority_overridden, is_auto_reply
         FROM visitor_messages
         WHERE session_id = ? AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
        [session.id, afterId, limit + 1]
      );

      const hasMore = msgRows.length > limit;
      const resultRows = hasMore ? msgRows.slice(0, limit) : msgRows;

      const messages = resultRows.map((r) => ({
        id: r.id,
        sessionId: session.public_id,
        senderType: r.sender_type,
        body: r.body,
        clientMessageId: r.client_message_id || null,
        priority: r.priority || 'normal',
        priorityReason: r.priority_reason || null,
        isAutoReply: Boolean(r.is_auto_reply),
        createdAt: r.created_at,
      }));

      return res.json({
        sessionId: session.public_id,
        messages,
        hasMore,
      });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }));

  // ────────────────────────────────────────────────────────────
  // POST /api/vehicles/sessions/:sessionId/messages — Owner sends a reply
  // ────────────────────────────────────────────────────────────
  router.post('/sessions/:sessionId/messages', messageLimiter, csrf, wrapAsyncHandler(async (req, res) => {
    let connection;
    try {
      const userId = req.session.userId;
      const sessionId = req.params.sessionId;
      if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
        return res.status(400).json({ message: 'Invalid session ID format' });
      }

      if (typeof req.body?.body !== 'string') {
        return res.status(400).json({ message: 'Message body is required' });
      }

      const trimmedBody = req.body.body.trim();
      if (!trimmedBody) {
        return res.status(400).json({ message: 'Message body cannot be empty' });
      }

      if (trimmedBody.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ message: `Message body must not exceed ${MAX_MESSAGE_LENGTH} characters` });
      }

      let clientMessageId = null;
      if (req.body?.clientMessageId !== undefined && req.body?.clientMessageId !== null) {
        if (typeof req.body.clientMessageId !== 'string' || !CLIENT_MESSAGE_ID_REGEX.test(req.body.clientMessageId)) {
          return res.status(400).json({ message: 'Invalid clientMessageId format' });
        }
        clientMessageId = req.body.clientMessageId;
      }

      connection = await pool.getConnection();
      if (typeof activeTestHook?.onConnectionAcquired === 'function') {
        await activeTestHook.onConnectionAcquired({
          route: 'owner_message',
          sessionId,
          connection,
          processlistId: connection.threadId,
        });
      }
      await connection.beginTransaction();

      // Verify owner access via vehicle ownership join and lock session row
      const [rows] = await connection.query(
        `SELECT s.id, s.public_id, s.status, s.expires_at
         FROM visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         WHERE s.public_id = ? AND v.user_id = ?
         FOR UPDATE OF s`,
        [sessionId, userId]
      );

      if (!rows.length) {
        await connection.rollback();
        return res.status(404).json({ message: 'Contact session not found' });
      }

      const session = rows[0];

      // Test-only synchronization hook: invoked while holding session row lock before commit
      if (typeof activeTestHook?.onMessageRowLocked === 'function') {
        await activeTestHook.onMessageRowLocked({
          route: 'owner_message',
          sessionId: session.public_id,
          sessionDbId: session.id,
          connection,
          processlistId: connection.threadId,
        });
      }

      const now = new Date();
      const isPastExpiry = new Date(session.expires_at).getTime() <= now.getTime();
      if (isPastExpiry || session.status === 'expired') {
        if (session.status !== 'expired' && session.status !== 'closed') {
          await connection.query(
            `UPDATE visitor_sessions SET status = 'expired' WHERE id = ? AND status != 'closed'`,
            [session.id]
          );
          await connection.commit();
        } else {
          await connection.rollback();
        }
        return res.status(400).json({
          status: 'expired',
          message: 'Session has expired and cannot accept messages',
        });
      }

      if (session.status === 'closed') {
        await connection.rollback();
        return res.status(400).json({
          status: 'closed',
          message: 'Session is closed and cannot accept messages',
        });
      }

      if (session.status !== 'pending' && session.status !== 'accepted') {
        await connection.rollback();
        return res.status(400).json({
          status: session.status,
          message: 'Session cannot accept messages in its current state',
        });
      }

      // Handle idempotency if clientMessageId provided
      if (clientMessageId) {
        try {
          const [insertResult] = await connection.query(
            `INSERT INTO visitor_messages (session_id, sender_type, body, client_message_id, created_at)
             VALUES (?, 'owner', ?, ?, ?)`,
            [session.id, trimmedBody, clientMessageId, now]
          );

          await connection.commit();

          return res.status(201).json({
            status: 'sent',
            message: {
              id: insertResult.insertId,
              sessionId: session.public_id,
              senderType: 'owner',
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
               WHERE session_id = ? AND sender_type = 'owner' AND client_message_id = ?
               LIMIT 1`,
              [session.id, clientMessageId]
            );
            if (existingRows.length > 0) {
              const existing = existingRows[0];
              return res.status(200).json({
                status: 'sent',
                message: {
                  id: existing.id,
                  sessionId: session.public_id,
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

      // Standard insert
      const [insertResult] = await connection.query(
        `INSERT INTO visitor_messages (session_id, sender_type, body, created_at)
         VALUES (?, 'owner', ?, ?)`,
        [session.id, trimmedBody, now]
      );

      await connection.commit();

      return res.status(201).json({
        status: 'sent',
        message: {
          id: insertResult.insertId,
          sessionId: session.public_id,
          senderType: 'owner',
          body: trimmedBody,
          clientMessageId: null,
          createdAt: now.toISOString(),
        },
      });
    } catch (error) {
      if (connection) {
        try { await connection.rollback(); } catch {}
      }
      return sendError(res, error, logger);
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }));

  // ────────────────────────────────────────────────────────────
  // GET /api/vehicles/:id — Retrieve vehicle details
  // ────────────────────────────────────────────────────────────
  router.get('/:id', wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const vehicleId = Number(req.params.id);
      if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
        return res.status(400).json({ message: 'Invalid vehicle ID' });
      }

      // Enforce ownership: MUST match both id AND user_id
      const [rows] = await pool.query(
        'SELECT * FROM vehicles WHERE id = ? AND user_id = ? LIMIT 1',
        [vehicleId, userId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: 'Vehicle not found' });
      }

      // Fetch QR code history
      const [qrRows] = await pool.query(
        'SELECT id, status, created_at, revoked_at FROM qr_codes WHERE vehicle_id = ? ORDER BY created_at DESC',
        [vehicleId]
      );

      const activeQr = qrRows.find((q) => q.status === 'active') || null;

      return res.json({
        vehicle: vehicleDTO(rows[0], activeQr),
        qrHistory: qrRows,
      });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }));

  // ────────────────────────────────────────────────────────────
  // GET /api/vehicles/:id/sessions — Retrieve vehicle contact sessions
  // ────────────────────────────────────────────────────────────
  router.get('/:id/sessions', wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const vehicleId = Number(req.params.id);
      if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
        return res.status(400).json({ message: 'Invalid vehicle ID' });
      }

      // Check ownership
      const [vRows] = await pool.query(
        'SELECT id FROM vehicles WHERE id = ? AND user_id = ? LIMIT 1',
        [vehicleId, userId]
      );
      if (!vRows.length) {
        return res.status(404).json({ message: 'Vehicle not found' });
      }

      const priorityFilter = typeof req.query.priority === 'string' ? req.query.priority.trim().toLowerCase() : null;

      let query = `
        SELECT s.id, s.public_id, s.vehicle_id, s.status, s.created_at, s.expires_at, s.accepted_at, s.closed_at,
               s.session_priority, s.priority_overridden,
               s.owner_last_read_message_id,
               v.registration_number, v.vehicle_type, v.vehicle_model, v.color,
               lm.body AS last_message_body,
               lm.sender_type AS last_message_sender,
               lm.is_auto_reply AS last_message_is_auto_reply,
               lm.priority AS last_message_priority,
               lm.created_at AS last_message_created_at,
               COALESCE(mc.msg_count, 0) AS message_count,
               COALESCE(uc.unread_count, 0) AS unread_count
        FROM visitor_sessions s
        JOIN vehicles v ON v.id = s.vehicle_id
        LEFT JOIN (
          SELECT session_id, COUNT(*) AS msg_count
          FROM visitor_messages
          GROUP BY session_id
        ) mc ON mc.session_id = s.id
        LEFT JOIN (
          SELECT vm.session_id, COUNT(*) AS unread_count
          FROM visitor_messages vm
          JOIN visitor_sessions vs ON vs.id = vm.session_id
          WHERE vm.sender_type = 'visitor'
            AND (vs.owner_last_read_message_id IS NULL OR vm.id > vs.owner_last_read_message_id)
          GROUP BY vm.session_id
        ) uc ON uc.session_id = s.id
        LEFT JOIN (
          SELECT m1.session_id, m1.body, m1.sender_type, m1.is_auto_reply, m1.priority, m1.created_at
          FROM visitor_messages m1
          JOIN (
            SELECT session_id, MAX(id) AS max_id
            FROM visitor_messages
            GROUP BY session_id
          ) m2 ON m1.id = m2.max_id
        ) lm ON lm.session_id = s.id
        WHERE s.vehicle_id = ? AND v.user_id = ?
      `;
      const params = [vehicleId, userId];

      if (priorityFilter && ['urgent', 'high', 'normal', 'low'].includes(priorityFilter)) {
        query += ' AND s.session_priority = ?';
        params.push(priorityFilter);
      }

      query += " ORDER BY FIELD(s.session_priority, 'urgent', 'high', 'normal', 'low'), COALESCE(lm.created_at, s.created_at) DESC LIMIT 50";

      const [rows] = await pool.query(query, params);

      return res.json({ sessions: rows.map(ownerSessionDTO) });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }));

  // ────────────────────────────────────────────────────────────
  // PATCH /api/vehicles/:id — Update vehicle information
  // ────────────────────────────────────────────────────────────
  router.patch('/:id', csrf, wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const vehicleId = Number(req.params.id);
      if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
        return res.status(400).json({ message: 'Invalid vehicle ID' });
      }

      // Enforce ownership
      const [existing] = await pool.query(
        'SELECT * FROM vehicles WHERE id = ? AND user_id = ? LIMIT 1',
        [vehicleId, userId]
      );
      if (!existing.length) {
        return res.status(404).json({ message: 'Vehicle not found' });
      }

      const updates = validateVehicleInput(req.body, { isPatch: true });
      const current = existing[0];

      const newReg = updates.registrationNumber !== undefined ? updates.registrationNumber : current.registration_number;
      const newType = updates.vehicleType !== undefined ? updates.vehicleType : current.vehicle_type;
      const newModel = updates.vehicleModel !== undefined ? updates.vehicleModel : current.vehicle_model;
      const newColor = updates.color !== undefined ? updates.color : current.color;

      // If registration number changed, check duplicate
      if (newReg !== current.registration_number) {
        const [dup] = await pool.query(
          'SELECT id FROM vehicles WHERE registration_number = ? AND id != ? LIMIT 1',
          [newReg, vehicleId]
        );
        if (dup.length) {
          return res.status(409).json({ message: 'A vehicle with this registration number already exists' });
        }
      }

      try {
        await pool.query(
          `UPDATE vehicles 
           SET registration_number = ?, vehicle_type = ?, vehicle_model = ?, color = ?
           WHERE id = ? AND user_id = ?`,
          [newReg, newType, newModel, newColor, vehicleId, userId]
        );
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ message: 'A vehicle with this registration number already exists' });
        }
        throw error;
      }

      const [updatedRows] = await pool.query('SELECT * FROM vehicles WHERE id = ?', [vehicleId]);

      return res.json({
        message: 'Vehicle updated successfully',
        vehicle: vehicleDTO(updatedRows[0]),
      });
    } catch (error) {
      return sendError(res, error, logger);
    }
  }));

  // ────────────────────────────────────────────────────────────
  // DELETE /api/vehicles/:id — Remove a vehicle
  // ────────────────────────────────────────────────────────────
  router.delete('/:id', csrf, wrapAsyncHandler(async (req, res) => {
    let connection;
    try {
      const userId = req.session.userId;
      const vehicleId = Number(req.params.id);
      if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
        return res.status(400).json({ message: 'Invalid vehicle ID' });
      }

      // Enforce ownership
      const [existing] = await pool.query(
        'SELECT id FROM vehicles WHERE id = ? AND user_id = ? LIMIT 1',
        [vehicleId, userId]
      );
      if (!existing.length) {
        return res.status(404).json({ message: 'Vehicle not found' });
      }

      connection = await pool.getConnection();
      await connection.beginTransaction();

      // Safely delete QR codes then vehicle in transaction (FK ON DELETE CASCADE also guarantees DB consistency)
      await connection.query('DELETE FROM qr_codes WHERE vehicle_id = ?', [vehicleId]);
      await connection.query('DELETE FROM vehicles WHERE id = ? AND user_id = ?', [vehicleId, userId]);

      await connection.commit();

      return res.json({ message: 'Vehicle deleted successfully' });
    } catch (error) {
      if (connection) {
        try { await connection.rollback(); } catch {}
      }
      return sendError(res, error, logger);
    } finally {
      if (connection) connection.release();
    }
  }));

  // ────────────────────────────────────────────────────────────
  // POST /api/vehicles/:id/qr/rotate — Regenerate / Rotate QR code
  // ────────────────────────────────────────────────────────────
  router.post('/:id/qr/rotate', csrf, wrapAsyncHandler(async (req, res) => {
    const userId = req.session.userId;
    const vehicleId = Number(req.params.id);
    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ message: 'Invalid vehicle ID' });
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [ownedVehicle] = await connection.query(
          'SELECT id FROM vehicles WHERE id = ? AND user_id = ? FOR UPDATE',
          [vehicleId, userId]
        );
        if (!ownedVehicle.length) {
          await connection.rollback();
          return res.status(404).json({ message: 'Vehicle not found' });
        }

        await connection.query(
          `UPDATE qr_codes SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, active_vehicle_id = NULL WHERE vehicle_id = ? AND status = 'active'`,
          [vehicleId]
        );

        const { rawToken, tokenHash } = generateSecureToken();
        const [insertResult] = await connection.query(
          `INSERT INTO qr_codes (vehicle_id, token_hash, status, active_vehicle_id) VALUES (?, ?, 'active', ?)`,
          [vehicleId, tokenHash, vehicleId]
        );

        await connection.commit();
        return res.json({
          message: 'QR code rotated successfully',
          qrCode: {
            id: insertResult.insertId,
            status: 'active',
            token: rawToken,
            createdAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        if (connection) {
          try { await connection.rollback(); } catch {}
        }
        if (error.code === 'ER_LOCK_DEADLOCK') {
          if (attempt < 2) continue;
          return res
            .set('Retry-After', '1')
            .status(503)
            .json({ message: 'QR rotation is temporarily unavailable. Please retry.', code: 'QR_ROTATION_RETRYABLE' });
        }
        if (error.code === 'ER_DUP_ENTRY' || error.code === 'ER_LOCK_WAIT_TIMEOUT') {
          return res.status(409).json({ message: 'QR rotation conflicted with another update. Please retry.' });
        }
        return sendError(res, error, logger);
      } finally {
        if (connection) connection.release();
      }
    }
    return res.status(409).json({ message: 'QR rotation conflicted with another update. Please retry.' });
  }));

  return router;
}

export default createVehiclesRouter;
