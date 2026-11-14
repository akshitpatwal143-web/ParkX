import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPublicRouter } from '../src/routes/public.js';
import { createVehiclesRouter } from '../src/routes/vehicles.js';
import {
  runVisitorSessionCleanup,
  startVisitorSessionCleanupTask,
  resetCleanupTaskForTesting,
  getCleanupTaskState,
} from '../src/services/sessionCleanup.js';
import { sanitizeDbErrorCode } from '../src/db.js';

function createMockVisitorPool() {
  const validToken = 'pkx_' + '1'.repeat(64);
  const validHash = createHash('sha256').update(validToken).digest('hex');

  const revokedToken = 'pkx_' + '2'.repeat(64);
  const revokedHash = createHash('sha256').update(revokedToken).digest('hex');

  const otherOwnerToken = 'pkx_' + '3'.repeat(64);
  const otherOwnerHash = createHash('sha256').update(otherOwnerToken).digest('hex');

  const vehicles = [
    { id: 10, user_id: 1, registration_number: 'PX-100', vehicle_type: 'car', vehicle_model: 'Tesla Model S', color: 'Midnight Silver' },
    { id: 20, user_id: 2, registration_number: 'PX-200', vehicle_type: 'suv', vehicle_model: 'Rivian R1S', color: 'Forest Green' },
  ];

  const qrCodes = [
    { id: 1, vehicle_id: 10, token_hash: validHash, status: 'active' },
    { id: 2, vehicle_id: 10, token_hash: revokedHash, status: 'revoked' },
    { id: 3, vehicle_id: 20, token_hash: otherOwnerHash, status: 'active' },
  ];

  const visitorSessions = [];
  let nextSessionId = 1;
  let simulateDbError = false;

  let lockHolder = false;
  const waiters = [];

  async function acquireLock() {
    if (!lockHolder) {
      lockHolder = true;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    lockHolder = true;
  }

  function releaseLock() {
    if (waiters.length > 0) {
      const next = waiters.shift();
      next();
    } else {
      lockHolder = false;
    }
  }

  const pool = {
    validToken,
    revokedToken,
    otherOwnerToken,
    visitorSessions,
    setDbError(val) {
      simulateDbError = val;
    },
    async getConnection() {
      if (simulateDbError) {
        const err = new Error('Database connection failed');
        err.code = 'ER_ACCESS_DENIED_ERROR';
        throw err;
      }
      let hasLock = false;
      return {
        async beginTransaction() {
          await acquireLock();
          hasLock = true;
        },
        async commit() {
          if (hasLock) {
            hasLock = false;
            releaseLock();
          }
        },
        async rollback() {
          if (hasLock) {
            hasLock = false;
            releaseLock();
          }
        },
        release() {
          if (hasLock) {
            hasLock = false;
            releaseLock();
          }
        },
        query: (sql, params) => pool.query(sql, params),
      };
    },
    async query(sql, params = []) {
      if (simulateDbError) {
        const err = new Error('Database connection failed');
        err.code = 'ER_ACCESS_DENIED_ERROR';
        throw err;
      }

      // 0. Preliminary candidate vehicle lookup (vehicle-first ordering)
      if (sql.includes('SELECT vehicle_id, status FROM qr_codes WHERE token_hash = ?')) {
        const hash = params[0];
        const qr = qrCodes.find((q) => q.token_hash === hash);
        if (!qr) return [[]];
        return [[{ vehicle_id: qr.vehicle_id, status: qr.status }]];
      }

      // 0b. Lock vehicle row first (vehicle-first ordering)
      if (sql.includes('FROM vehicles') && sql.includes('WHERE id = ?') && sql.includes('FOR UPDATE')) {
        const id = params[0];
        const v = vehicles.find((item) => item.id === id);
        if (!v) return [[]];
        return [[{ id: v.id, vehicle_type: v.vehicle_type, vehicle_model: v.vehicle_model, color: v.color }]];
      }

      // 0c. Lock and verify QR row second (vehicle-first ordering)
      if (sql.includes('FROM qr_codes') && sql.includes('WHERE token_hash = ?') && sql.includes('FOR UPDATE')) {
        const [hash, vId] = params;
        const qr = qrCodes.find((q) => q.token_hash === hash && (vId === undefined || q.vehicle_id === vId));
        if (!qr) return [[]];
        return [[{ id: qr.id, status: qr.status, vehicle_id: qr.vehicle_id }]];
      }

      // 1. SELECT qr_codes + vehicles lookup (with or without FOR UPDATE)
      if (sql.includes('FROM qr_codes q') && sql.includes('JOIN vehicles v') && sql.includes('WHERE q.token_hash = ?')) {
        const hash = params[0];
        const qr = qrCodes.find((q) => q.token_hash === hash);
        if (!qr) return [[]];
        const v = vehicles.find((item) => item.id === qr.vehicle_id);
        if (!v) return [[]];
        return [[{
          qr_id: qr.id,
          vehicle_id: qr.vehicle_id,
          qr_status: qr.status,
          locked_vehicle_id: v.id,
          vehicle_type: v.vehicle_type,
          vehicle_model: v.vehicle_model,
          color: v.color,
        }]];
      }

      // 2. Count active pending sessions for a vehicle
      if (sql.includes('COUNT(*) AS active_pending') && sql.includes('WHERE vehicle_id = ?')) {
        const vehicleId = params[0];
        const count = visitorSessions.filter(
          (s) => s.vehicle_id === vehicleId && s.status === 'pending' && new Date(s.expires_at).getTime() > Date.now()
        ).length;
        return [[{ active_pending: count }]];
      }

      // 3. Insert visitor session
      if (sql.includes('INSERT INTO visitor_sessions')) {
        const [publicId, vehicleId, credentialHash, createdAt, expiresAt] = params;
        const newRecord = {
          id: nextSessionId++,
          public_id: publicId,
          vehicle_id: vehicleId,
          credential_hash: credentialHash,
          status: 'pending',
          created_at: createdAt,
          expires_at: expiresAt,
          accepted_at: null,
          closed_at: null,
        };
        visitorSessions.push(newRecord);
        return [{ insertId: newRecord.id, affectedRows: 1 }];
      }

      // 4. Owner route conditional update: accept
      if (sql.includes('UPDATE visitor_sessions s') && sql.includes('JOIN vehicles v') && sql.includes("SET s.status = 'accepted'")) {
        const [acceptedAt, sessionId, userId, now] = params;
        const s = visitorSessions.find((item) => item.public_id === sessionId);
        const v = vehicles.find((item) => item.id === s?.vehicle_id && item.user_id === userId);
        if (s && v && s.status === 'pending' && new Date(s.expires_at).getTime() > new Date(now).getTime()) {
          s.status = 'accepted';
          s.accepted_at = acceptedAt;
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      // 5. Owner route conditional update: close
      if (sql.includes('UPDATE visitor_sessions s') && sql.includes('JOIN vehicles v') && sql.includes("SET s.status = 'closed'")) {
        const [closedAt, sessionId, userId, now] = params;
        const s = visitorSessions.find((item) => item.public_id === sessionId);
        const v = vehicles.find((item) => item.id === s?.vehicle_id && item.user_id === userId);
        if (s && v && ['pending', 'accepted'].includes(s.status) && new Date(s.expires_at).getTime() > new Date(now).getTime()) {
          s.status = 'closed';
          s.closed_at = closedAt;
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      // 6. Owner route: inspect session with strict ownership check
      if (sql.includes('FROM visitor_sessions s') && sql.includes('JOIN vehicles v') && sql.includes('WHERE s.public_id = ? AND v.user_id = ?')) {
        const [sessionId, userId] = params;
        const s = visitorSessions.find((item) => item.public_id === sessionId);
        if (!s) return [[]];
        const v = vehicles.find((item) => item.id === s.vehicle_id && item.user_id === userId);
        if (!v) return [[]];
        return [[{
          id: s.id,
          public_id: s.public_id,
          status: s.status,
          expires_at: s.expires_at,
          accepted_at: s.accepted_at,
          closed_at: s.closed_at,
          user_id: v.user_id,
        }]];
      }

      // 7. Visitor route conditional update: close
      if (sql.includes('UPDATE visitor_sessions') && sql.includes("SET status = 'closed'") && sql.includes('status IN (\'pending\', \'accepted\')')) {
        const [closedAt, id, now] = params;
        const s = visitorSessions.find((item) => item.id === id);
        if (s && ['pending', 'accepted'].includes(s.status) && new Date(s.expires_at).getTime() > new Date(now).getTime()) {
          s.status = 'closed';
          s.closed_at = closedAt;
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      // 8. Public route: retrieve visitor session by public_id
      if (sql.includes('FROM visitor_sessions s') && sql.includes('JOIN vehicles v') && sql.includes('WHERE s.public_id = ?')) {
        const publicId = params[0];
        const s = visitorSessions.find((item) => item.public_id === publicId);
        if (!s) return [[]];
        const v = vehicles.find((item) => item.id === s.vehicle_id);
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
          vehicle_model: v?.vehicle_model || 'Model',
          color: v?.color || 'Black',
        }]];
      }

      // 9. Update visitor session status to expired
      if (sql.includes("UPDATE visitor_sessions SET status = 'expired'")) {
        const id = params[params.length - 1];
        const s = visitorSessions.find((item) => item.id === id);
        if (s && s.status !== 'closed') {
          s.status = 'expired';
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      // 10. Select session single table
      if (sql.includes('FROM visitor_sessions') && (sql.includes('WHERE public_id = ?') || sql.includes('WHERE id = ?')) && !sql.includes('JOIN')) {
        const val = params[0];
        const s = visitorSessions.find((item) => item.public_id === val || item.id === val);
        return [s ? [s] : []];
      }

      // 11. Owner route: list sessions for vehicles owned by user_id
      if (sql.includes('FROM visitor_sessions s') && sql.includes('JOIN vehicles v') && sql.includes('WHERE v.user_id = ?')) {
        const userId = params[0];
        const ownedVehicles = vehicles.filter((v) => v.user_id === userId);
        const ownedIds = new Set(ownedVehicles.map((v) => v.id));

        let matching = visitorSessions.filter((s) => ownedIds.has(s.vehicle_id));
        if (params.length > 1 && typeof params[1] === 'number') {
          matching = matching.filter((s) => s.vehicle_id === params[1]);
        }

        const rows = matching.map((s) => {
          const v = vehicles.find((item) => item.id === s.vehicle_id);
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
          };
        });
        return [rows];
      }

      // 12. Retention cleanup: update expired
      if (sql.includes("UPDATE visitor_sessions") && sql.includes("SET status = 'expired'") && sql.includes("expires_at <= NOW()")) {
        let count = 0;
        const now = Date.now();
        for (const s of visitorSessions) {
          if (['pending', 'accepted'].includes(s.status) && new Date(s.expires_at).getTime() <= now) {
            s.status = 'expired';
            count++;
          }
        }
        return [{ affectedRows: count }];
      }

      // 13. Retention cleanup: delete expired or closed past retention
      if (sql.includes("DELETE FROM visitor_sessions WHERE status = 'closed'")) {
        const retentionDays = params[0] || 30;
        const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
        const toDelete = visitorSessions.filter((s) => s.status === 'closed' && new Date(s.closed_at || s.created_at).getTime() <= cutoff);
        for (const item of toDelete) {
          const idx = visitorSessions.indexOf(item);
          if (idx >= 0) visitorSessions.splice(idx, 1);
        }
        return [{ affectedRows: toDelete.length }];
      }

      if (sql.includes("DELETE FROM visitor_sessions WHERE status = 'expired'")) {
        const retentionDays = params[0] || 30;
        const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
        const toDelete = visitorSessions.filter((s) => s.status === 'expired' && new Date(s.expires_at).getTime() <= cutoff);
        for (const item of toDelete) {
          const idx = visitorSessions.indexOf(item);
          if (idx >= 0) visitorSessions.splice(idx, 1);
        }
        return [{ affectedRows: toDelete.length }];
      }

      if (sql.includes("DELETE FROM visitor_sessions")) {
        const initialLen = visitorSessions.length;
        const retentionDays = params[0] || 30;
        const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
        const kept = visitorSessions.filter((s) => {
          if (s.status === 'closed') {
            return new Date(s.closed_at || s.created_at).getTime() > cutoff;
          }
          if (s.status === 'expired') {
            return new Date(s.expires_at).getTime() > cutoff;
          }
          return true; // Never delete pending or accepted
        });
        visitorSessions.length = 0;
        visitorSessions.push(...kept);
        return [{ affectedRows: initialLen - kept.length }];
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

function makeReq({ method = 'GET', url = '/', headers = {}, body = {}, session = {}, ip = '127.0.0.1' } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url,
    originalUrl: url,
    headers: Object.fromEntries(headerMap),
    body,
    params: {},
    query: {},
    session,
    ip,
    app: {
      get(name) {
        if (name === 'trust proxy') return false;
        return undefined;
      },
    },
    get(name) {
      return headerMap.get(name.toLowerCase());
    },
    header(name) {
      return headerMap.get(name.toLowerCase());
    },
  };
}

test('Phase 3.2: Anonymous Visitor Sessions Suite', async (t) => {
  const pool = createMockVisitorPool();
  const dummyLimiter = (_req, _res, next) => next();

  const publicRouter = createPublicRouter({
    pool,
    limiter: dummyLimiter,
    sessionCreateLimiter: dummyLimiter,
    sessionReadLimiter: dummyLimiter,
  });

  const vehiclesRouter = createVehiclesRouter({
    pool,
    origins: ['http://localhost:5173'],
  });

  let createdSessionId = '';
  let createdCredential = '';

  await t.test('1. Valid QR creates a visitor session with secure credentials', async () => {
    const req = makeReq({
      method: 'POST',
      url: '/sessions',
      body: { token: pool.validToken },
    });

    const res = await invokeRouter(publicRouter, req);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'pending');
    assert.match(res.body.sessionId, /^vs_[0-9a-f]{48}$/);
    assert.match(res.body.visitorCredential, /^vcred_[0-9a-f]{64}$/);
    assert.ok(res.body.createdAt);
    assert.ok(res.body.expiresAt);
    assert.deepEqual(res.body.vehicle, {
      vehicleType: 'car',
      vehicleModel: 'Tesla Model S',
      color: 'Midnight Silver',
    });

    createdSessionId = res.body.sessionId;
    createdCredential = res.body.visitorCredential;

    const dbRecord = pool.visitorSessions.find((s) => s.public_id === createdSessionId);
    assert.ok(dbRecord);
    assert.notEqual(dbRecord.credential_hash, createdCredential);
    const expectedHash = createHash('sha256').update(createdCredential).digest('hex');
    assert.equal(dbRecord.credential_hash, expectedHash);
  });

  await t.test('2. Invalid, revoked, and malformed QR tokens cannot create sessions', async () => {
    // Revoked QR token
    const revokedReq = makeReq({
      method: 'POST',
      url: '/sessions',
      body: { token: pool.revokedToken },
    });
    const revokedRes = await invokeRouter(publicRouter, revokedReq);
    assert.equal(revokedRes.status, 410);
    assert.equal(revokedRes.body.status, 'revoked');

    // Unknown QR token
    const unknownToken = 'pkx_' + '9'.repeat(64);
    const unknownReq = makeReq({
      method: 'POST',
      url: '/sessions',
      body: { token: unknownToken },
    });
    const unknownRes = await invokeRouter(publicRouter, unknownReq);
    assert.equal(unknownRes.status, 404);
    assert.equal(unknownRes.body.status, 'invalid');

    // Malformed token
    const malformedReq = makeReq({
      method: 'POST',
      url: '/sessions',
      body: { token: 'invalid_malformed_token' },
    });
    const malformedRes = await invokeRouter(publicRouter, malformedReq);
    assert.equal(malformedRes.status, 400);
    assert.equal(malformedRes.body.status, 'invalid');
  });

  await t.test('3. Visitor can retrieve their own session using the credential', async () => {
    const req = makeReq({
      method: 'GET',
      url: `/sessions/${createdSessionId}`,
      headers: {
        'X-Visitor-Credential': createdCredential,
      },
    });

    const res = await invokeRouter(publicRouter, req);
    assert.equal(res.status, 200);
    assert.equal(res.body.sessionId, createdSessionId);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.credential_hash, undefined);
    assert.equal(res.body.visitorCredential, undefined);
  });

  await t.test('4. Another visitor without valid credential cannot access the session', async () => {
    const fakeCredential = 'vcred_' + 'f'.repeat(64);
    const req = makeReq({
      method: 'GET',
      url: `/sessions/${createdSessionId}`,
      headers: {
        'X-Visitor-Credential': fakeCredential,
      },
    });

    const res = await invokeRouter(publicRouter, req);
    assert.equal(res.status, 403);
    assert.equal(res.body.status, 'forbidden');

    // Missing credential returns 401
    const noCredReq = makeReq({
      method: 'GET',
      url: `/sessions/${createdSessionId}`,
    });
    const noCredRes = await invokeRouter(publicRouter, noCredReq);
    assert.equal(noCredRes.status, 401);
  });

  await t.test('5. Owner can list only sessions for their owned vehicles', async () => {
    const csrfToken = 'test-owner-csrf-token';
    const req = makeReq({
      method: 'GET',
      url: '/sessions',
      session: { userId: 1, csrfToken },
    });

    const res = await invokeRouter(vehiclesRouter, req);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.sessions));
    assert.equal(res.body.sessions.length, 1);
    assert.equal(res.body.sessions[0].sessionId, createdSessionId);
    assert.equal(res.body.sessions[0].vehicle.registrationNumber, 'PX-100');

    // Owner 2 cannot see Owner 1's sessions
    const reqOwner2 = makeReq({
      method: 'GET',
      url: '/sessions',
      session: { userId: 2, csrfToken },
    });
    const resOwner2 = await invokeRouter(vehiclesRouter, reqOwner2);
    assert.equal(resOwner2.status, 200);
    assert.equal(resOwner2.body.sessions.length, 0);
  });

  await t.test('6. Owner can accept pending session', async () => {
    const csrfToken = 'test-owner-csrf-token';
    const req = makeReq({
      method: 'POST',
      url: `/sessions/${createdSessionId}/accept`,
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': csrfToken,
      },
      session: { userId: 1, csrfToken },
    });

    const res = await invokeRouter(vehiclesRouter, req);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'accepted');
    assert.ok(res.body.acceptedAt);

    // Verify session now shows as accepted to visitor
    const visitorReq = makeReq({
      method: 'GET',
      url: `/sessions/${createdSessionId}`,
      headers: {
        'X-Visitor-Credential': createdCredential,
      },
    });
    const visitorRes = await invokeRouter(publicRouter, visitorReq);
    assert.equal(visitorRes.status, 200);
    assert.equal(visitorRes.body.status, 'accepted');
  });

  await t.test('7. Cross-owner access is strictly denied', async () => {
    const csrfToken = 'test-owner2-csrf';
    const req = makeReq({
      method: 'POST',
      url: `/sessions/${createdSessionId}/close`,
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': csrfToken,
      },
      session: { userId: 2, csrfToken }, // User 2 does NOT own this vehicle
    });

    const res = await invokeRouter(vehiclesRouter, req);
    assert.equal(res.status, 404);
  });

  await t.test('8. Visitor can close their own session', async () => {
    const req = makeReq({
      method: 'POST',
      url: `/sessions/${createdSessionId}/close`,
      headers: {
        'X-Visitor-Credential': createdCredential,
      },
      body: { credential: createdCredential },
    });

    const res = await invokeRouter(publicRouter, req);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'closed');
    assert.ok(res.body.closedAt);
  });

  await t.test('9. Expired session cannot be accepted by owner', async () => {
    const expiredPublicId = 'vs_' + 'e'.repeat(48);
    const expiredCred = 'vcred_' + 'e'.repeat(64);
    const expiredHash = createHash('sha256').update(expiredCred).digest('hex');

    pool.visitorSessions.push({
      id: 999,
      public_id: expiredPublicId,
      vehicle_id: 10,
      credential_hash: expiredHash,
      status: 'pending',
      created_at: new Date(Date.now() - 48 * 3600 * 1000),
      expires_at: new Date(Date.now() - 1000),
      accepted_at: null,
      closed_at: null,
    });

    const csrfToken = 'owner-csrf';
    const req = makeReq({
      method: 'POST',
      url: `/sessions/${expiredPublicId}/accept`,
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': csrfToken,
      },
      session: { userId: 1, csrfToken },
    });

    const res = await invokeRouter(vehiclesRouter, req);
    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'expired');
  });

  await t.test('10. Database errors are sanitized and never leak internals', async () => {
    pool.setDbError(true);
    try {
      const req = makeReq({
        method: 'POST',
        url: '/sessions',
        body: { token: pool.validToken },
      });
      const res = await invokeRouter(publicRouter, req);
      assert.equal(res.status, 500);
      assert.equal(res.body.status, 'error');
      assert.equal(res.body.message, 'Unable to initiate contact session at this time. Please retry.');
      assert.equal(res.body.code, undefined);
      assert.equal(res.body.sql, undefined);
    } finally {
      pool.setDbError(false);
    }
  });

  await t.test('11. Atomic 5-pending-session limit: 6th simultaneous request is rejected with 429', async () => {
    const freshPool = createMockVisitorPool();
    const testRouter = createPublicRouter({
      pool: freshPool,
      limiter: dummyLimiter,
      sessionCreateLimiter: dummyLimiter,
      sessionReadLimiter: dummyLimiter,
    });

    // Fire 6 simultaneous creation requests
    const promises = Array.from({ length: 6 }).map(() => {
      const req = makeReq({
        method: 'POST',
        url: '/sessions',
        body: { token: freshPool.validToken },
      });
      return invokeRouter(testRouter, req);
    });

    const results = await Promise.all(promises);
    const created = results.filter((r) => r.status === 201);
    const rateLimited = results.filter((r) => r.status === 429);

    assert.equal(created.length, 5, 'Exactly 5 sessions must be created');
    assert.equal(rateLimited.length, 1, '6th request must be rate limited with 429');
    assert.equal(rateLimited[0].body.status, 'rate_limited');
  });

  await t.test('12. State transitions: zero affectedRows and closed session cannot be accepted', async () => {
    // Attempting to accept the already closed session from test 8
    const csrfToken = 'test-owner-csrf-token';
    const req = makeReq({
      method: 'POST',
      url: `/sessions/${createdSessionId}/accept`,
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': csrfToken,
      },
      session: { userId: 1, csrfToken },
    });

    const res = await invokeRouter(vehiclesRouter, req);
    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'closed');
  });

  await t.test('13. State transitions: expired owner close cannot close an expired session', async () => {
    const csrfToken = 'owner-csrf';
    const expiredPublicId = 'vs_' + 'e'.repeat(48);
    const req = makeReq({
      method: 'POST',
      url: `/sessions/${expiredPublicId}/close`,
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': csrfToken,
      },
      session: { userId: 1, csrfToken },
    });

    const res = await invokeRouter(vehiclesRouter, req);
    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'expired');
  });

  await t.test('14. Session retention cleanup policy: expires unclosed past TTL and purges past 30 days', async () => {
    const cleanupPool = createMockVisitorPool();
    const now = Date.now();

    // 1. Session unexpired pending: created 2h ago, expires in 22h -> should stay pending
    cleanupPool.visitorSessions.push({
      id: 101,
      public_id: 'vs_active_1',
      vehicle_id: 10,
      credential_hash: 'hash1',
      status: 'pending',
      created_at: new Date(now - 2 * 3600 * 1000),
      expires_at: new Date(now + 22 * 3600 * 1000),
      accepted_at: null,
      closed_at: null,
    });

    // 2. Session past TTL: created 26h ago, expired 2h ago -> should be transitioned to 'expired'
    cleanupPool.visitorSessions.push({
      id: 102,
      public_id: 'vs_past_ttl_2',
      vehicle_id: 10,
      credential_hash: 'hash2',
      status: 'pending',
      created_at: new Date(now - 26 * 3600 * 1000),
      expires_at: new Date(now - 2 * 3600 * 1000),
      accepted_at: null,
      closed_at: null,
    });

    // 3. Closed session retained: closed 5 days ago (< 30 days) -> should be kept
    cleanupPool.visitorSessions.push({
      id: 103,
      public_id: 'vs_closed_recent_3',
      vehicle_id: 10,
      credential_hash: 'hash3',
      status: 'closed',
      created_at: new Date(now - 6 * 24 * 3600 * 1000),
      expires_at: new Date(now - 5 * 24 * 3600 * 1000),
      accepted_at: null,
      closed_at: new Date(now - 5 * 24 * 3600 * 1000),
    });

    // 4. Closed session past retention: closed 35 days ago (> 30 days) -> should be purged
    cleanupPool.visitorSessions.push({
      id: 104,
      public_id: 'vs_closed_old_4',
      vehicle_id: 10,
      credential_hash: 'hash4',
      status: 'closed',
      created_at: new Date(now - 36 * 24 * 3600 * 1000),
      expires_at: new Date(now - 35 * 24 * 3600 * 1000),
      accepted_at: null,
      closed_at: new Date(now - 35 * 24 * 3600 * 1000),
    });

    // Execute cleanup
    const result = await runVisitorSessionCleanup(cleanupPool, { retentionDays: 30 });
    assert.equal(result.expiredCount, 1);
    assert.equal(result.deletedCount, 1);

    // Verify session 102 is now expired
    const s102 = cleanupPool.visitorSessions.find((s) => s.id === 102);
    assert.equal(s102.status, 'expired');

    // Verify session 101 is still pending
    const s101 = cleanupPool.visitorSessions.find((s) => s.id === 101);
    assert.equal(s101.status, 'pending');

    // Verify session 103 (recent closed) is preserved
    const s103 = cleanupPool.visitorSessions.find((s) => s.id === 103);
    assert.ok(s103);

    // Verify session 104 (old closed) was deleted
    const s104 = cleanupPool.visitorSessions.find((s) => s.id === 104);
    assert.equal(s104, undefined);
  });

  await t.test('15. Safe DB error code sanitization allowlists known codes and replaces unknown codes', () => {
    assert.equal(sanitizeDbErrorCode('ER_DUP_ENTRY'), 'ER_DUP_ENTRY');
    assert.equal(sanitizeDbErrorCode('ER_LOCK_WAIT_TIMEOUT'), 'ER_LOCK_WAIT_TIMEOUT');
    assert.equal(sanitizeDbErrorCode('ECONNREFUSED'), 'ECONNREFUSED');
    assert.equal(sanitizeDbErrorCode('UNKNOWN_ARBITRARY_CODE'), 'DB_CONNECTION_ERROR');
    assert.equal(sanitizeDbErrorCode(null), 'DB_CONNECTION_ERROR');
    assert.equal(sanitizeDbErrorCode(undefined), 'DB_CONNECTION_ERROR');
  });

  await t.test('16. Concurrent accept and close requests yield one consistent persisted outcome', async () => {
    const racePool = createMockVisitorPool();
    const routerPub = createPublicRouter({
      pool: racePool,
      limiter: dummyLimiter,
      sessionCreateLimiter: dummyLimiter,
      sessionReadLimiter: dummyLimiter,
    });
    const routerVeh = createVehiclesRouter({
      pool: racePool,
      origins: ['http://localhost:5173'],
    });

    // Create session
    const createReq = makeReq({
      method: 'POST',
      url: '/sessions',
      body: { token: racePool.validToken },
    });
    const createRes = await invokeRouter(routerPub, createReq);
    assert.equal(createRes.status, 201);
    const sid = createRes.body.sessionId;
    const cred = createRes.body.visitorCredential;

    // Simulate concurrent close and accept
    const csrfToken = 'race-csrf';
    const closeReq = makeReq({
      method: 'POST',
      url: `/sessions/${sid}/close`,
      headers: { 'X-Visitor-Credential': cred },
      body: { credential: cred },
    });
    const acceptReq = makeReq({
      method: 'POST',
      url: `/sessions/${sid}/accept`,
      headers: { Origin: 'http://localhost:5173', 'X-CSRF-Token': csrfToken },
      session: { userId: 1, csrfToken },
    });

    const [closeRes, acceptRes] = await Promise.all([
      invokeRouter(routerPub, closeReq),
      invokeRouter(routerVeh, acceptReq),
    ]);

    // One of them must succeed, and the resulting state must be valid
    const finalSession = racePool.visitorSessions.find((s) => s.public_id === sid);
    assert.ok(['accepted', 'closed'].includes(finalSession.status));

    // If it ended up closed, accept must either have succeeded before close or failed with status closed
    if (finalSession.status === 'closed') {
      assert.ok([200, 400].includes(acceptRes.status));
      assert.equal(closeRes.status, 200);
    }
  });

  await t.test('17. Configured rate limiters actually trigger when thresholds are exceeded', async () => {
    const rlPool = createMockVisitorPool();
    // Use real express-rate-limit configured with no mock limiters passed
    const rateLimitedRouter = createPublicRouter({
      pool: rlPool,
      // Pass no mock limiters so defaultCreateLimiter (max: 15) and others are used
    });

    const testIp = '198.51.100.42';

    // 1..15 requests from testIp to POST /sessions should be accepted by rate limiter (handled by router)
    for (let i = 1; i <= 15; i++) {
      const req = makeReq({
        method: 'POST',
        url: '/sessions',
        body: { token: rlPool.revokedToken }, // will return 410, proving handler ran past limiter
        ip: testIp,
      });
      const res = await invokeRouter(rateLimitedRouter, req);
      assert.equal(res.status, 410, `Request ${i} should reach handler and return 410`);
      assert.ok(res.headers['ratelimit-remaining'] !== undefined || res.headers['x-ratelimit-remaining'] !== undefined);
    }

    // 16th request must trigger HTTP 429 from defaultCreateLimiter
    const req16 = makeReq({
      method: 'POST',
      url: '/sessions',
      body: { token: rlPool.revokedToken },
      ip: testIp,
    });
    const res16 = await invokeRouter(rateLimitedRouter, req16);
    assert.equal(res16.status, 429, '16th request must exceed default max:15 and return 429');
    assert.deepEqual(res16.body, {
      status: 'rate_limited',
      message: 'Too many contact requests created. Please wait before trying again.',
    });
    // Standard headers
    assert.ok(res16.headers['retry-after'], 'Must set Retry-After header on 429');
    assert.equal(res16.headers['ratelimit-limit'], '15', 'RateLimit-Limit header must be 15');
    assert.equal(res16.headers['ratelimit-remaining'], '0', 'RateLimit-Remaining header must be 0');
    assert.ok(res16.headers['ratelimit-reset'], 'RateLimit-Reset header must be present');

    // Independent limiter groups verification:
    // Hitting createLimiter must NOT block sessionReadLimiter (GET /sessions/:id) or verifyLimiter (GET /vehicles/:token)
    const verifyReq = makeReq({
      method: 'GET',
      url: `/vehicles/${rlPool.validToken}`,
      ip: testIp,
    });
    const verifyRes = await invokeRouter(rateLimitedRouter, verifyReq);
    assert.equal(verifyRes.status, 200, 'verifyLimiter must not be blocked when createLimiter is exhausted');

    const readReq = makeReq({
      method: 'GET',
      url: '/sessions/vs_unknown_123',
      ip: testIp,
    });
    const readRes = await invokeRouter(rateLimitedRouter, readReq);
    assert.notEqual(readRes.status, 429, 'sessionReadLimiter must not be blocked when createLimiter is exhausted');
  });

  await t.test('18. Vehicle route sendError sanitizes unknown DB codes and omits raw error messages', async () => {
    const errorLogs = [];
    const mockLogger = {
      error: (msg, meta) => errorLogs.push({ msg, meta }),
      warn: (msg, meta) => errorLogs.push({ msg, meta }),
      info: () => {},
    };

    const faultyPool = {
      async query() {
        const err = new Error('FATAL SECRET SQL: SELECT * FROM secret_passwords WHERE id = 99');
        err.code = 'UNKNOWN_INJECTED_ERROR';
        err.errno = 12345;
        throw err;
      },
    };

    const faultyVehiclesRouter = createVehiclesRouter({
      pool: faultyPool,
      logger: mockLogger,
      origins: ['http://localhost:5173'],
    });

    const csrfToken = 'test-owner-csrf-token';
    const req = makeReq({
      method: 'GET',
      url: '/',
      headers: {
        Origin: 'http://localhost:5173',
        'X-CSRF-Token': csrfToken,
      },
      session: { userId: 1, csrfToken },
    });

    const res = await invokeRouter(faultyVehiclesRouter, req);
    assert.equal(res.status, 500);
    assert.equal(res.body.message, 'Internal server error');

    // Verify error was logged with sanitized code and safe errno
    assert.ok(errorLogs.length > 0, 'Logger must record error');
    const logEntry = errorLogs.find((l) => l.msg === 'Vehicle request failed');
    assert.ok(logEntry, 'Must log Vehicle request failed');
    assert.equal(logEntry.meta.code, 'DB_CONNECTION_ERROR', 'Unknown code must be sanitized to DB_CONNECTION_ERROR');
    assert.equal(logEntry.meta.errno, 12345, 'Safe errno must be recorded');
    assert.equal(logEntry.meta.status, 500);

    // Verify raw error message and secret query are NOT logged anywhere
    const serializedLogs = JSON.stringify(errorLogs);
    assert.equal(serializedLogs.includes('secret_passwords'), false, 'Raw SQL/secret must not appear in logs');
    assert.equal(serializedLogs.includes('FATAL SECRET SQL'), false, 'Raw error message must not appear in logs');
  });

  await t.test('19. Session cleanup task lifecycle: singleton, idempotent shutdown, and safe error handling', async () => {
    resetCleanupTaskForTesting();
    const mockPool = createMockVisitorPool();

    // 1. Start singleton task
    const task1 = startVisitorSessionCleanupTask({
      pool: mockPool,
      intervalMs: 10000,
    });
    assert.ok(task1, 'Task instance must be returned');

    // 2. Repeated start() call returns the identical instance (no duplicate timers)
    const task2 = startVisitorSessionCleanupTask({
      pool: mockPool,
      intervalMs: 10000,
    });
    assert.equal(task1, task2, 'Repeated start() must return the same singleton instance');
    assert.equal(task1.hasTimer, true, 'Timer should be active');

    // 3. Trigger run and verify safe DB failure handling without throwing
    mockPool.setDbError(true);
    const failResult = await task1.triggerNow();
    assert.equal(failResult.error, 'ER_ACCESS_DENIED_ERROR', 'Failure must be caught safely');
    assert.equal(task1.hasTimer, true, 'Timer must remain active despite run failure');
    mockPool.setDbError(false);

    // 4. In-flight run completion on shutdown
    let resolveSlowQuery;
    const slowQueryPromise = new Promise((resolve) => {
      resolveSlowQuery = resolve;
    });
    const slowPool = {
      async query() {
        await slowQueryPromise;
        return [{ affectedRows: 0 }];
      },
    };

    resetCleanupTaskForTesting();
    const slowTask = startVisitorSessionCleanupTask({
      pool: slowPool,
      intervalMs: 10000,
    });

    // Start background run
    const inFlightPromise = slowTask.triggerNow();
    assert.equal(slowTask.isRunning, true, 'Task should report isRunning while active');

    // Initiate stop while in-flight
    let stopResolved = false;
    const stopPromise = slowTask.stop().then(() => {
      stopResolved = true;
    });

    // Stop must NOT resolve until active query finishes
    assert.equal(stopResolved, false, 'stop() must wait for in-flight cleanup to finish');
    resolveSlowQuery();
    await stopPromise;
    await inFlightPromise;
    assert.equal(stopResolved, true, 'stop() resolved after in-flight cleanup completed');

    // 5. Repeated stop() calls are idempotent
    await slowTask.stop();
    await slowTask.stop();
    assert.equal(getCleanupTaskState().hasTimer, false);

    // 6. No new runs execute after stop
    const afterStopResult = await slowTask.triggerNow();
    assert.equal(afterStopResult.skipped, true, 'No runs allowed after shutdown');

    // 7. A restart while an older generation drains must remain the singleton.
    let releaseOldRun;
    const oldRunGate = new Promise((resolve) => { releaseOldRun = resolve; });
    const oldPool = { async query() { await oldRunGate; return [{ affectedRows: 0 }]; } };
    const newPool = { async query() { return [{ affectedRows: 0 }]; } };
    const oldTask = startVisitorSessionCleanupTask({ pool: oldPool, intervalMs: 10000 });
    const oldRun = oldTask.triggerNow();
    const firstStop = oldTask.stop();
    const repeatedStop = oldTask.stop();
    assert.equal(firstStop, repeatedStop, 'Repeated stop calls share the same drain operation');
    const newTask = startVisitorSessionCleanupTask({ pool: newPool, intervalMs: 10000 });
    assert.notEqual(newTask, oldTask, 'Restart creates a new generation while the old one drains');
    assert.equal(startVisitorSessionCleanupTask({ pool: newPool, intervalMs: 10000 }), newTask);
    assert.deepEqual(await newTask.triggerNow(), { overlapping: true }, 'New work waits for the old in-flight run');
    releaseOldRun();
    await Promise.all([firstStop, oldRun]);
    assert.equal(getCleanupTaskState().hasTimer, true, 'Old stop must not clear the restarted timer');
    assert.equal(startVisitorSessionCleanupTask({ pool: newPool, intervalMs: 10000 }), newTask);
    assert.deepEqual(await newTask.triggerNow(), { expiredCount: 0, deletedCount: 0 });
    await newTask.stop();
    assert.equal(getCleanupTaskState().hasTimer, false);

    resetCleanupTaskForTesting();
  });
});
