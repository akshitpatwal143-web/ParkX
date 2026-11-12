import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import { createApp } from '../src/index.js';

const origin = 'http://localhost:5173';
const env = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-secret-that-is-at-least-32-bytes-long',
  ALLOWED_ORIGINS: origin,
};

function createMockPool() {
  const validToken = 'pkx_' + 'a'.repeat(64);
  const validHash = createHash('sha256').update(validToken).digest('hex');

  const revokedToken = 'pkx_' + 'b'.repeat(64);
  const revokedHash = createHash('sha256').update(revokedToken).digest('hex');

  const vehicles = [
    { id: 1, user_id: 10, registration_number: 'SECRET-PLATE-1', vehicle_type: 'ev', vehicle_model: 'Porsche Taycan 4S', color: 'Frozen Blue' },
    { id: 2, user_id: 20, registration_number: 'SECRET-PLATE-2', vehicle_type: 'suv', vehicle_model: 'Audi e-tron', color: 'Mythos Black' },
  ];

  const qrCodes = [
    { id: 101, vehicle_id: 1, token_hash: validHash, status: 'active' },
    { id: 102, vehicle_id: 2, token_hash: revokedHash, status: 'revoked' },
  ];

  let simulateDbFailure = false;

  const pool = {
    validToken,
    revokedToken,
    setDbFailure(val) {
      simulateDbFailure = val;
    },
    async query(sql, params = []) {
      if (simulateDbFailure) {
        const error = new Error('Connection lost');
        error.code = 'PROTOCOL_CONNECTION_LOST';
        throw error;
      }

      if (sql.startsWith('SELECT 1')) return [[{ 1: 1 }]];

      // Public verification query
      if (sql.includes('FROM qr_codes q') && sql.includes('JOIN vehicles v') && sql.includes('WHERE q.token_hash = ?')) {
        const hash = params[0];
        const qr = qrCodes.find((q) => q.token_hash === hash);
        if (!qr) return [[], []];
        const v = vehicles.find((item) => item.id === qr.vehicle_id);
        if (!v) return [[], []];
        return [[{
          qr_status: qr.status,
          vehicle_type: v.vehicle_type,
          vehicle_model: v.vehicle_model,
          color: v.color,
        }], []];
      }

      throw new Error(`Unhandled test query: ${sql}`);
    },
  };

  return pool;
}

const servers = [];
async function createHarness(options = {}) {
  const pool = options.pool || createMockPool();
  const store = new session.MemoryStore();
  const publicLimiter = options.publicLimiter || rateLimit({
    windowMs: 60 * 1000,
    max: 1000, // Generous limit for functional tests
    standardHeaders: true,
    legacyHeaders: false,
  });

  const app = createApp({
    env,
    pool,
    store,
    publicLimiter,
    vehicleLogger: options.logger || console,
  });

  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return { baseUrl, pool };
}

after(() => {
  for (const server of servers) {
    server.close();
  }
});

test('Phase 3.1: Public QR Token Verification Suite', async (t) => {
  const logEntries = [];
  const testLogger = {
    error: (msg, meta) => logEntries.push({ level: 'error', msg, meta }),
    warn: (msg, meta) => logEntries.push({ level: 'warn', msg, meta }),
    info: (msg, meta) => logEntries.push({ level: 'info', msg, meta }),
  };

  const { baseUrl, pool } = await createHarness({ logger: testLogger });

  await t.test('1. Valid active QR pass verification without authentication', async () => {
    // Unauthenticated GET (no cookies, no session)
    const res = await fetch(`${baseUrl}/api/public/vehicles/${pool.validToken}`);
    assert.equal(res.status, 200);

    // Verify security headers
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(res.headers.get('cache-control')?.includes('no-store'));

    const body = await res.json();
    assert.equal(body.status, 'valid');
    assert.deepEqual(body.vehicle, {
      vehicleType: 'ev',
      vehicleModel: 'Porsche Taycan 4S',
      color: 'Frozen Blue',
    });

    // PRIVACY VERIFICATION: Ensure internal IDs, hashes, owner IDs, and plates are NEVER exposed
    assert.equal(body.vehicle.id, undefined);
    assert.equal(body.vehicle.user_id, undefined);
    assert.equal(body.vehicle.userId, undefined);
    assert.equal(body.vehicle.registrationNumber, undefined);
    assert.equal(body.vehicle.registration_number, undefined);
    assert.equal(body.tokenHash, undefined);
  });

  await t.test('2. Revoked QR pass returns 410 Gone with revoked status', async () => {
    const res = await fetch(`${baseUrl}/api/public/vehicles/${pool.revokedToken}`);
    assert.equal(res.status, 410);

    const body = await res.json();
    assert.equal(body.status, 'revoked');
    assert.ok(body.message.includes('revoked'));
    // Ensure no vehicle details leaked
    assert.equal(body.vehicle, undefined);
  });

  await t.test('3. Unknown token returns 404 with invalid status', async () => {
    const unknownToken = 'pkx_' + 'f'.repeat(64);
    const res = await fetch(`${baseUrl}/api/public/vehicles/${unknownToken}`);
    assert.equal(res.status, 404);

    const body = await res.json();
    assert.equal(body.status, 'invalid');
    assert.equal(body.vehicle, undefined);
  });

  await t.test('4. Malformed token rejected with 400', async () => {
    const malformedCases = [
      'invalid-token',
      'pkx_123',
      'pkx_' + 'z'.repeat(64), // non-hex
      'pkx_' + 'a'.repeat(63), // too short
      'pkx_' + 'a'.repeat(65), // too long
      'random_string_here',
      '../etc/passwd',
    ];

    for (const token of malformedCases) {
      const res = await fetch(`${baseUrl}/api/public/vehicles/${encodeURIComponent(token)}`);
      assert.equal(res.status, 400, `Expected 400 for malformed token: ${token}`);
      const body = await res.json();
      assert.equal(body.status, 'invalid');
      assert.equal(body.vehicle, undefined);
    }
  });

  await t.test('5. Missing token route handling', async () => {
    const res = await fetch(`${baseUrl}/api/public/vehicles/`);
    // Express router without token param hits 404
    assert.equal(res.status, 404);
  });

  await t.test('6. Cross-owner vehicle data isolation', async () => {
    // Valid token only returns that specific vehicle's minimal info
    const res = await fetch(`${baseUrl}/api/public/vehicles/${pool.validToken}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.vehicle.vehicleModel, 'Porsche Taycan 4S');
    // Ensure other vehicles are NOT present
    assert.equal(body.vehicles, undefined);
  });

  await t.test('7. Database failure returns 500 without leaking internals', async () => {
    pool.setDbFailure(true);
    const res = await fetch(`${baseUrl}/api/public/vehicles/${pool.validToken}`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.equal(body.message, 'Verification service temporarily unavailable.');
    assert.equal(body.sql, undefined);
    pool.setDbFailure(false);
  });

  await t.test('8. Raw token is ABSENT from logs', async () => {
    // Check all log entries captured by testLogger
    for (const entry of logEntries) {
      const entryStr = JSON.stringify(entry);
      assert.ok(!entryStr.includes(pool.validToken), 'Raw token found in logs!');
      assert.ok(!entryStr.includes('a'.repeat(64)), 'Raw token hex found in logs!');
    }
  });

  await t.test('9. Rate limiting triggers 429 on abuse', async () => {
    // Dedicated rate-limited harness with max: 3
    const strictLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 3,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ status: 'rate_limited', message: 'Too many requests' }),
    });

    const rateHarness = await createHarness({ publicLimiter: strictLimiter });

    // Request 1, 2, 3 should succeed
    const r1 = await fetch(`${rateHarness.baseUrl}/api/public/vehicles/${rateHarness.pool.validToken}`);
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${rateHarness.baseUrl}/api/public/vehicles/${rateHarness.pool.validToken}`);
    assert.equal(r2.status, 200);
    const r3 = await fetch(`${rateHarness.baseUrl}/api/public/vehicles/${rateHarness.pool.validToken}`);
    assert.equal(r3.status, 200);

    // Request 4 should be rejected with 429
    const r4 = await fetch(`${rateHarness.baseUrl}/api/public/vehicles/${rateHarness.pool.validToken}`);
    assert.equal(r4.status, 429);
    const body = await r4.json();
    assert.equal(body.status, 'rate_limited');
  });
});
