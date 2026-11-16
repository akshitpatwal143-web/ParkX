import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const webpush = require('web-push');

let activePushProvider = null;
let devVapidKeys = null;

export function setPushProviderForTesting(provider) {
  activePushProvider = provider;
}

export function resetPushProviderForTesting() {
  activePushProvider = null;
}

export function getVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
      subject: process.env.VAPID_SUBJECT || 'mailto:notifications@parkx.local',
    };
  }

  if (!devVapidKeys) {
    try {
      devVapidKeys = webpush.generateVAPIDKeys();
      devVapidKeys.subject = 'mailto:dev@parkx.local';
    } catch {
      devVapidKeys = null;
    }
  }

  return devVapidKeys;
}

export function getVapidPublicKey() {
  const keys = getVapidKeys();
  return keys ? keys.publicKey : null;
}

function getProvider() {
  if (activePushProvider) {
    return activePushProvider;
  }
  const keys = getVapidKeys();
  if (keys) {
    try {
      webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
    } catch {}
  }
  return webpush;
}

export async function saveSubscription(pool, userId, subscriptionData) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Invalid user ID');
  }

  const endpoint = subscriptionData?.endpoint;
  const p256dh = subscriptionData?.keys?.p256dh;
  const auth = subscriptionData?.keys?.auth;

  if (typeof endpoint !== 'string' || endpoint.length < 10 || endpoint.length > 512) {
    throw new Error('Invalid subscription endpoint');
  }
  if (!endpoint.startsWith('https://') && !endpoint.startsWith('http://localhost')) {
    throw new Error('Endpoint must be HTTPS');
  }
  if (typeof p256dh !== 'string' || !p256dh.trim() || p256dh.length > 255) {
    throw new Error('Invalid p256dh key');
  }
  if (typeof auth !== 'string' || !auth.trim() || auth.length > 255) {
    throw new Error('Invalid auth key');
  }

  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       p256dh = VALUES(p256dh),
       auth = VALUES(auth),
       user_id = VALUES(user_id),
       updated_at = CURRENT_TIMESTAMP`,
    [userId, endpoint, p256dh.trim(), auth.trim()]
  );

  return { success: true };
}

export async function removeSubscription(pool, userId, endpoint) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Invalid user ID');
  }
  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    throw new Error('Invalid subscription endpoint');
  }

  const [result] = await pool.query(
    `DELETE FROM push_subscriptions
     WHERE user_id = ? AND endpoint = ?`,
    [userId, endpoint.trim()]
  );

  return { removed: result.affectedRows > 0 };
}

export async function isSubscribed(pool, userId, endpoint) {
  if (!Number.isInteger(userId) || userId <= 0 || typeof endpoint !== 'string' || !endpoint.trim()) {
    return false;
  }

  const [rows] = await pool.query(
    `SELECT id FROM push_subscriptions
     WHERE user_id = ? AND endpoint = ?
     LIMIT 1`,
    [userId, endpoint.trim()]
  );

  return rows.length > 0;
}

export async function sendPushNotificationToUser(pool, userId, payloadString, { logger = console } = {}) {
  if (!Number.isInteger(userId) || userId <= 0) {
    return { sent: 0, failed: 0, removed: 0 };
  }

  const [subscriptions] = await pool.query(
    `SELECT id, endpoint, p256dh, auth
     FROM push_subscriptions
     WHERE user_id = ?`,
    [userId]
  );

  if (!subscriptions || subscriptions.length === 0) {
    return { sent: 0, failed: 0, removed: 0 };
  }

  const provider = getProvider();
  let sent = 0;
  let failed = 0;
  let removed = 0;

  for (const sub of subscriptions) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    };

    try {
      await provider.sendNotification(pushSubscription, payloadString);
      sent++;
    } catch (err) {
      failed++;
      const statusCode = err?.statusCode || err?.status;
      if (statusCode === 404 || statusCode === 410) {
        // Subscription has expired or is no longer valid; clean it up
        try {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
          removed++;
          if (logger?.info) {
            logger.info('Removed expired push subscription', { endpoint: sub.endpoint, statusCode });
          }
        } catch (cleanupErr) {
          if (logger?.error) {
            logger.error('Failed to remove expired subscription', { error: cleanupErr.message });
          }
        }
      } else {
        if (logger?.warn) {
          logger.warn('Push delivery failed for subscriber', {
            statusCode,
            message: err?.message,
          });
        }
      }
    }
  }

  return { sent, failed, removed };
}

export async function sendPushNotificationForSession({ pool, vehicleId, sessionId, logger = console }) {
  try {
    const [vehicles] = await pool.query(
      `SELECT user_id, registration_number, vehicle_model
       FROM vehicles
       WHERE id = ?
       LIMIT 1`,
      [vehicleId]
    );

    if (!vehicles || vehicles.length === 0) {
      return;
    }

    const vehicle = vehicles[0];
    const payload = JSON.stringify({
      title: 'New visitor message',
      body: `Vehicle ${vehicle.registration_number}: You received a new message.`,
      tag: `session-${sessionId}`,
      data: {
        sessionId,
        vehicleId,
        registrationNumber: vehicle.registration_number,
        url: `/vehicles?openSession=${sessionId}`,
      },
    });

    await sendPushNotificationToUser(pool, vehicle.user_id, payload, { logger });
  } catch (err) {
    if (logger?.error) {
      logger.error('Error dispatching push notification for session', { error: err.message, sessionId });
    }
  }
}
