import { createHash } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

const TOKEN_REGEX = /^pkx_[0-9a-fA-F]{64}$/;

function sanitizeString(str) {
  return typeof str === 'string' ? str.trim() : '';
}

export function createPublicRouter({ pool, limiter, logger } = {}) {
  if (!pool) throw new Error('createPublicRouter requires a database pool');
  const router = Router();

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

  const verifyLimiter = limiter || defaultLimiter;

  // GET /api/public/vehicles/:token
  router.get('/vehicles/:token', verifyLimiter, async (req, res) => {
    // Referrer-Policy and Cache-Control headers to protect token in URL
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    const rawToken = sanitizeString(req.params.token);

    // 1. Validate token format and length
    if (!rawToken || !TOKEN_REGEX.test(rawToken)) {
      return res.status(400).json({
        status: 'invalid',
        message: 'Invalid or malformed QR pass token.',
      });
    }

    try {
      // 2. Compute SHA-256 hash of presented token
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      // 3. Query qr_codes joined with vehicles using parameterized query
      // Never select internal vehicle IDs, user IDs, or personal info
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

      // 4. Token not found
      if (!rows || rows.length === 0) {
        return res.status(404).json({
          status: 'invalid',
          message: 'QR pass unrecognized or does not exist.',
        });
      }

      const match = rows[0];

      // 5. Check if revoked
      if (match.qr_status === 'revoked') {
        return res.status(410).json({
          status: 'revoked',
          message: 'This ParkX pass has been revoked by the vehicle owner.',
        });
      }

      // 6. Active pass: return strictly minimal vehicle telemetry
      // NEVER expose raw token hashes, internal vehicle IDs, owner IDs, or personal info
      return res.status(200).json({
        status: 'valid',
        vehicle: {
          vehicleType: match.vehicle_type,
          vehicleModel: match.vehicle_model,
          color: match.color,
        },
      });
    } catch (err) {
      // Ensure raw token is NEVER logged in application logs
      if (logger && typeof logger.error === 'function') {
        logger.error('Public QR verification database error', { code: err.code || 'DB_ERROR' });
      } else {
        console.error('Public QR verification error:', { code: err.code || 'DB_ERROR' });
      }
      return res.status(500).json({
        status: 'error',
        message: 'Verification service temporarily unavailable.',
      });
    }
  });

  return router;
}

export default createPublicRouter;
