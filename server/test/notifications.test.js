import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import { createNotificationsRouter } from '../src/routes/notifications.js';
import { createVehiclesRouter } from '../src/routes/vehicles.js';
import { createPublicRouter } from '../src/routes/public.js';
import {
  setPushProviderForTesting,
  resetPushProviderForTesting,
  saveSubscription,
  removeSubscription,
  isSubscribed,
  sendPushNotificationToUser,
  sendPushNotificationForSession,
} from '../src/services/pushNotification.js';

function createMockPool() {
  const users = [
    { id: 1, email: 'owner1@example.com' },
    { id: 2, email: 'owner2@example.com' },
  ];

  const vehicles = [
    { id: 10, user_id: 1, registration_number: 'PX-100', vehicle_type: 'car', vehicle_model: 'Tesla Model S', color: 'Silver' },
    { id: 20, user_id: 2, registration_number: 'PX-200', vehicle_type: 'suv', vehicle_model: 'Rivian R1S', color: 'Green' },
  ];

  const visitorSessions = [];
  const visitorMessages = [];
  const pushSubscriptions = [];

  let nextSessionId = 1;
  let nextMessageId = 1;
  let nextSubId = 1;

  const pool = {
    users,
    vehicles,
    visitorSessions,
    visitorMessages,
    pushSubscriptions,

    seedSession({ vehicleId = 10, status = 'pending', ownerLastReadMessageId = null } = {}) {
      const publicId = 'vs_' + Math.random().toString(16).slice(2).padStart(24, '0') + Math.random().toString(16).slice(2).padStart(24, '0');
      const rawCredential = 'vcred_' + Math.random().toString(16).slice(2).padStart(32, '0') + Math.random().toString(16).slice(2).padStart(32, '0');
      const credentialHash = createHash('sha256').update(rawCredential).digest('hex');
      const sessionObj = {
        id: nextSessionId++,
        public_id: publicId,
        vehicle_id: vehicleId,
        credential_hash: credentialHash,
        status,
        owner_last_read_message_id: ownerLastReadMessageId,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 86400000),
        accepted_at: status === 'accepted' ? new Date() : null,
        closed_at: status === 'closed' ? new Date() : null,
      };
      visitorSessions.push(sessionObj);
      return { session: sessionObj, rawCredential };
    },

    seedMessage({ sessionId, senderType = 'visitor', body = 'Hello' }) {
      const msg = {
        id: nextMessageId++,
        session_id: sessionId,
        sender_type: senderType,
        body,
        client_message_id: null,
        created_at: new Date(),
      };
      visitorMessages.push(msg);
      return msg;
    },

    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        query: (sql, params) => pool.query(sql, params),
      };
    },

    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ');

      // 1. SELECT vehicles lookup for session notification
      if (s.includes('FROM vehicles') && s.includes('WHERE id = ?')) {
        const vId = params[0];
        const v = vehicles.find((item) => item.id === vId);
        return [v ? [v] : []];
      }

      // 2. Notifications summary query
      if (s.includes('FROM visitor_sessions s') && s.includes('COALESCE(uc.unread_count, 0) AS unread_count') && s.includes('ORDER BY uc.latest_unread_at DESC')) {
        const userId = params[0];
        const userVehicles = new Set(vehicles.filter((v) => v.user_id === userId).map((v) => v.id));
        const matchingSessions = visitorSessions.filter((item) => userVehicles.has(item.vehicle_id));

        const resultRows = [];
        for (const sess of matchingSessions) {
          const v = vehicles.find((item) => item.id === sess.vehicle_id);
          const cursor = sess.owner_last_read_message_id;
          const unreadMsgs = visitorMessages.filter(
            (m) => m.session_id === sess.id && m.sender_type === 'visitor' && (cursor === null || cursor === undefined || m.id > cursor)
          );
          if (unreadMsgs.length > 0) {
            const latest = unreadMsgs[unreadMsgs.length - 1];
            resultRows.push({
              id: sess.id,
              session_id: sess.public_id,
              vehicle_id: sess.vehicle_id,
              status: sess.status,
              expires_at: sess.expires_at,
              registration_number: v?.registration_number || 'PX',
              vehicle_type: v?.vehicle_type || 'car',
              vehicle_model: v?.vehicle_model || 'Model',
              unread_count: unreadMsgs.length,
              latest_unread_at: latest.created_at,
            });
          }
        }
        return [resultRows];
      }

      // 3. Mark as read: SELECT session
      if (s.includes('FROM visitor_sessions s') && s.includes('JOIN vehicles v ON v.id = s.vehicle_id') && s.includes('WHERE s.public_id = ? AND v.user_id = ?')) {
        const publicId = params[0];
        const userId = params[1];
        const sess = visitorSessions.find((item) => item.public_id === publicId);
        if (!sess) return [[]];
        const v = vehicles.find((item) => item.id === sess.vehicle_id);
        if (!v || v.user_id !== userId) return [[]];
        return [[{ id: sess.id, public_id: sess.public_id, owner_last_read_message_id: sess.owner_last_read_message_id }]];
      }

      // 4. Mark as read: MAX(id)
      if (s.includes('SELECT COALESCE(MAX(id), 0) AS max_id') && s.includes('FROM visitor_messages')) {
        const sId = params[0];
        const msgs = visitorMessages.filter((m) => m.session_id === sId);
        const maxId = msgs.length > 0 ? Math.max(...msgs.map((m) => m.id)) : 0;
        return [[{ max_id: maxId }]];
      }

      // 5. Mark as read: UPDATE visitor_sessions owner_last_read_message_id
      if (s.includes('UPDATE visitor_sessions') && s.includes('SET owner_last_read_message_id = GREATEST')) {
        const targetId = params[0];
        const sId = params[1];
        const sess = visitorSessions.find((item) => item.id === sId);
        if (sess) {
          sess.owner_last_read_message_id = Math.max(Number(sess.owner_last_read_message_id || 0), targetId);
        }
        return [{ affectedRows: 1 }];
      }

      // 6. Mark as read: updated cursor and unread count
      if (s.includes('SELECT s.owner_last_read_message_id') && s.includes('FROM visitor_sessions s WHERE s.id = ?')) {
        const sId = params[0];
        const sess = visitorSessions.find((item) => item.id === sId);
        if (!sess) return [[]];
        const cursor = sess.owner_last_read_message_id;
        const unreadCount = visitorMessages.filter(
          (m) => m.session_id === sess.id && m.sender_type === 'visitor' && (cursor === null || cursor === undefined || m.id > cursor)
        ).length;
        return [[{ owner_last_read_message_id: sess.owner_last_read_message_id, unread_count: unreadCount }]];
      }

      // 7. Push subscriptions queries
      if (s.includes('INSERT INTO push_subscriptions')) {
        const userId = params[0];
        const endpoint = params[1];
        const p256dh = params[2];
        const auth = params[3];
        const existing = pushSubscriptions.find((sub) => sub.endpoint === endpoint);
        if (existing) {
          existing.user_id = userId;
          existing.p256dh = p256dh;
          existing.auth = auth;
          existing.updated_at = new Date();
        } else {
          pushSubscriptions.push({
            id: nextSubId++,
            user_id: userId,
            endpoint,
            p256dh,
            auth,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
        return [{ affectedRows: 1 }];
      }

      if (s.includes('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')) {
        const userId = params[0];
        const endpoint = params[1];
        const idx = pushSubscriptions.findIndex((sub) => sub.user_id === userId && sub.endpoint === endpoint);
        if (idx !== -1) {
          pushSubscriptions.splice(idx, 1);
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      if (s.includes('DELETE FROM push_subscriptions WHERE endpoint = ?')) {
        const endpoint = params[0];
        const idx = pushSubscriptions.findIndex((sub) => sub.endpoint === endpoint);
        if (idx !== -1) {
          pushSubscriptions.splice(idx, 1);
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      if (s.includes('SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')) {
        const userId = params[0];
        const endpoint = params[1];
        const found = pushSubscriptions.find((sub) => sub.user_id === userId && sub.endpoint === endpoint);
        return [found ? [found] : []];
      }

      if (s.includes('SELECT id FROM push_subscriptions WHERE user_id = ? LIMIT 1')) {
        const userId = params[0];
        const found = pushSubscriptions.find((sub) => sub.user_id === userId);
        return [found ? [found] : []];
      }

      if (s.includes('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')) {
        const userId = params[0];
        const matching = pushSubscriptions.filter((sub) => sub.user_id === userId);
        return [matching];
      }

      // Default fallback
      return [[]];
    },
  };

  return pool;
}

function setupTestApp(pool, { userId = 1, csrfToken = 'test-csrf-token' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId,
      csrfToken,
    };
    next();
  });

  const origins = ['http://localhost:5173'];
  app.use('/api/vehicles', createVehiclesRouter({ pool, origins }));
  app.use('/api/notifications', createNotificationsRouter({ pool, origins }));

  return app;
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

test('Unread count calculation: returns 0 when no visitor messages exist', async () => {
  const pool = createMockPool();
  pool.seedSession({ vehicleId: 10 });
  const app = setupTestApp(pool, { userId: 1 });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/vehicles/notifications`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.totalUnreadCount, 0);
    assert.deepEqual(data.sessions, []);
  } finally {
    server.close();
  }
});

test('Unread count calculation: accurately counts unread visitor messages and excludes owner replies', async () => {
  const pool = createMockPool();
  const { session: s1 } = pool.seedSession({ vehicleId: 10 });
  pool.seedMessage({ sessionId: s1.id, senderType: 'visitor', body: 'Visitor msg 1' });
  pool.seedMessage({ sessionId: s1.id, senderType: 'owner', body: 'Owner reply 1' });
  pool.seedMessage({ sessionId: s1.id, senderType: 'visitor', body: 'Visitor msg 2' });

  const app = setupTestApp(pool, { userId: 1 });
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/vehicles/notifications`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.totalUnreadCount, 2); // 2 visitor messages, owner reply not counted
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].unreadCount, 2);
    assert.equal(data.sessions[0].sessionId, s1.public_id);
    assert.equal(data.sessions[0].registrationNumber, 'PX-100');
  } finally {
    server.close();
  }
});

test('Unread notifications: isolates notifications to authenticated owner vehicles', async () => {
  const pool = createMockPool();
  const { session: s1 } = pool.seedSession({ vehicleId: 10 }); // Owned by User 1
  const { session: s2 } = pool.seedSession({ vehicleId: 20 }); // Owned by User 2

  pool.seedMessage({ sessionId: s1.id, senderType: 'visitor', body: 'Msg for User 1' });
  pool.seedMessage({ sessionId: s2.id, senderType: 'visitor', body: 'Msg for User 2' });

  // Caller is User 1
  const app = setupTestApp(pool, { userId: 1 });
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/vehicles/notifications`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.totalUnreadCount, 1);
    assert.equal(data.sessions[0].sessionId, s1.public_id);
  } finally {
    server.close();
  }
});

test('Mark as read: advances read cursor to latest message and returns 0 unread', async () => {
  const pool = createMockPool();
  const { session: s1 } = pool.seedSession({ vehicleId: 10 });
  const m1 = pool.seedMessage({ sessionId: s1.id, senderType: 'visitor', body: 'Msg 1' });
  const m2 = pool.seedMessage({ sessionId: s1.id, senderType: 'visitor', body: 'Msg 2' });

  const app = setupTestApp(pool, { userId: 1, csrfToken: 'valid-csrf' });
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/vehicles/sessions/${s1.public_id}/read`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': 'valid-csrf',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.unreadCount, 0);
    assert.equal(data.ownerLastReadMessageId, m2.id);
    assert.equal(s1.owner_last_read_message_id, m2.id);
  } finally {
    server.close();
  }
});

test('Mark as read: monotonic forward-only guarantee (cursor never moves backwards)', async () => {
  const pool = createMockPool();
  const { session: s1 } = pool.seedSession({ vehicleId: 10, ownerLastReadMessageId: 10 });

  const app = setupTestApp(pool, { userId: 1, csrfToken: 'valid-csrf' });
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Attempt to pass an older message ID (5 < 10)
    const res = await fetch(`http://127.0.0.1:${port}/api/vehicles/sessions/${s1.public_id}/read`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': 'valid-csrf',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messageId: 5 }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    // Cursor remains 10 (did not regress to 5)
    assert.equal(data.ownerLastReadMessageId, 10);
    assert.equal(s1.owner_last_read_message_id, 10);
  } finally {
    server.close();
  }
});

test('Mark as read: rejects access for non-owned vehicle sessions (404)', async () => {
  const pool = createMockPool();
  const { session: s2 } = pool.seedSession({ vehicleId: 20 }); // Owned by User 2

  // User 1 attempts to mark User 2's session as read
  const app = setupTestApp(pool, { userId: 1, csrfToken: 'valid-csrf' });
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/vehicles/sessions/${s2.public_id}/read`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': 'valid-csrf',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('Push subscription: registration, duplicate idempotency, and removal', async () => {
  const pool = createMockPool();
  const app = setupTestApp(pool, { userId: 1, csrfToken: 'valid-csrf' });
  const server = app.listen(0);
  const port = server.address().port;

  const validEndpoint = 'https://fcm.googleapis.com/fcm/send/test-token-123';
  const subData = {
    endpoint: validEndpoint,
    keys: {
      p256dh: 'test-p256dh-key',
      auth: 'test-auth-secret',
    },
  };

  try {
    // 1. Initial status -> not subscribed
    const status1 = await fetch(`http://127.0.0.1:${port}/api/notifications/push/status?endpoint=${encodeURIComponent(validEndpoint)}`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(status1.status, 200);
    const json1 = await status1.json();
    assert.equal(json1.subscribed, false);
    assert.ok(json1.vapidPublicKey);

    // 2. Register subscription
    const regRes = await fetch(`http://127.0.0.1:${port}/api/notifications/push/subscribe`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': 'valid-csrf',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(subData),
    });
    assert.equal(regRes.status, 201);
    const regJson = await regRes.json();
    assert.equal(regJson.subscribed, true);
    assert.equal(pool.pushSubscriptions.length, 1);

    // 3. Registering again with updated keys updates existing subscription (idempotent duplicate handling)
    const dupRes = await fetch(`http://127.0.0.1:${port}/api/notifications/push/subscribe`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': 'valid-csrf',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        endpoint: validEndpoint,
        keys: { p256dh: 'updated-key', auth: 'updated-auth' },
      }),
    });
    assert.equal(dupRes.status, 201);
    assert.equal(pool.pushSubscriptions.length, 1); // No duplicate row
    assert.equal(pool.pushSubscriptions[0].p256dh, 'updated-key');

    // 4. Verify status -> subscribed
    const status2 = await fetch(`http://127.0.0.1:${port}/api/notifications/push/status?endpoint=${encodeURIComponent(validEndpoint)}`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    const json2 = await status2.json();
    assert.equal(json2.subscribed, true);

    // 5. Unregister subscription
    const delRes = await fetch(`http://127.0.0.1:${port}/api/notifications/push/subscribe`, {
      method: 'DELETE',
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': 'valid-csrf',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ endpoint: validEndpoint }),
    });
    assert.equal(delRes.status, 200);
    const delJson = await delRes.json();
    assert.equal(delJson.subscribed, false);
    assert.equal(pool.pushSubscriptions.length, 0);
  } finally {
    server.close();
  }
});

test('Push delivery: sends notification to owner with safe payload and no sensitive tokens', async () => {
  const pool = createMockPool();
  pool.pushSubscriptions.push({
    id: 1,
    user_id: 1,
    endpoint: 'https://fcm.googleapis.com/fcm/send/user1',
    p256dh: 'key1',
    auth: 'auth1',
  });

  const dispatched = [];
  setPushProviderForTesting({
    async sendNotification(sub, payload) {
      dispatched.push({ sub, payload: JSON.parse(payload) });
    },
  });

  try {
    await sendPushNotificationForSession({
      pool,
      vehicleId: 10,
      sessionId: 'vs_000000000000000000000000000000000000000000000001',
      logger: console,
    });

    assert.equal(dispatched.length, 1);
    const sent = dispatched[0];
    assert.equal(sent.sub.endpoint, 'https://fcm.googleapis.com/fcm/send/user1');
    assert.equal(sent.payload.title, 'New visitor message');
    assert.ok(sent.payload.body.includes('PX-100'));
    assert.equal(sent.payload.data.vehicleId, 10);
    assert.equal(sent.payload.data.sessionId, 'vs_000000000000000000000000000000000000000000000001');

    // Verify NO visitor credentials or QR secrets are included in push payload
    const stringified = JSON.stringify(sent.payload);
    assert.equal(stringified.includes('vcred_'), false);
    assert.equal(stringified.includes('pkx_'), false);
  } finally {
    resetPushProviderForTesting();
  }
});

test('Expired subscription cleanup: removes subscription when push service returns 410 Gone or 404', async () => {
  const pool = createMockPool();
  pool.pushSubscriptions.push(
    {
      id: 1,
      user_id: 1,
      endpoint: 'https://fcm.googleapis.com/fcm/send/expired410',
      p256dh: 'k1',
      auth: 'a1',
    },
    {
      id: 2,
      user_id: 1,
      endpoint: 'https://fcm.googleapis.com/fcm/send/active',
      p256dh: 'k2',
      auth: 'a2',
    }
  );

  setPushProviderForTesting({
    async sendNotification(sub) {
      if (sub.endpoint.includes('expired410')) {
        const error = new Error('Subscription no longer active');
        error.statusCode = 410;
        throw error;
      }
    },
  });

  try {
    const result = await sendPushNotificationToUser(pool, 1, JSON.stringify({ test: true }));
    assert.equal(result.sent, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.removed, 1);

    // Verify expired subscription was deleted from database
    assert.equal(pool.pushSubscriptions.length, 1);
    assert.equal(pool.pushSubscriptions[0].endpoint, 'https://fcm.googleapis.com/fcm/send/active');
  } finally {
    resetPushProviderForTesting();
  }
});

test('Push failure resilience: push provider error does not throw or crash', async () => {
  const pool = createMockPool();
  pool.pushSubscriptions.push({
    id: 1,
    user_id: 1,
    endpoint: 'https://fcm.googleapis.com/fcm/send/network-fail',
    p256dh: 'k1',
    auth: 'a1',
  });

  setPushProviderForTesting({
    async sendNotification() {
      throw new Error('Network socket disconnected');
    },
  });

  try {
    // Must not throw
    await assert.doesNotReject(async () => {
      await sendPushNotificationForSession({
        pool,
        vehicleId: 10,
        sessionId: 'vs_test',
        logger: { error() {}, warn() {} },
      });
    });
  } finally {
    resetPushProviderForTesting();
  }
});
