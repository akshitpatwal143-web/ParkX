import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { createPublicRouter } from '../src/routes/public.js';
import { createVehiclesRouter } from '../src/routes/vehicles.js';

function createMockMessagingPool() {
  const validToken = 'pkx_' + '1'.repeat(64);
  const validHash = createHash('sha256').update(validToken).digest('hex');

  const otherToken = 'pkx_' + '2'.repeat(64);
  const otherHash = createHash('sha256').update(otherToken).digest('hex');

  const vehicles = [
    { id: 10, user_id: 1, registration_number: 'PX-100', vehicle_type: 'car', vehicle_model: 'Tesla Model S', color: 'Midnight Silver' },
    { id: 20, user_id: 2, registration_number: 'PX-200', vehicle_type: 'suv', vehicle_model: 'Rivian R1S', color: 'Forest Green' },
  ];

  const qrCodes = [
    { id: 1, vehicle_id: 10, token_hash: validHash, status: 'active' },
    { id: 2, vehicle_id: 20, token_hash: otherHash, status: 'active' },
  ];

  const visitorSessions = [];
  const visitorMessages = [];
  let nextSessionId = 1;
  let nextMessageId = 1;

  const pool = {
    validToken,
    otherToken,
    vehicles,
    visitorSessions,
    visitorMessages,

    seedSession({ vehicleId = 10, status = 'pending', expiresAt = new Date(Date.now() + 86400000) } = {}) {
      const publicId = 'vs_' + Math.random().toString(16).slice(2).padStart(24, '0') + Math.random().toString(16).slice(2).padStart(24, '0');
      const rawCredential = 'vcred_' + Math.random().toString(16).slice(2).padStart(32, '0') + Math.random().toString(16).slice(2).padStart(32, '0');
      const credentialHash = createHash('sha256').update(rawCredential).digest('hex');
      const session = {
        id: nextSessionId++,
        public_id: publicId,
        vehicle_id: vehicleId,
        credential_hash: credentialHash,
        status,
        created_at: new Date(),
        expires_at: expiresAt,
        accepted_at: status === 'accepted' ? new Date() : null,
        closed_at: status === 'closed' ? new Date() : null,
      };
      visitorSessions.push(session);
      return { session, rawCredential };
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
      // 1. Session lookup by public_id
      if (sql.includes('FROM visitor_sessions') && (sql.includes('WHERE public_id = ?') || sql.includes('WHERE s.public_id = ?'))) {
        const publicId = params[0];
        const s = visitorSessions.find((item) => item.public_id === publicId);
        if (!s) return [[]];

        // If join with vehicles
        if (sql.includes('JOIN vehicles v')) {
          const v = vehicles.find((item) => item.id === s.vehicle_id);
          if (sql.includes('v.user_id = ?')) {
            const userId = params[1];
            if (!v || v.user_id !== userId) return [[]];
          }
          return [[{
            id: s.id,
            public_id: s.public_id,
            vehicle_id: s.vehicle_id,
            credential_hash: s.credential_hash,
            status: s.status,
            created_at: s.created_at,
            expires_at: s.expires_at,
            accepted_at: s.accepted_at,
            closed_at: s.closed_at,
            vehicle_type: v?.vehicle_type || 'car',
            vehicle_model: v?.vehicle_model || 'Model S',
            color: v?.color || 'Black',
          }]];
        }

        return [[s]];
      }

      // 2. Session single table lookup by id
      if (sql.includes('FROM visitor_sessions') && sql.includes('WHERE id = ?')) {
        const id = params[0];
        const s = visitorSessions.find((item) => item.id === id);
        return [s ? [s] : []];
      }

      // 3. Insert visitor message
      if (sql.includes('INSERT INTO visitor_messages')) {
        const isOwner = sql.includes("'owner'");
        const senderType = isOwner ? 'owner' : 'visitor';
        const sessionId = params[0];
        const body = params[1];
        let clientMessageId = null;
        let createdAt = new Date();
        if (sql.includes('client_message_id')) {
          clientMessageId = params[2] || null;
          createdAt = params[3] || new Date();
        } else {
          createdAt = params[2] || new Date();
        }

        // Check unique constraint: (session_id, sender_type, client_message_id)
        if (clientMessageId) {
          const existing = visitorMessages.find(
            (m) => m.session_id === sessionId && m.sender_type === senderType && m.client_message_id === clientMessageId
          );
          if (existing) {
            const err = new Error('Duplicate entry for key uq_visitor_messages_client_id');
            err.code = 'ER_DUP_ENTRY';
            throw err;
          }
        }

        const newMsg = {
          id: nextMessageId++,
          session_id: sessionId,
          sender_type: senderType,
          body,
          client_message_id: clientMessageId,
          created_at: createdAt,
        };
        visitorMessages.push(newMsg);
        return [{ insertId: newMsg.id, affectedRows: 1 }];
      }

      // 4. Retrieve messages for a session (with id > after)
      if (sql.includes('FROM visitor_messages') && sql.includes('WHERE session_id = ? AND id > ?')) {
        const [sessionId, afterId, limit] = params;
        const filtered = visitorMessages
          .filter((m) => m.session_id === sessionId && m.id > afterId)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit);
        return [filtered];
      }

      // 5. Lookup message by client_message_id on ER_DUP_ENTRY
      if (sql.includes('FROM visitor_messages') && sql.includes('client_message_id = ?')) {
        const sessionId = params[0];
        const clientMsgId = params[1];
        const isOwner = sql.includes("'owner'");
        const senderType = isOwner ? 'owner' : 'visitor';
        const found = visitorMessages.find(
          (m) => m.session_id === sessionId && m.sender_type === senderType && m.client_message_id === clientMsgId
        );
        return [found ? [found] : []];
      }

      // 6. Update session status to expired
      if (sql.includes("UPDATE visitor_sessions SET status = 'expired'")) {
        const id = params[params.length - 1];
        const s = visitorSessions.find((item) => item.id === id);
        if (s && s.status !== 'closed') {
          s.status = 'expired';
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      // 7. Update session status to accepted
      if (sql.includes("SET s.status = 'accepted'")) {
        const sessionId = params[1];
        const s = visitorSessions.find((item) => item.public_id === sessionId);
        if (s && s.status === 'pending') {
          s.status = 'accepted';
          s.accepted_at = params[0];
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      // 8. Update session status to closed
      if (sql.includes("SET status = 'closed'") || sql.includes("SET s.status = 'closed'")) {
        const idOrPub = params[1];
        const s = visitorSessions.find((item) => item.id === idOrPub || item.public_id === idOrPub);
        if (s && ['pending', 'accepted'].includes(s.status)) {
          s.status = 'closed';
          s.closed_at = params[0];
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      // 9. Owner inbox listing with message aggregation
      if (sql.includes('FROM visitor_sessions s') && sql.includes('JOIN vehicles v') && sql.includes('WHERE v.user_id = ?')) {
        const userId = params[0];
        const ownedVehicles = vehicles.filter((v) => v.user_id === userId);
        const ownedIds = new Set(ownedVehicles.map((v) => v.id));

        const rows = visitorSessions
          .filter((s) => ownedIds.has(s.vehicle_id))
          .map((s) => {
            const v = vehicles.find((item) => item.id === s.vehicle_id);
            const msgs = visitorMessages.filter((m) => m.session_id === s.id).sort((a, b) => b.id - a.id);
            const last = msgs[0] || null;
            return {
              id: s.id,
              public_id: s.public_id,
              vehicle_id: s.vehicle_id,
              status: s.status,
              created_at: s.created_at,
              expires_at: s.expires_at,
              accepted_at: s.accepted_at,
              closed_at: s.closed_at,
              registration_number: v?.registration_number || 'PX-100',
              vehicle_type: v?.vehicle_type || 'car',
              vehicle_model: v?.vehicle_model || 'Model S',
              color: v?.color || 'Black',
              message_count: msgs.length,
              last_message_body: last?.body || null,
              last_message_sender: last?.sender_type || null,
              last_message_created_at: last?.created_at || null,
            };
          });
        return [rows];
      }

      throw new Error(`Unhandled mock query: ${sql}`);
    },
  };

  return pool;
}

function invokeRouter(router, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
        return this;
      },
      set(k, v) {
        this.headers[k.toLowerCase()] = v;
        return this;
      },
      get(k) {
        return this.headers[k.toLowerCase()];
      },
      json(data) {
        this.body = data;
        resolve({ status: this.statusCode, headers: this.headers, body: this.body });
      },
      send(data) {
        this.body = data;
        resolve({ status: this.statusCode, headers: this.headers, body: this.body });
      },
    };

    router(req, res, (err) => {
      if (err) {
        resolve({ status: err.status || 500, headers: res.headers, body: { message: err.message } });
      } else {
        resolve({ status: 404, headers: res.headers, body: { message: 'Not found' } });
      }
    });
  });
}

function makeFakeReq({
  method = 'GET',
  url = '/',
  body = {},
  params = {},
  query = {},
  headers = {},
  session = {},
  ip = '127.0.0.1',
} = {}) {
  const normHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    normHeaders[k.toLowerCase()] = v;
  }
  return {
    method,
    url,
    body,
    params,
    query,
    headers: normHeaders,
    ip,
    app: {
      get(k) {
        if (k === 'trust proxy') return false;
        return undefined;
      },
    },
    get(name) {
      return normHeaders[name.toLowerCase()];
    },
    session,
  };
}

// ────────────────────────────────────────────────────────────
// Tests: Visitor Messaging (Phase 3.3)
// ────────────────────────────────────────────────────────────

test('Visitor can send first message while session is pending', async () => {
  const pool = createMockMessagingPool();
  const router = createPublicRouter({ pool });
  const { session, rawCredential } = pool.seedSession({ status: 'pending' });

  const req = makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Hello owner, your headlights are on!' },
  });

  const res = await invokeRouter(router, req);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'sent');
  assert.equal(res.body.message.body, 'Hello owner, your headlights are on!');
  assert.equal(res.body.message.senderType, 'visitor');
  assert.equal(res.body.message.sessionId, session.public_id);
  assert.ok(res.body.message.id > 0);
  assert.ok(res.body.message.createdAt);
});

test('Visitor can send messages after session is accepted', async () => {
  const pool = createMockMessagingPool();
  const router = createPublicRouter({ pool });
  const { session, rawCredential } = pool.seedSession({ status: 'accepted' });

  const req = makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Thanks for accepting, I will be there in 5 mins.' },
  });

  const res = await invokeRouter(router, req);
  assert.equal(res.status, 201);
  assert.equal(res.body.message.senderType, 'visitor');
  assert.equal(res.body.message.body, 'Thanks for accepting, I will be there in 5 mins.');
});

test('Owner can reply while session is pending (owner acceptance NOT required)', async () => {
  const pool = createMockMessagingPool();
  const router = createVehiclesRouter({ pool, origins: ['https://parkx.local'] });
  const { session } = pool.seedSession({ vehicleId: 10, status: 'pending' });

  const req = makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    headers: {
      Origin: 'https://parkx.local',
      'X-CSRF-Token': 'valid_csrf_token',
    },
    session: { userId: 1, csrfToken: 'valid_csrf_token' },
    body: { body: 'Thank you for letting me know, turning them off now.' },
  });

  const res = await invokeRouter(router, req);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'sent');
  assert.equal(res.body.message.senderType, 'owner');
  assert.equal(res.body.message.body, 'Thank you for letting me know, turning them off now.');
});

test('Owner can reply after session acceptance', async () => {
  const pool = createMockMessagingPool();
  const router = createVehiclesRouter({ pool, origins: ['https://parkx.local'] });
  const { session } = pool.seedSession({ vehicleId: 10, status: 'accepted' });

  const req = makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    headers: {
      Origin: 'https://parkx.local',
      'X-CSRF-Token': 'valid_csrf_token',
    },
    session: { userId: 1, csrfToken: 'valid_csrf_token' },
    body: { body: 'No problem, take your time.' },
  });

  const res = await invokeRouter(router, req);
  assert.equal(res.status, 201);
  assert.equal(res.body.message.senderType, 'owner');
});

test('Two-way chronological conversation between visitor and owner', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const vehiclesRouter = createVehiclesRouter({ pool, origins: ['https://parkx.local'] });
  const { session, rawCredential } = pool.seedSession({ vehicleId: 10, status: 'pending' });

  // 1. Visitor sends msg 1
  await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Hi, are you parked here?' },
  }));

  // 2. Owner replies msg 2
  await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    headers: { Origin: 'https://parkx.local', 'X-CSRF-Token': 'tok' },
    session: { userId: 1, csrfToken: 'tok' },
    body: { body: 'Yes, just stepped into the grocery store.' },
  }));

  // 3. Visitor sends msg 3
  await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Could you move forward slightly so I can pull out?' },
  }));

  // Visitor retrieves all messages
  const visRes = await invokeRouter(publicRouter, makeFakeReq({
    method: 'GET',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
  }));

  assert.equal(visRes.status, 200);
  assert.equal(visRes.body.messages.length, 3);
  assert.equal(visRes.body.messages[0].senderType, 'visitor');
  assert.equal(visRes.body.messages[0].body, 'Hi, are you parked here?');
  assert.equal(visRes.body.messages[1].senderType, 'owner');
  assert.equal(visRes.body.messages[1].body, 'Yes, just stepped into the grocery store.');
  assert.equal(visRes.body.messages[2].senderType, 'visitor');
  assert.equal(visRes.body.messages[2].body, 'Could you move forward slightly so I can pull out?');

  // Verify chronological ordering: id strictly increasing
  assert.ok(visRes.body.messages[0].id < visRes.body.messages[1].id);
  assert.ok(visRes.body.messages[1].id < visRes.body.messages[2].id);

  // Owner retrieves same messages
  const ownRes = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'GET',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    session: { userId: 1 },
  }));

  assert.equal(ownRes.status, 200);
  assert.equal(ownRes.body.messages.length, 3);
  assert.deepEqual(ownRes.body.messages, visRes.body.messages);
});

test('Incremental cursor pagination (`after` and `limit`)', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const { session, rawCredential } = pool.seedSession({ status: 'pending' });

  // Send 3 messages
  for (let i = 1; i <= 3; i++) {
    await invokeRouter(publicRouter, makeFakeReq({
      method: 'POST',
      url: `/sessions/${session.public_id}/messages`,
      params: { id: session.public_id },
      headers: { 'X-Visitor-Credential': rawCredential },
      body: { body: `Message ${i}` },
    }));
  }

  // Poll only after message ID 1
  const firstRes = await invokeRouter(publicRouter, makeFakeReq({
    method: 'GET',
    url: `/sessions/${session.public_id}/messages?after=1`,
    params: { id: session.public_id },
    query: { after: '1' },
    headers: { 'X-Visitor-Credential': rawCredential },
  }));

  assert.equal(firstRes.status, 200);
  assert.equal(firstRes.body.messages.length, 2);
  assert.equal(firstRes.body.messages[0].body, 'Message 2');
  assert.equal(firstRes.body.messages[1].body, 'Message 3');

  // Poll with limit 1
  const limitRes = await invokeRouter(publicRouter, makeFakeReq({
    method: 'GET',
    url: `/sessions/${session.public_id}/messages?limit=1`,
    params: { id: session.public_id },
    query: { limit: '1' },
    headers: { 'X-Visitor-Credential': rawCredential },
  }));

  assert.equal(limitRes.status, 200);
  assert.equal(limitRes.body.messages.length, 1);
  assert.equal(limitRes.body.hasMore, true);
});

test('Empty or whitespace-only messages are rejected with 400', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const vehiclesRouter = createVehiclesRouter({ pool, origins: ['https://parkx.local'] });
  const { session, rawCredential } = pool.seedSession({ status: 'pending' });

  // Visitor empty body
  const vRes1 = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: '' },
  }));
  assert.equal(vRes1.status, 400);

  // Visitor whitespace-only body
  const vRes2 = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: '   \n\t  ' },
  }));
  assert.equal(vRes2.status, 400);

  // Owner empty body
  const oRes = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    headers: { Origin: 'https://parkx.local', 'X-CSRF-Token': 'tok' },
    session: { userId: 1, csrfToken: 'tok' },
    body: { body: '   ' },
  }));
  assert.equal(oRes.status, 400);
});

test('Oversized messages (>2000 chars) are rejected with 400', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const { session, rawCredential } = pool.seedSession({ status: 'pending' });

  const oversized = 'A'.repeat(2001);
  const res = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: oversized },
  }));
  assert.equal(res.status, 400);
  assert.match(res.body.message, /must not exceed 2000 characters/i);
});

test('Invalid or missing visitor credential is rejected with 401 or 403', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const { session } = pool.seedSession({ status: 'pending' });

  // Missing credential
  const noCred = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    body: { body: 'Hello' },
  }));
  assert.equal(noCred.status, 401);

  // Wrong credential
  const wrongCred = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': 'vcred_' + '9'.repeat(64) },
    body: { body: 'Hello' },
  }));
  assert.equal(wrongCred.status, 403);
});

test('Cross-session access is rejected', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const s1 = pool.seedSession({ vehicleId: 10 });
  const s2 = pool.seedSession({ vehicleId: 20 });

  // Visitor 1 uses Credential 1 against Session 2
  const res = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${s2.session.public_id}/messages`,
    params: { id: s2.session.public_id },
    headers: { 'X-Visitor-Credential': s1.rawCredential },
    body: { body: 'Attempting cross-session message' },
  }));
  assert.equal(res.status, 403);
});

test('Cross-owner access is rejected (Owner 2 cannot access Owner 1 vehicle sessions)', async () => {
  const pool = createMockMessagingPool();
  const vehiclesRouter = createVehiclesRouter({ pool, origins: ['https://parkx.local'] });
  const { session } = pool.seedSession({ vehicleId: 10 }); // Owned by user 1

  // User 2 attempts to read messages of session belonging to User 1
  const readRes = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'GET',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    session: { userId: 2 }, // User 2 does NOT own vehicle 10
  }));
  assert.equal(readRes.status, 404);

  // User 2 attempts to reply
  const replyRes = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    headers: { Origin: 'https://parkx.local', 'X-CSRF-Token': 'tok' },
    session: { userId: 2, csrfToken: 'tok' },
    body: { body: 'Intruder reply' },
  }));
  assert.equal(replyRes.status, 404);
});

test('Closed sessions reject new visitor and owner messages with 400', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const vehiclesRouter = createVehiclesRouter({ pool, origins: ['https://parkx.local'] });
  const { session, rawCredential } = pool.seedSession({ vehicleId: 10, status: 'closed' });

  // Visitor attempts send
  const vRes = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Are you there?' },
  }));
  assert.equal(vRes.status, 400);
  assert.equal(vRes.body.status, 'closed');

  // Owner attempts send
  const oRes = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    headers: { Origin: 'https://parkx.local', 'X-CSRF-Token': 'tok' },
    session: { userId: 1, csrfToken: 'tok' },
    body: { body: 'Owner reply to closed session' },
  }));
  assert.equal(oRes.status, 400);
  assert.equal(oRes.body.status, 'closed');
});

test('Expired sessions reject new visitor and owner messages with 400', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const vehiclesRouter = createVehiclesRouter({ pool, origins: ['https://parkx.local'] });
  const past = new Date(Date.now() - 3600000);
  const { session, rawCredential } = pool.seedSession({ vehicleId: 10, status: 'pending', expiresAt: past });

  // Visitor attempts send to expired session
  const vRes = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Expired message attempt' },
  }));
  assert.equal(vRes.status, 400);
  assert.equal(vRes.body.status, 'expired');

  // Owner attempts send to expired session
  const oRes = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    headers: { Origin: 'https://parkx.local', 'X-CSRF-Token': 'tok' },
    session: { userId: 1, csrfToken: 'tok' },
    body: { body: 'Owner reply to expired session' },
  }));
  assert.equal(oRes.status, 400);
  assert.equal(oRes.body.status, 'expired');
});

test('Idempotency: duplicate retries with same clientMessageId do not duplicate messages', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const { session, rawCredential } = pool.seedSession({ status: 'pending' });

  const clientMessageId = 'cm_test_retry_12345';

  // First submission
  const res1 = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Network retry message test', clientMessageId },
  }));
  assert.equal(res1.status, 201);
  const firstId = res1.body.message.id;

  // Immediate retry with identical clientMessageId
  const res2 = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Network retry message test', clientMessageId },
  }));
  assert.equal(res2.status, 200);
  assert.equal(res2.body.message.id, firstId);
  assert.equal(res2.body.message.clientMessageId, clientMessageId);

  // Total messages in pool must be strictly 1
  assert.equal(pool.visitorMessages.length, 1);
});

test('Owner inbox returns message count and latest message preview', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const vehiclesRouter = createVehiclesRouter({ pool, origins: ['https://parkx.local'] });
  const { session, rawCredential } = pool.seedSession({ vehicleId: 10, status: 'pending' });

  // Visitor sends message
  await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Blocking the driveway!' },
  }));

  // Owner queries inbox
  const inboxRes = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'GET',
    url: '/sessions',
    session: { userId: 1 },
  }));

  assert.equal(inboxRes.status, 200);
  assert.equal(inboxRes.body.sessions.length, 1);
  const s = inboxRes.body.sessions[0];
  assert.equal(s.sessionId, session.public_id);
  assert.equal(s.messageCount, 1);
  assert.ok(s.lastMessage);
  assert.equal(s.lastMessage.body, 'Blocking the driveway!');
  assert.equal(s.lastMessage.senderType, 'visitor');
});

test('Client-supplied senderType is ignored by server', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const { session, rawCredential } = pool.seedSession({ status: 'pending' });

  // Visitor attempts to spoof senderType as 'owner'
  const res = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'I am pretending to be the owner', senderType: 'owner' },
  }));

  assert.equal(res.status, 201);
  // Server MUST derive senderType from endpoint auth, ignoring payload
  assert.equal(res.body.message.senderType, 'visitor');
});

test('Sensitive visitor credential is NEVER returned in message responses', async () => {
  const pool = createMockMessagingPool();
  const publicRouter = createPublicRouter({ pool });
  const { session, rawCredential } = pool.seedSession({ status: 'pending' });

  const sendRes = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Check credentials leakage' },
  }));

  const jsonStr = JSON.stringify(sendRes.body);
  assert.equal(jsonStr.includes(rawCredential), false);
  assert.equal(jsonStr.includes(session.credential_hash), false);

  const getRes = await invokeRouter(publicRouter, makeFakeReq({
    method: 'GET',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
  }));

  const getJsonStr = JSON.stringify(getRes.body);
  assert.equal(getJsonStr.includes(rawCredential), false);
  assert.equal(getJsonStr.includes(session.credential_hash), false);
});

test('Finding 2: Owner reply route rate limiting triggers 429 when threshold exceeded', async () => {
  const pool = createMockMessagingPool();
  const testLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session?.userId || 'unknown'),
    validate: { xForwardedForHeader: false, default: false },
    handler: (_req, res) => res.status(429).json({
      status: 'rate_limited',
      message: 'Too many messages sent. Please wait before sending more.',
    }),
  });

  const vehiclesRouter = createVehiclesRouter({
    pool,
    origins: ['https://parkx.local'],
    ownerMessageLimiter: testLimiter,
  });

  const { session } = pool.seedSession({ vehicleId: 10, status: 'pending' });

  const makeOwnerReq = (bodyText) => makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    headers: {
      origin: 'https://parkx.local',
      'x-csrf-token': 'owner-csrf-tok',
    },
    session: { userId: 1, csrfToken: 'owner-csrf-tok' },
    body: { body: bodyText },
  });

  // Message 1 -> 201
  const res1 = await invokeRouter(vehiclesRouter, makeOwnerReq('Reply 1'));
  assert.equal(res1.status, 201);
  assert.equal(res1.body.status, 'sent');

  // Message 2 -> 201
  const res2 = await invokeRouter(vehiclesRouter, makeOwnerReq('Reply 2'));
  assert.equal(res2.status, 201);
  assert.equal(res2.body.status, 'sent');

  // Message 3 -> 429 rate limited
  const res3 = await invokeRouter(vehiclesRouter, makeOwnerReq('Reply 3 (should block)'));
  assert.equal(res3.status, 429);
  assert.equal(res3.body.status, 'rate_limited');
  assert.equal(res3.body.message, 'Too many messages sent. Please wait before sending more.');
});

test('Finding 2: Owner reply rate limiting isolates counters per authenticated owner', async () => {
  const pool = createMockMessagingPool();
  const testLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session?.userId || 'unknown'),
    validate: { xForwardedForHeader: false, default: false },
    handler: (_req, res) => res.status(429).json({
      status: 'rate_limited',
      message: 'Too many messages sent. Please wait before sending more.',
    }),
  });

  const vehiclesRouter = createVehiclesRouter({
    pool,
    origins: ['https://parkx.local'],
    ownerMessageLimiter: testLimiter,
  });

  // Owner 1 session on vehicle 10
  const sess1 = pool.seedSession({ vehicleId: 10, status: 'pending' });
  // Owner 2 session on vehicle 20
  const sess2 = pool.seedSession({ vehicleId: 20, status: 'pending' });

  // Owner 1 sends message 1 -> 201
  const o1Res1 = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${sess1.session.public_id}/messages`,
    params: { sessionId: sess1.session.public_id },
    headers: { origin: 'https://parkx.local', 'x-csrf-token': 'csrf-1' },
    session: { userId: 1, csrfToken: 'csrf-1' },
    body: { body: 'Owner 1 first message' },
  }));
  assert.equal(o1Res1.status, 201);

  // Owner 1 sends message 2 -> 429
  const o1Res2 = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${sess1.session.public_id}/messages`,
    params: { sessionId: sess1.session.public_id },
    headers: { origin: 'https://parkx.local', 'x-csrf-token': 'csrf-1' },
    session: { userId: 1, csrfToken: 'csrf-1' },
    body: { body: 'Owner 1 second message' },
  }));
  assert.equal(o1Res2.status, 429);

  // Owner 2 sends message 1 -> 201 (unaffected by Owner 1 reaching rate limit)
  const o2Res1 = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${sess2.session.public_id}/messages`,
    params: { sessionId: sess2.session.public_id },
    headers: { origin: 'https://parkx.local', 'x-csrf-token': 'csrf-2' },
    session: { userId: 2, csrfToken: 'csrf-2' },
    body: { body: 'Owner 2 first message' },
  }));
  assert.equal(o2Res1.status, 201);
});

test('Finding 2: Owner reply rate limiting does not affect message reads or session actions', async () => {
  const pool = createMockMessagingPool();
  const testLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session?.userId || 'unknown'),
    validate: { xForwardedForHeader: false, default: false },
    handler: (_req, res) => res.status(429).json({
      status: 'rate_limited',
      message: 'Too many messages sent. Please wait before sending more.',
    }),
  });

  const vehiclesRouter = createVehiclesRouter({
    pool,
    origins: ['https://parkx.local'],
    ownerMessageLimiter: testLimiter,
  });

  const { session } = pool.seedSession({ vehicleId: 10, status: 'pending' });

  // 1. Send 1 message (exhausting the limiter)
  const res1 = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    headers: { origin: 'https://parkx.local', 'x-csrf-token': 'csrf-owner' },
    session: { userId: 1, csrfToken: 'csrf-owner' },
    body: { body: 'Owner message' },
  }));
  assert.equal(res1.status, 201);

  // 2. Next message is 429
  const res2 = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    headers: { origin: 'https://parkx.local', 'x-csrf-token': 'csrf-owner' },
    session: { userId: 1, csrfToken: 'csrf-owner' },
    body: { body: 'Exceeded' },
  }));
  assert.equal(res2.status, 429);

  // 3. Message reads (GET) must succeed with 200
  const readRes = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'GET',
    url: `/sessions/${session.public_id}/messages`,
    params: { sessionId: session.public_id },
    session: { userId: 1 },
  }));
  assert.equal(readRes.status, 200);
  assert.equal(readRes.body.messages.length, 1);

  // 4. Session close (POST) must succeed with 200
  const closeRes = await invokeRouter(vehiclesRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/close`,
    params: { sessionId: session.public_id },
    headers: { origin: 'https://parkx.local', 'x-csrf-token': 'csrf-owner' },
    session: { userId: 1, csrfToken: 'csrf-owner' },
    body: {},
  }));
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.body.status, 'closed');
});

test('Finding 1: Connection release and transaction rollback on query failure', async () => {
  let rollbacks = 0;
  let releases = 0;
  let begins = 0;

  const mockFailConn = {
    async beginTransaction() { begins += 1; },
    async commit() { throw new Error('Commit should not be reached'); },
    async rollback() { rollbacks += 1; },
    release() { releases += 1; },
    async query(sql) {
      if (sql.includes('SELECT') && sql.includes('FOR UPDATE')) {
        const err = new Error('Lock wait timeout exceeded');
        err.code = 'ER_LOCK_WAIT_TIMEOUT';
        throw err;
      }
      return [[]];
    },
  };

  const pool = {
    async getConnection() { return mockFailConn; },
    async query() { return [[]]; },
  };

  const validSessionId = 'vs_' + 'a'.repeat(48);
  const publicRouter = createPublicRouter({ pool });
  const res = await invokeRouter(publicRouter, makeFakeReq({
    method: 'POST',
    url: `/sessions/${validSessionId}/messages`,
    params: { id: validSessionId },
    headers: { 'X-Visitor-Credential': 'vcred_' + 'a'.repeat(64) },
    body: { body: 'Hello fail' },
  }));

  assert.equal(res.status, 500);
  assert.equal(res.body.status, 'error');
  assert.equal(begins, 1, 'Transaction must begin');
  assert.equal(rollbacks, 1, 'Transaction must be rolled back on error');
  assert.equal(releases, 1, 'Connection must be released in finally block');
});

test('Test-only synchronization hook: invoked in test mode, disabled in production, and no-op by default', async () => {
  const pool = createMockMessagingPool();
  const { session, rawCredential } = pool.seedSession({ vehicleId: 10, status: 'pending' });

  // 1. Hook is invoked when provided in non-production
  let hookInvokedWith = null;
  const testHook = {
    async onMessageRowLocked(meta) {
      hookInvokedWith = meta;
    },
  };

  const publicRouterWithHook = createPublicRouter({
    pool,
    _testHook: testHook,
  });

  const res1 = await invokeRouter(publicRouterWithHook, makeFakeReq({
    method: 'POST',
    url: `/sessions/${session.public_id}/messages`,
    params: { id: session.public_id },
    headers: { 'X-Visitor-Credential': rawCredential },
    body: { body: 'Testing hook' },
  }));

  assert.equal(res1.status, 201);
  assert.ok(hookInvokedWith);
  assert.equal(hookInvokedWith.sessionId, session.public_id);

  // 2. Hook is strictly ignored when NODE_ENV === 'production'
  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    let prodHookInvoked = false;
    const prodHook = {
      async onMessageRowLocked() { prodHookInvoked = true; },
    };

    const publicRouterProd = createPublicRouter({
      pool,
      _testHook: prodHook,
    });

    const res2 = await invokeRouter(publicRouterProd, makeFakeReq({
      method: 'POST',
      url: `/sessions/${session.public_id}/messages`,
      params: { id: session.public_id },
      headers: { 'X-Visitor-Credential': rawCredential },
      body: { body: 'Testing prod guard' },
    }));

    assert.equal(res2.status, 201);
    assert.equal(prodHookInvoked, false, 'Test hook must NEVER be invoked in production');
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});
