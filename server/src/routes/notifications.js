import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { wrapAsyncHandler } from '../asyncHandler.js';
import {
  saveSubscription,
  removeSubscription,
  isSubscribed,
  getVapidPublicKey,
} from '../services/pushNotification.js';

function requireCsrf(origins) {
  const allowed = new Set(origins || []);
  return (req, res, next) => {
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

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  return next();
}

export function createNotificationsRouter({ pool, origins, logger = console } = {}) {
  if (!pool) throw new Error('createNotificationsRouter requires a database pool');
  const router = Router();
  const csrf = requireCsrf(origins);

  // ────────────────────────────────────────────────────────────
  // GET /api/notifications/push/status — Check push subscription status
  // ────────────────────────────────────────────────────────────
  router.get('/push/status', requireAuth, wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const endpoint = req.query.endpoint ? String(req.query.endpoint).trim() : null;
      const vapidPublicKey = getVapidPublicKey();

      let subscribed = false;
      if (endpoint) {
        subscribed = await isSubscribed(pool, userId, endpoint);
      } else {
        const [rows] = await pool.query(
          'SELECT id FROM push_subscriptions WHERE user_id = ? LIMIT 1',
          [userId]
        );
        subscribed = rows.length > 0;
      }

      return res.json({
        subscribed,
        vapidPublicKey,
      });
    } catch (err) {
      if (logger?.error) logger.error('Error fetching push status', { error: err.message });
      return res.status(500).json({ message: 'Failed to retrieve notification status' });
    }
  }));

  // ────────────────────────────────────────────────────────────
  // POST /api/notifications/push/subscribe — Register push subscription
  // ────────────────────────────────────────────────────────────
  router.post('/push/subscribe', requireAuth, csrf, wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const subData = req.body?.subscription || req.body;
      if (!subData || typeof subData !== 'object') {
        return res.status(400).json({ message: 'Subscription data is required' });
      }

      await saveSubscription(pool, userId, subData);
      return res.status(201).json({ status: 'ok', subscribed: true });
    } catch (err) {
      if (logger?.warn) logger.warn('Failed to save push subscription', { error: err.message });
      return res.status(400).json({ message: err.message || 'Invalid subscription data' });
    }
  }));

  // ────────────────────────────────────────────────────────────
  // DELETE /api/notifications/push/subscribe — Unregister push subscription
  // ────────────────────────────────────────────────────────────
  router.delete('/push/subscribe', requireAuth, csrf, wrapAsyncHandler(async (req, res) => {
    try {
      const userId = req.session.userId;
      const endpoint = req.body?.endpoint || req.query?.endpoint;
      if (!endpoint || typeof endpoint !== 'string' || !endpoint.trim()) {
        return res.status(400).json({ message: 'Subscription endpoint is required' });
      }

      const { removed } = await removeSubscription(pool, userId, endpoint);
      return res.json({ status: 'ok', removed, subscribed: false });
    } catch (err) {
      if (logger?.warn) logger.warn('Failed to remove push subscription', { error: err.message });
      return res.status(400).json({ message: err.message || 'Failed to remove subscription' });
    }
  }));

  return router;
}
