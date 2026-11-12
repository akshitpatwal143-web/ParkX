import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import mysql from 'mysql2/promise';
import { applyMigrations } from '../src/migrate.js';
import { createVehiclesRouter } from '../src/routes/vehicles.js';
import { createPublicRouter } from '../src/routes/public.js';

const enabled = process.env.RUN_MYSQL_INTEGRATION === '1';
const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.MIGRATION_DB_USER || process.env.DB_USER || 'root',
  password: process.env.MIGRATION_DB_PASSWORD || process.env.DB_PASSWORD || '',
};
const origin = 'http://localhost:5173';

function identifier() {
  return `parkx_it_${randomBytes(6).toString('hex')}`;
}

async function withDatabase(t, callback) {
  const admin = await mysql.createConnection(config);
  const dbName = identifier();
  assert.match(dbName, /^parkx_it_[a-f0-9]+$/);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = mysql.createPool({ ...config, database: dbName, connectionLimit: 12, charset: 'utf8mb4' });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE \`${dbName}\``);
    await admin.end();
  });
  return callback(pool, dbName);
}

async function makeApp(pool, logger = { error() {} }) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'mysql-integration-test-session-secret-32bytes', resave: false, saveUninitialized: false }));
  app.post('/test/session/:userId', (req, res) => {
    req.session.userId = Number(req.params.userId);
    req.session.csrfToken = 'csrf-integration-token';
    req.session.save(() => res.json({ ok: true }));
  });
  app.use('/api/vehicles', createVehiclesRouter({ pool, origins: [origin], logger }));
  app.use('/api/public', createPublicRouter({ pool, logger }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function sessionFor(base, userId) {
  const response = await fetch(`${base}/test/session/${userId}`, { method: 'POST' });
  return response.headers.get('set-cookie').split(';')[0];
}

function request(base, cookie, method, path, body, csrf = true) {
  const headers = { Cookie: cookie, Origin: origin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = 'csrf-integration-token';
  return fetch(`${base}/api/vehicles${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function migrate(pool) {
  const migrationDirectory = new URL('../migrations/', import.meta.url).pathname;
  await applyMigrations(pool, migrationDirectory);
}

async function prepareLegacySchema(pool) {
  const readFile = (await import('node:fs/promises')).readFile;
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of ['001_users.sql', '002_sessions.sql', '003_normalize_unique_email.sql', '004_vehicles_and_qr.sql']) {
    if (file === '004_vehicles_and_qr.sql') await pool.query('ALTER TABLE users MODIFY id INT UNSIGNED NOT NULL AUTO_INCREMENT');
    let sql = await readFile(new URL(file, directory), 'utf8');
    if (file === '004_vehicles_and_qr.sql') sql = sql.replace('user_id BIGINT UNSIGNED', 'user_id INT UNSIGNED');
    for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) await pool.query(statement);
  }
  await pool.query('CREATE TABLE schema_migrations (version VARCHAR(190) NOT NULL PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
  await pool.query("INSERT INTO schema_migrations (version) VALUES ('001_users.sql'),('002_sessions.sql'),('003_normalize_unique_email.sql'),('004_vehicles_and_qr.sql')");
  await pool.query("INSERT INTO users (id,full_name,email,password_hash) VALUES (12,'Migration Owner','owner@example.test','hash')");
  await pool.query("INSERT INTO vehicles (id,user_id,registration_number,vehicle_type,vehicle_model,color) VALUES (23,12,'ab-12 cd','car','Test Car','Black')");
  await pool.query("INSERT INTO qr_codes (id,vehicle_id,token_hash,status) VALUES (34,23,REPEAT('a',64),'active')");
}

test('MySQL migration and vehicle integrity integration', { skip: !enabled }, async (t) => {
  await t.test('fresh migration chain creates compatible keys and the one-active-pass constraint', async (t) => {
    await withDatabase(t, async (pool) => {
      await migrate(pool);
      const [columns] = await pool.query(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME='users' AND COLUMN_NAME='id') OR (TABLE_NAME='vehicles' AND COLUMN_NAME='user_id'))`);
      assert.equal(columns.find((c) => c.TABLE_NAME === 'users').COLUMN_TYPE, 'bigint unsigned');
      assert.equal(columns.find((c) => c.TABLE_NAME === 'vehicles').COLUMN_TYPE, 'bigint unsigned');
      const [indexes] = await pool.query(`SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='qr_codes' AND INDEX_NAME='uq_qr_codes_one_active_per_vehicle'`);
      assert.ok(indexes.length);
      await migrate(pool);
    });
  });

  await t.test('legacy 004 schema upgrade preserves existing user and vehicle rows', async (t) => {
    await withDatabase(t, async (pool) => {
      await prepareLegacySchema(pool);
      await migrate(pool);
      const [[user]] = await pool.query('SELECT id,email FROM users WHERE id=12');
      const [[vehicle]] = await pool.query('SELECT id,user_id,registration_number FROM vehicles WHERE id=23');
      const [[qr]] = await pool.query('SELECT id,status FROM qr_codes WHERE id=34');
      assert.deepEqual(user, { id: 12, email: 'owner@example.test' });
      assert.deepEqual(vehicle, { id: 23, user_id: 12, registration_number: 'AB12CD' });
      assert.deepEqual(qr, { id: 34, status: 'active' });
    });
  });

  await t.test('migration 006 upgrades installations with the previously applied nullable-key CHECK', async (t) => {
    await withDatabase(t, async (pool) => {
      await prepareLegacySchema(pool);
      const readFile = (await import('node:fs/promises')).readFile;
      const old005 = (await readFile(new URL('../migrations/005_vehicle_qr_integrity.sql', import.meta.url), 'utf8')).replace(/^\s*--.*$/gm, '');
      for (const statement of old005.split(';').map((part) => part.trim()).filter(Boolean)) await pool.query(statement);
      await pool.query("INSERT INTO schema_migrations (version) VALUES ('005_vehicle_qr_integrity.sql')");
      // The earlier nullable CHECK accepted UNKNOWN, so represent a row created by that schema.
      await pool.query('UPDATE qr_codes SET active_vehicle_id=NULL WHERE id=34');

      let injected = false;
      const interruptedPool = {
        async getConnection() {
          const connection = await pool.getConnection();
          return {
            query: async (sql, params) => {
              if (!injected && String(sql).includes('ADD CONSTRAINT chk_qr_codes_active_vehicle_id')) {
                injected = true;
                const error = new Error('simulated interruption after dropping legacy CHECK');
                error.code = 'SIMULATED_INTERRUPT';
                throw error;
              }
              return connection.query(sql, params);
            },
            release: connection.release.bind(connection),
          };
        },
      };
      await assert.rejects(migrate(interruptedPool), /simulated interruption/);
      const [[missingCheck]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='qr_codes' AND CONSTRAINT_NAME='chk_qr_codes_active_vehicle_id'");
      assert.equal(missingCheck.n, 0);
      await migrate(pool);
      const [[migration006]] = await pool.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='006_vehicle_qr_check_integrity.sql'");
      assert.equal(migration006.n, 1);
      const [[repairedQr]] = await pool.query('SELECT active_vehicle_id FROM qr_codes WHERE id=34');
      assert.equal(repairedQr.active_vehicle_id, 23);
      const [[check]] = await pool.query("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_qr_codes_active_vehicle_id'");
      assert.match(check.CHECK_CLAUSE, /active_vehicle_id.*is not null/i);
      await assert.rejects(
        pool.query("INSERT INTO qr_codes (vehicle_id,token_hash,status,active_vehicle_id) VALUES (23,REPEAT('b',64),'active',NULL)"),
        (error) => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED'
      );
      const [[vehicle]] = await pool.query('SELECT id,user_id,registration_number FROM vehicles WHERE id=23');
      assert.deepEqual(vehicle, { id: 23, user_id: 12, registration_number: 'AB12CD' });
    });
  });

  await t.test('partially applied migration 005 resumes and records the ledger only after verification', async (t) => {
    await withDatabase(t, async (pool) => {
      await prepareLegacySchema(pool);
      let injected = false;
      const interruptedPool = {
        async getConnection() {
          const connection = await pool.getConnection();
          return {
            query: async (sql, params) => {
              if (!injected && String(sql).includes('ADD UNIQUE KEY uq_qr_codes_one_active_per_vehicle')) {
                injected = true;
                const error = new Error('simulated process interruption after earlier DDL operations');
                error.code = 'SIMULATED_INTERRUPT';
                throw error;
              }
              return connection.query(sql, params);
            },
            release: connection.release.bind(connection),
          };
        },
      };
      await assert.rejects(migrate(interruptedPool), /simulated process interruption/);
      assert.equal(injected, true);
      const [[ledgerBeforeRetry]] = await pool.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='005_vehicle_qr_integrity.sql'");
      assert.equal(ledgerBeforeRetry.n, 0);
      const [[columnAfterInterruption]] = await pool.query("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='qr_codes' AND COLUMN_NAME='active_vehicle_id'");
      assert.equal(columnAfterInterruption.COLUMN_TYPE, 'int unsigned');

      await migrate(pool);
      const [[ledgerAfterRetry]] = await pool.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='005_vehicle_qr_integrity.sql'");
      assert.equal(ledgerAfterRetry.n, 1);
      const [[user]] = await pool.query('SELECT id FROM users WHERE id=12');
      const [[vehicle]] = await pool.query('SELECT id,user_id,registration_number FROM vehicles WHERE id=23');
      const [[qr]] = await pool.query('SELECT id,status,active_vehicle_id FROM qr_codes WHERE id=34');
      assert.deepEqual(user, { id: 12 });
      assert.deepEqual(vehicle, { id: 23, user_id: 12, registration_number: 'AB12CD' });
      assert.deepEqual(qr, { id: 34, status: 'active', active_vehicle_id: 23 });
    });
  });

  await t.test('real MySQL API constraints, rollback, ownership, rotation concurrency and sanitized logs', async (t) => {
    await withDatabase(t, async (pool) => {
      await migrate(pool);
      await pool.query("INSERT INTO users (id,full_name,email,password_hash) VALUES (7,'Owner One','one@example.test','hash'),(8,'Owner Two','two@example.test','hash')");
      const logCalls = [];
      const harness = await makeApp(pool, { error: (...args) => logCalls.push(args) });
      t.after(() => new Promise((resolve) => harness.server.close(resolve)));
      const ownerCookie = await sessionFor(harness.base, 7);
      const otherCookie = await sessionFor(harness.base, 8);
      const valid = { registration_number: 'ab-12 cd', vehicle_type: 'car', vehicle_model: 'Test Model', color: 'Black' };

      const createdResponse = await request(harness.base, ownerCookie, 'POST', '', valid);
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      assert.equal(created.vehicle.registrationNumber, 'AB12CD');
      const vehicleId = created.vehicle.id;
      const rawToken = created.vehicle.qrCode.token;
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const [[storedQr]] = await pool.query('SELECT token_hash,status FROM qr_codes WHERE vehicle_id=?', [vehicleId]);
      assert.equal(storedQr.token_hash, tokenHash);
      await assert.rejects(
        pool.query('INSERT INTO qr_codes (vehicle_id,token_hash,status,active_vehicle_id) VALUES (?, ?, \'active\', NULL)', [vehicleId, 'b'.repeat(64)]),
        (error) => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED'
      );

      const duplicateResponse = await request(harness.base, ownerCookie, 'POST', '', { ...valid, registration_number: 'AB 12-CD' });
      assert.equal(duplicateResponse.status, 409);
      const tooLong = await request(harness.base, ownerCookie, 'POST', '', { ...valid, registration_number: 'A'.repeat(51) });
      assert.equal(tooLong.status, 400);
      assert.equal((await request(harness.base, ownerCookie, 'GET', `/${vehicleId}`)).status, 200);
      for (const [method, path, body] of [['GET', `/${vehicleId}`, undefined], ['PATCH', `/${vehicleId}`, { color: 'Blue' }], ['DELETE', `/${vehicleId}`, undefined], ['POST', `/${vehicleId}/qr/rotate`, {}]]) {
        assert.equal((await request(harness.base, otherCookie, method, path, body)).status, 404);
      }

      let releasePostPrefetch;
      const postPrefetchBarrier = new Promise((resolve) => { releasePostPrefetch = resolve; });
      let postPrefetchCount = 0;
      const originalPoolQuery = pool.query.bind(pool);
      pool.query = async (sql, params) => {
        const result = await originalPoolQuery(sql, params);
        if (String(sql).includes('SELECT id FROM vehicles WHERE registration_number = ? LIMIT 1') && params[0] === 'PX7721') {
          postPrefetchCount += 1;
          if (postPrefetchCount === 2) releasePostPrefetch();
          await postPrefetchBarrier;
        }
        return result;
      };
      let concurrentPosts;
      try {
        concurrentPosts = await Promise.all([
          request(harness.base, ownerCookie, 'POST', '', { ...valid, registration_number: 'px 7721' }),
          request(harness.base, ownerCookie, 'POST', '', { ...valid, registration_number: 'PX-7721' }),
        ]);
      } finally {
        pool.query = originalPoolQuery;
      }
      assert.equal(postPrefetchCount, 2, 'both registrations must pass the duplicate precheck before either insert');
      assert.deepEqual(concurrentPosts.map((r) => r.status).sort(), [201, 409]);

      const rotations = await Promise.all([
        request(harness.base, ownerCookie, 'POST', `/${vehicleId}/qr/rotate`, {}),
        request(harness.base, ownerCookie, 'POST', `/${vehicleId}/qr/rotate`, {}),
      ]);
      assert.ok(rotations.every((r) => r.status === 200), `rotation statuses: ${rotations.map((r) => r.status)}`);
      const [[revokedOriginal]] = await pool.query('SELECT status FROM qr_codes WHERE token_hash=?', [tokenHash]);
      assert.equal(revokedOriginal.status, 'revoked');
      const [[active]] = await pool.query("SELECT COUNT(*) AS n FROM qr_codes WHERE vehicle_id=? AND status='active'", [vehicleId]);
      const [[revoked]] = await pool.query("SELECT COUNT(*) AS n FROM qr_codes WHERE vehicle_id=? AND status='revoked'", [vehicleId]);
      assert.equal(active.n, 1);
      assert.equal(revoked.n, 2);

      const originalGetConnection = pool.getConnection.bind(pool);
      let deadlocksInjected = 0;
      let rollbackCount = 0;
      pool.getConnection = async () => {
        const connection = await originalGetConnection();
        return {
          query: async (sql, params) => {
            if (String(sql).includes('INSERT INTO qr_codes') && deadlocksInjected < 3) {
              deadlocksInjected += 1;
              const error = new Error('ER_LOCK_DEADLOCK private sql value');
              error.code = 'ER_LOCK_DEADLOCK';
              throw error;
            }
            return connection.query(sql, params);
          },
          beginTransaction: connection.beginTransaction.bind(connection),
          commit: connection.commit.bind(connection),
          rollback: async () => { rollbackCount += 1; return connection.rollback(); },
          release: connection.release.bind(connection),
        };
      };
      const exhausted = await request(harness.base, ownerCookie, 'POST', `/${vehicleId}/qr/rotate`, {});
      pool.getConnection = originalGetConnection;
      assert.equal(exhausted.status, 503);
      assert.equal(exhausted.headers.get('retry-after'), '1');
      assert.deepEqual(await exhausted.json(), { message: 'QR rotation is temporarily unavailable. Please retry.', code: 'QR_ROTATION_RETRYABLE' });
      assert.equal(deadlocksInjected, 3);
      assert.equal(rollbackCount, 3);
      const [[activeAfterDeadlock]] = await pool.query("SELECT COUNT(*) AS n FROM qr_codes WHERE vehicle_id=? AND status='active'", [vehicleId]);
      assert.equal(activeAfterDeadlock.n, 1);

      // Two concurrent changes to the same canonical registration: exactly one wins.
      const second = await request(harness.base, ownerCookie, 'POST', '', { ...valid, registration_number: 'XY-99' });
      assert.equal(second.status, 201);
      const secondId = (await second.json()).vehicle.id;
      let releasePatchPrefetch;
      const patchPrefetchBarrier = new Promise((resolve) => { releasePatchPrefetch = resolve; });
      let patchPrefetchCount = 0;
      pool.query = async (sql, params) => {
        const result = await originalPoolQuery(sql, params);
        if (String(sql).includes('SELECT id FROM vehicles WHERE registration_number = ? AND id != ?') && params[0] === 'DUPE44') {
          patchPrefetchCount += 1;
          if (patchPrefetchCount === 2) releasePatchPrefetch();
          await patchPrefetchBarrier;
        }
        return result;
      };
      let patches;
      try {
        patches = await Promise.all([
          request(harness.base, ownerCookie, 'PATCH', `/${vehicleId}`, { registration_number: 'dupe-44' }),
          request(harness.base, ownerCookie, 'PATCH', `/${secondId}`, { registration_number: 'DUPE 44' }),
        ]);
      } finally {
        pool.query = originalPoolQuery;
      }
      assert.equal(patchPrefetchCount, 2, 'both updates must pass the duplicate precheck before either write');
      assert.deepEqual(patches.map((r) => r.status).sort(), [200, 409]);

      // A database-triggered insert failure verifies transactional rollback for creation and rotation.
      await pool.query(`CREATE TRIGGER parkx_fail_qr_insert BEFORE INSERT ON qr_codes FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='sensitive trigger detail'`);
      const beforeCreate = await pool.query('SELECT COUNT(*) AS n FROM vehicles');
      const failedCreate = await request(harness.base, ownerCookie, 'POST', '', { ...valid, registration_number: 'ROLL-77' });
      assert.equal(failedCreate.status, 500);
      const afterCreate = await pool.query('SELECT COUNT(*) AS n FROM vehicles');
      assert.equal(afterCreate[0][0].n, beforeCreate[0][0].n);
      const beforeActive = (await pool.query("SELECT COUNT(*) AS n FROM qr_codes WHERE vehicle_id=? AND status='active'", [vehicleId]))[0][0].n;
      const failedRotate = await request(harness.base, ownerCookie, 'POST', `/${vehicleId}/qr/rotate`, {});
      assert.equal(failedRotate.status, 500);
      const afterActive = (await pool.query("SELECT COUNT(*) AS n FROM qr_codes WHERE vehicle_id=? AND status='active'", [vehicleId]))[0][0].n;
      assert.equal(afterActive, beforeActive);
      assert.ok(logCalls.length >= 2);
      assert.equal(JSON.stringify(logCalls).includes('sensitive trigger detail'), false);
      assert.equal(JSON.stringify(logCalls).includes(rawToken), false);
      assert.equal((await request(harness.base, ownerCookie, 'POST', '', valid, false)).status, 403);
    });
  });

  await t.test('real MySQL public verification: active, revoked, rotation invalidation, no active pass, unknown, and DB failure', async (t) => {
    await withDatabase(t, async (pool) => {
      await migrate(pool);
      await pool.query("INSERT INTO users (id,full_name,email,password_hash) VALUES (101,'Owner Public','owner_public@example.test','hash')");

      const logCalls = [];
      const testLogger = {
        error: (...args) => logCalls.push(args),
        warn: (...args) => logCalls.push(args),
        info: (...args) => logCalls.push(args),
      };

      const harness = await makeApp(pool, testLogger);
      t.after(() => new Promise((resolve) => harness.server.close(resolve)));

      const ownerCookie = await sessionFor(harness.base, 101);

      // Register vehicle 1 with an active QR token via authenticated API
      const vehiclePayload = {
        registration_number: 'PUB-4040',
        vehicle_type: 'ev',
        vehicle_model: 'Porsche Taycan 4S',
        color: 'Frozen Blue',
      };
      const createdRes = await request(harness.base, ownerCookie, 'POST', '', vehiclePayload);
      assert.equal(createdRes.status, 201);
      const createdData = await createdRes.json();
      const vehicleId = createdData.vehicle.id;
      const token1 = createdData.vehicle.qrCode.token;
      assert.ok(token1, 'Token 1 must be issued on registration');

      // 1. Active QR returns 200 and minimal vehicle information
      const publicRes1 = await fetch(`${harness.base}/api/public/vehicles/${token1}`);
      assert.equal(publicRes1.status, 200);
      assert.equal(publicRes1.headers.get('referrer-policy'), 'no-referrer');
      assert.ok(publicRes1.headers.get('cache-control')?.includes('no-store'));

      const publicData1 = await publicRes1.json();
      assert.equal(publicData1.status, 'valid');
      assert.deepEqual(publicData1.vehicle, {
        vehicleType: 'ev',
        vehicleModel: 'Porsche Taycan 4S',
        color: 'Frozen Blue',
      });
      // Ensure no private/sensitive fields leaked
      assert.equal(publicData1.vehicle.id, undefined);
      assert.equal(publicData1.vehicle.user_id, undefined);
      assert.equal(publicData1.vehicle.userId, undefined);
      assert.equal(publicData1.vehicle.registrationNumber, undefined);
      assert.equal(publicData1.vehicle.registration_number, undefined);
      assert.equal(publicData1.tokenHash, undefined);

      // 3. Rotating a QR immediately invalidates the previous token
      const rotateRes = await request(harness.base, ownerCookie, 'POST', `/${vehicleId}/qr/rotate`, {});
      assert.equal(rotateRes.status, 200);
      const rotateData = await rotateRes.json();
      const token2 = rotateData.qrCode.token;
      assert.ok(token2, 'Token 2 must be issued on rotation');
      assert.notEqual(token1, token2);

      // 2. Revoked QR (token1) returns 410 without vehicle details
      const revokedRes = await fetch(`${harness.base}/api/public/vehicles/${token1}`);
      assert.equal(revokedRes.status, 410);
      const revokedData = await revokedRes.json();
      assert.equal(revokedData.status, 'revoked');
      assert.equal(revokedData.vehicle, undefined);

      // 4. The newly issued token (token2) returns 200 and minimal vehicle info
      const publicRes2 = await fetch(`${harness.base}/api/public/vehicles/${token2}`);
      assert.equal(publicRes2.status, 200);
      const publicData2 = await publicRes2.json();
      assert.equal(publicData2.status, 'valid');
      assert.equal(publicData2.vehicle.vehicleModel, 'Porsche Taycan 4S');

      // 5. A vehicle with no active QR cannot be verified
      const vehiclePayload2 = {
        registration_number: 'NO-QR-99',
        vehicle_type: 'car',
        vehicle_model: 'Ghost Vehicle',
        color: 'Silver',
      };
      const v2Res = await request(harness.base, ownerCookie, 'POST', '', vehiclePayload2);
      assert.equal(v2Res.status, 201);
      const v2Data = await v2Res.json();
      const v2Id = v2Data.vehicle.id;
      const tokenV2 = v2Data.vehicle.qrCode.token;

      // Revoke vehicle 2's only QR code
      await pool.query(
        "UPDATE qr_codes SET status='revoked', revoked_at=CURRENT_TIMESTAMP, active_vehicle_id=NULL WHERE vehicle_id=?",
        [v2Id]
      );
      // Attempting to verify tokenV2 returns 410
      const noActiveRes = await fetch(`${harness.base}/api/public/vehicles/${tokenV2}`);
      assert.equal(noActiveRes.status, 410);
      const noActiveData = await noActiveRes.json();
      assert.equal(noActiveData.status, 'revoked');
      assert.equal(noActiveData.vehicle, undefined);

      // 6. Unknown tokens return 404
      const unknownToken = 'pkx_' + '0'.repeat(64);
      const unknownRes = await fetch(`${harness.base}/api/public/vehicles/${unknownToken}`);
      assert.equal(unknownRes.status, 404);
      const unknownData = await unknownRes.json();
      assert.equal(unknownData.status, 'invalid');
      assert.equal(unknownData.vehicle, undefined);

      // 7. Database failure returns a generic response and does not log the token or hash
      const originalQuery = pool.query.bind(pool);
      pool.query = async (sql, params) => {
        if (String(sql).includes('FROM qr_codes q') && String(sql).includes('WHERE q.token_hash = ?')) {
          const err = new Error('simulated DB connection crash');
          err.code = 'SIMULATED_DB_ERROR';
          throw err;
        }
        return originalQuery(sql, params);
      };

      try {
        const failRes = await fetch(`${harness.base}/api/public/vehicles/${token2}`);
        assert.equal(failRes.status, 500);
        const failData = await failRes.json();
        assert.equal(failData.status, 'error');
        assert.equal(failData.message, 'Verification service temporarily unavailable.');
        assert.equal(failData.sql, undefined);
        assert.equal(failData.code, undefined);

        assert.ok(logCalls.length > 0, 'Logger must record the error');
        const token2Hash = createHash('sha256').update(token2).digest('hex');
        const logsSerialized = JSON.stringify(logCalls);
        assert.equal(logsSerialized.includes(token2), false, 'Raw token must NEVER appear in logs');
        assert.equal(logsSerialized.includes(token2Hash), false, 'Token hash must NEVER appear in logs');
      } finally {
        pool.query = originalQuery;
      }
    });
  });
});
