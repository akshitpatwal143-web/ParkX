import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';

const SALT_ROUNDS = 12;
const MAX_PASSWORD_BYTES = 72;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function apiError(status, message, errors) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.validationErrors = errors;
  return error;
}

function sendError(res, error, { operation, requestId } = {}) {
  const status = error.status || 500;
  const message = status >= 500 ? 'Internal server error' : error.publicMessage || error.message;
  if (status >= 500) {
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
    console.error('Authentication request failed:', { code, status, operation, requestId });
  }
  const body = { message };
  if (error.validationErrors) body.errors = error.validationErrors;
  return res.status(status).json(body);
}

function validateEmail(value, errors) {
  if (typeof value !== 'string') {
    errors.email = 'Email is required';
    return '';
  }
  const email = value.trim().toLowerCase();
  if (!email) errors.email = 'Email is required';
  else if (Buffer.byteLength(email, 'utf8') > 254 || !EMAIL_RE.test(email)) errors.email = 'Enter a valid email';
  return email;
}

function validatePassword(value, errors, { signup = false } = {}) {
  if (typeof value !== 'string' || !value.length) {
    errors.password = 'Password is required';
    return '';
  }
  if (signup && Array.from(value).length < 8) errors.password = 'Minimum 8 characters';
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    errors.password = 'Password must be at most 72 UTF-8 bytes';
  }
  return value;
}

function validateSignup(body) {
  const errors = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw apiError(400, 'Validation failed', { body: 'Request body must be a JSON object' });
  }
  let name = '';
  if (typeof body.name !== 'string') errors.name = 'Full name is required';
  else {
    name = body.name.trim();
    if (!name) errors.name = 'Full name is required';
    else if (Array.from(name).length > 100 || Buffer.byteLength(name, 'utf8') > 400) errors.name = 'Full name must be at most 100 characters';
  }
  const email = validateEmail(body.email, errors);
  const password = validatePassword(body.password, errors, { signup: true });
  if (Object.keys(errors).length) throw apiError(400, 'Validation failed', errors);
  return { name, email, password };
}

function validateLogin(body) {
  const errors = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw apiError(400, 'Validation failed', { body: 'Request body must be a JSON object' });
  }
  const email = validateEmail(body.email, errors);
  const password = validatePassword(body.password, errors);
  if (Object.keys(errors).length) throw apiError(400, 'Validation failed', errors);
  return { email, password };
}

function userDTO(row) {
  return { id: row.id, fullName: row.full_name, email: row.email, createdAt: row.created_at };
}

function regenerateSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.userId = userId;
      // Login/signup rotates the CSRF secret with the session identifier.
      req.session.csrfToken = randomBytes(32).toString('hex');
      return resolve();
    });
  });
}

function requireCsrf(origins) {
  const allowed = new Set(origins);
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (!origin || !allowed.has(origin)) return res.status(403).json({ message: 'Invalid or missing Origin header' });
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

export function createAuthRouter({ pool, origins, loginLimiter, signupLimiter } = {}) {
  if (!pool) throw new Error('createAuthRouter requires a database pool');
  const router = Router();
  const jsonLimitHandler = (message) => (_req, res) => res.status(429).json({ message });
  const loginLimit = loginLimiter || rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, handler: jsonLimitHandler('Too many login attempts. Please try again later.') });
  const signupLimit = signupLimiter || rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, handler: jsonLimitHandler('Too many signup attempts. Please try again later.') });
  const csrf = requireCsrf(origins || []);

  router.get('/csrf', (req, res) => {
    if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('hex');
    req.session.save((error) => {
      if (error) return sendError(res, error, { operation: 'csrf_session_save', requestId: req.requestId });
      return res.json({ csrfToken: req.session.csrfToken });
    });
  });

  router.post('/signup', csrf, signupLimit, async (req, res) => {
    try {
      const { name, email, password } = validateSignup(req.body);
      const [existing] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
      if (existing.length) return res.status(409).json({ message: 'An account with this email already exists' });

      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      let result;
      try {
        [result] = await pool.query('INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)', [name, email, hash]);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'An account with this email already exists' });
        throw error;
      }
      const [rows] = await pool.query('SELECT id, full_name, email, created_at FROM users WHERE id = ?', [result.insertId]);
      if (!rows.length) throw new Error('Inserted user could not be reloaded');
      await regenerateSession(req, rows[0].id);
      return res.status(201).json({ message: 'Account created', user: userDTO(rows[0]) });
    } catch (error) {
      return sendError(res, error, { operation: 'signup', requestId: req.requestId });
    }
  });

  router.post('/login', csrf, loginLimit, async (req, res) => {
    try {
      const { email, password } = validateLogin(req.body);
      const [rows] = await pool.query('SELECT id, full_name, email, password_hash, created_at FROM users WHERE email = ? LIMIT 1', [email]);
      if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
        return res.status(401).json({ message: 'Invalid email or password' });
      }
      await regenerateSession(req, rows[0].id);
      return res.status(200).json({ message: 'Logged in', user: userDTO(rows[0]) });
    } catch (error) {
      return sendError(res, error, { operation: 'login', requestId: req.requestId });
    }
  });

  router.get('/me', async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ message: 'Not authenticated' });
      const [rows] = await pool.query('SELECT id, full_name, email, created_at FROM users WHERE id = ?', [req.session.userId]);
      if (!rows.length) {
        return req.session.destroy((error) => error ? sendError(res, error, { operation: 'me_session_destroy', requestId: req.requestId }) : res.status(401).json({ message: 'User not found' }));
      }
      return res.status(200).json({ user: userDTO(rows[0]) });
    } catch (error) {
      return sendError(res, error, { operation: 'me', requestId: req.requestId });
    }
  });

  router.post('/logout', csrf, (req, res) => {
    if (!req.session) return res.status(200).json({ message: 'Logged out' });
    req.session.destroy((error) => {
      if (error) return sendError(res, error, { operation: 'logout_session_destroy', requestId: req.requestId });
      res.clearCookie('parkx.sid', { path: '/' });
      return res.status(200).json({ message: 'Logged out' });
    });
  });

  return router;
}

export default createAuthRouter;
