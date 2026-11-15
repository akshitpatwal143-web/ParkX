import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { sanitizeDbErrorCode } from '../db.js';
import { wrapAsyncHandler } from '../asyncHandler.js';

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
    vehicle: {
      id: row.vehicle_id,
      registrationNumber: row.registration_number,
      vehicleType: row.vehicle_type,
      vehicleModel: row.vehicle_model,
      color: row.color,
    },
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

export function createVehiclesRouter({ pool, origins, logger = console } = {}) {
  if (!pool) throw new Error('createVehiclesRouter requires a database pool');
  const router = Router();
  const csrf = requireCsrf(origins);

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

      // 1. Insert vehicle
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
  router.get('/sessions', wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const vehicleIdFilter = req.query.vehicleId ? Number(req.query.vehicleId) : null;
      const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : null;

      let query = `
        SELECT s.id, s.public_id, s.vehicle_id, s.status, s.created_at, s.expires_at, s.accepted_at, s.closed_at,
               v.registration_number, v.vehicle_type, v.vehicle_model, v.color
        FROM visitor_sessions s
        JOIN vehicles v ON v.id = s.vehicle_id
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

      query += ' ORDER BY s.created_at DESC LIMIT 100';

      const [rows] = await pool.query(query, params);
      return res.json({ sessions: rows.map(ownerSessionDTO) });
    } catch (error) {
      return sendError(res, error, logger);
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
    try {
      const userId = req.session.userId;
      const sessionId = req.params.sessionId;
      if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
        return res.status(400).json({ message: 'Invalid session ID format' });
      }

      const now = new Date();

      // Atomic conditional update with ownership join:
      // Closes only currently pending or accepted unexpired sessions for vehicles owned by this user
      const [updateResult] = await pool.query(
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
        return res.json({
          status: 'closed',
          sessionId,
          closedAt: now.toISOString(),
        });
      }

      // If affectedRows === 0, investigate current persisted state preserving strict ownership check
      const [rows] = await pool.query(
        `SELECT s.id, s.public_id, s.status, s.expires_at, s.closed_at
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

      if (session.status === 'closed') {
        return res.json({
          status: 'closed',
          sessionId: session.public_id,
          message: 'Session is already closed',
          closedAt: session.closed_at,
        });
      }

      const isPastExpiry = new Date(session.expires_at).getTime() <= now.getTime();
      if (isPastExpiry || session.status === 'expired') {
        if (session.status !== 'expired') {
          await pool.query(
            `UPDATE visitor_sessions SET status = 'expired' WHERE id = ? AND status != 'closed'`,
            [session.id]
          );
        }
        return res.status(400).json({ status: 'expired', message: 'Session has already expired and cannot be closed' });
      }

      return res.status(400).json({
        status: session.status,
        message: 'Session cannot be closed in its current state',
      });
    } catch (error) {
      return sendError(res, error, logger);
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

      const [rows] = await pool.query(
        `SELECT s.id, s.public_id, s.vehicle_id, s.status, s.created_at, s.expires_at, s.accepted_at, s.closed_at,
                v.registration_number, v.vehicle_type, v.vehicle_model, v.color
         FROM visitor_sessions s
         JOIN vehicles v ON v.id = s.vehicle_id
         WHERE s.vehicle_id = ? AND v.user_id = ?
         ORDER BY s.created_at DESC LIMIT 50`,
        [vehicleId, userId]
      );

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
