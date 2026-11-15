import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import mysql from 'mysql2/promise';
import { applyMigrations, verifyVisitorSessionsSchema } from '../src/migrate.js';
import { createVehiclesRouter } from '../src/routes/vehicles.js';
import { createPublicRouter } from '../src/routes/public.js';
import { runVisitorSessionCleanup } from '../src/services/sessionCleanup.js';

const enabled = process.env.RUN_MYSQL_INTEGRATION === '1';
const TEST_ONLY_ACK = 'I_ACCEPT_DISPOSABLE_DATABASES';

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

export function resolveIntegrationDbConfig(env = process.env) {
  if (env.NODE_ENV === 'production') {
    throw new Error('MySQL integration tests are disabled when NODE_ENV=production.');
  }
  const required = ['TEST_DB_HOST', 'TEST_DB_USER', 'TEST_DB_PASSWORD'];
  const missing = required.filter((key) => typeof env[key] !== 'string' || env[key].trim() === '');
  if (missing.length) throw new Error(`MySQL integration tests require explicit test-only variables: ${missing.join(', ')}.`);
  if (env.TEST_DB_ALLOW_CREATE_DROP !== TEST_ONLY_ACK) {
    throw new Error('MySQL integration tests require TEST_DB_ALLOW_CREATE_DROP=I_ACCEPT_DISPOSABLE_DATABASES.');
  }

  const host = normalizeHost(env.TEST_DB_HOST);
  if (/railway|rlwy\.net|\.railway\.app$/i.test(host)) {
    throw new Error('MySQL integration tests reject known Railway database hosts.');
  }
  const productionHosts = [env.DB_HOST, env.MIGRATION_DB_HOST].map(normalizeHost).filter(Boolean);
  if (productionHosts.includes(host)) {
    throw new Error('TEST_DB_HOST must differ from configured application and migration database hosts.');
  }
  const productionUsers = [env.DB_USER, env.MIGRATION_DB_USER].filter(Boolean);
  if (productionUsers.includes(env.TEST_DB_USER)) {
    throw new Error('TEST_DB_USER must differ from configured application and migration users.');
  }
  const productionPasswords = [env.DB_PASSWORD, env.MIGRATION_DB_PASSWORD].filter(Boolean);
  if (productionPasswords.includes(env.TEST_DB_PASSWORD)) {
    throw new Error('TEST_DB_PASSWORD must differ from configured application and migration passwords.');
  }
  if (!/^parkx_test_[a-z0-9_]+$/i.test(env.TEST_DB_USER) || env.TEST_DB_USER.toLowerCase() === 'root') {
    throw new Error('TEST_DB_USER must be a dedicated account named with the parkx_test_ prefix.');
  }
  const rawPort = env.TEST_DB_PORT === undefined ? '3306' : String(env.TEST_DB_PORT).trim();
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(Number(rawPort)) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('TEST_DB_PORT must be an integer from 1 to 65535.');
  }
  return { host, port: Number(rawPort), user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD };
}

const config = enabled ? resolveIntegrationDbConfig(process.env) : null;
const origin = 'http://localhost:5173';

function identifier() {
  return `parkx_it_${randomBytes(6).toString('hex')}`;
}

function assertDisposableDatabaseName(dbName, env = process.env) {
  if (typeof dbName !== 'string' || !/^parkx_it_[a-f0-9]{12}$/.test(dbName)) {
    throw new Error('Refusing database operation: identifier is outside the generated parkx_it_ namespace.');
  }
  const configuredDatabases = [env.DB_NAME, env.MIGRATION_DB_NAME, env.TEST_DB_NAME].filter(Boolean);
  if (configuredDatabases.includes(dbName)) {
    throw new Error('Refusing database operation: generated identifier matches a configured database name.');
  }
  return dbName;
}

test('MySQL integration configuration cannot inherit application credentials', () => {
  assert.throws(() => resolveIntegrationDbConfig({ NODE_ENV: 'production' }), /disabled when NODE_ENV=production/);
  assert.throws(() => resolveIntegrationDbConfig({ DB_HOST: 'app-db.example', DB_USER: 'app_user', DB_PASSWORD: 'app-secret' }), /explicit test-only variables/);
  const base = {
    TEST_DB_HOST: '127.0.0.1', TEST_DB_USER: 'parkx_test_local', TEST_DB_PASSWORD: 'separate-test-password',
    TEST_DB_ALLOW_CREATE_DROP: TEST_ONLY_ACK,
  };
  assert.throws(() => resolveIntegrationDbConfig({ ...base, TEST_DB_HOST: 'containers-us-west-1.railway.app' }), /reject known Railway/);
  assert.throws(() => resolveIntegrationDbConfig({ ...base, DB_HOST: '127.0.0.1' }), /must differ from configured application/);
  assert.throws(() => resolveIntegrationDbConfig({ ...base, DB_PASSWORD: 'separate-test-password' }), /must differ from configured application/);
  assert.deepEqual(resolveIntegrationDbConfig(base), {
    host: '127.0.0.1', port: 3306, user: 'parkx_test_local', password: 'separate-test-password',
  });
  assert.throws(() => assertDisposableDatabaseName('parkx_production'), /outside the generated/);
  assert.throws(() => assertDisposableDatabaseName('parkx_it_0123456789ab', { TEST_DB_NAME: 'parkx_it_0123456789ab' }), /matches a configured database/);
});

async function withDatabase(t, callback) {
  const admin = await mysql.createConnection(config);
  const dbName = assertDisposableDatabaseName(identifier());
  let pool;
  let created = false;
  try {
    assertDisposableDatabaseName(dbName);
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ ...config, database: dbName, connectionLimit: 12, charset: 'utf8mb4' });
  } catch (error) {
    if (pool) await pool.end().catch(() => {});
    if (created) {
      assertDisposableDatabaseName(dbName);
      await admin.query(`DROP DATABASE \`${dbName}\``).catch(() => {});
    }
    await admin.end().catch(() => {});
    throw error;
  }
  t.after(async () => {
    try {
      await pool.end();
    } finally {
      try {
        assertDisposableDatabaseName(dbName);
        await admin.query(`DROP DATABASE \`${dbName}\``);
      } finally {
        await admin.end();
      }
    }
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

  await t.test('real MySQL concurrency: atomic 5-pending-session limit with SELECT ... FOR UPDATE', async (t) => {
    await withDatabase(t, async (pool) => {
      await migrate(pool);
      const harness = await makeApp(pool);
      t.after(() => harness.server.close());

      // 1. Seed user & vehicle
      const [uRes] = await pool.query("INSERT INTO users (full_name, email, password_hash) VALUES ('Limit User', 'limit-test@parkx.ai', 'hash')");
      const userId = uRes.insertId;
      const ownerCookie = await sessionFor(harness.base, userId);

      const vRes = await request(harness.base, ownerCookie, 'POST', '', {
        registration_number: 'LIMIT-5-TEST',
        vehicle_type: 'ev',
        vehicle_model: 'Lucid Air',
        color: 'Zenith Red',
      });
      assert.equal(vRes.status, 201);
      const vData = await vRes.json();
      const qrToken = vData.vehicle.qrCode.token;
      const vehicleId = vData.vehicle.id;

      // 2. Concurrently fire 8 session creation requests against the same vehicle
      const promises = Array.from({ length: 8 }).map(() =>
        fetch(`${harness.base}/api/public/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: qrToken }),
        })
      );

      const responses = await Promise.all(promises);
      const created = [];
      const rateLimited = [];
      for (const res of responses) {
        const body = await res.json();
        if (res.status === 201) created.push(body);
        else if (res.status === 429) rateLimited.push(body);
      }

      // 3. Locking correctness verification:
      // Exactly 5 sessions created; exactly 3 rejected with 429 rate_limited
      assert.equal(created.length, 5, 'Exactly 5 sessions must be created in real MySQL');
      assert.equal(rateLimited.length, 3, 'Remaining 3 requests must be serialized and rejected with 429');
      for (const r of rateLimited) {
        assert.equal(r.status, 'rate_limited');
      }

      // 4. Verify database state directly
      const [dbRows] = await pool.query(
        'SELECT COUNT(*) AS n FROM visitor_sessions WHERE vehicle_id = ? AND status = ?',
        [vehicleId, 'pending']
      );
      assert.equal(Number(dbRows[0].n), 5);
    });
  });

  await t.test('real MySQL race-safe state transitions: accept, close, and expiry boundaries', async (t) => {
    await withDatabase(t, async (pool) => {
      await migrate(pool);
      const harness = await makeApp(pool);
      t.after(() => harness.server.close());

      const [uRes] = await pool.query("INSERT INTO users (full_name, email, password_hash) VALUES ('Transitions User', 'transitions-test@parkx.ai', 'hash')");
      const userId = uRes.insertId;
      const ownerCookie = await sessionFor(harness.base, userId);

      const vRes = await request(harness.base, ownerCookie, 'POST', '', {
        registration_number: 'TRANS-TEST-1',
        vehicle_type: 'car',
        vehicle_model: 'Audi e-tron GT',
        color: 'Tactical Green',
      });
      const vData = await vRes.json();
      const qrToken = vData.vehicle.qrCode.token;

      // Create session
      const createRes = await fetch(`${harness.base}/api/public/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: qrToken }),
      });
      assert.equal(createRes.status, 201);
      const sessionData = await createRes.json();
      const sid = sessionData.sessionId;
      const cred = sessionData.visitorCredential;

      // 1. Owner accepts pending session
      const acceptRes1 = await request(harness.base, ownerCookie, 'POST', `/sessions/${sid}/accept`, {});
      assert.equal(acceptRes1.status, 200);
      const acceptData1 = await acceptRes1.json();
      assert.equal(acceptData1.status, 'accepted');

      // 2. Re-accepting already accepted session is idempotent
      const acceptRes2 = await request(harness.base, ownerCookie, 'POST', `/sessions/${sid}/accept`, {});
      assert.equal(acceptRes2.status, 200);
      const acceptData2 = await acceptRes2.json();
      assert.equal(acceptData2.status, 'accepted');
      assert.match(acceptData2.message, /already accepted/i);

      // 3. Visitor closes accepted session
      const closeRes = await fetch(`${harness.base}/api/public/sessions/${sid}/close`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Visitor-Credential': cred,
        },
      });
      assert.equal(closeRes.status, 200);
      const closeData = await closeRes.json();
      assert.equal(closeData.status, 'closed');

      // 4. Owner cannot accept a closed session
      const acceptClosedRes = await request(harness.base, ownerCookie, 'POST', `/sessions/${sid}/accept`, {});
      assert.equal(acceptClosedRes.status, 400);
      const acceptClosedData = await acceptClosedRes.json();
      assert.equal(acceptClosedData.status, 'closed');

      // 5. Expiry boundary: artificially set session to expired in MySQL
      const expCreateRes = await fetch(`${harness.base}/api/public/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: qrToken }),
      });
      const expSessionRes = await expCreateRes.json();

      const expSid = expSessionRes.sessionId;
      await pool.query('UPDATE visitor_sessions SET expires_at = NOW() - INTERVAL 10 SECOND WHERE public_id = ?', [expSid]);

      // Owner accept on expired session fails with 400
      const acceptExpRes = await request(harness.base, ownerCookie, 'POST', `/sessions/${expSid}/accept`, {});
      assert.equal(acceptExpRes.status, 400);
      const acceptExpData = await acceptExpRes.json();
      assert.equal(acceptExpData.status, 'expired');

      // Owner close on expired session fails with 400
      const closeExpRes = await request(harness.base, ownerCookie, 'POST', `/sessions/${expSid}/close`, {});
      assert.equal(closeExpRes.status, 400);
      const closeExpData = await closeExpRes.json();
      assert.equal(closeExpData.status, 'expired');
    });
  });

  await t.test('real MySQL migration 007 verification: schema integrity, incompatible tables, and rerun behavior', async (t) => {
    await withDatabase(t, async (pool) => {
      await migrate(pool);
      const conn = await pool.getConnection();
      try {
        // Scenario 5: Correct schema accepted
        await verifyVisitorSessionsSchema(conn);

        // Scenario 6: Correct schema rerun idempotent
        await migrate(pool);
        await verifyVisitorSessionsSchema(conn);

        // An unrecorded but incompatible pre-existing table must not be
        // ledgered merely because CREATE TABLE IF NOT EXISTS would succeed.
        await conn.query("DELETE FROM schema_migrations WHERE version = '007_visitor_sessions.sql'");
        await conn.query('ALTER TABLE visitor_sessions MODIFY created_at TIMESTAMP NOT NULL');
        await assert.rejects(
          () => applyMigrations(pool),
          /created_at column definition.*DEFAULT CURRENT_TIMESTAMP/
        );
        const [unrecorded] = await conn.query("SELECT version FROM schema_migrations WHERE version = '007_visitor_sessions.sql'");
        assert.equal(unrecorded.length, 0, 'Migration 007 must not be recorded after schema verification fails');
        await conn.query('ALTER TABLE visitor_sessions MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
        await conn.query("ALTER TABLE visitor_sessions MODIFY created_at TIMESTAMP NOT NULL DEFAULT '2000-01-01 00:00:00'");
        await assert.rejects(
          () => verifyVisitorSessionsSchema(conn),
          /created_at column definition.*DEFAULT CURRENT_TIMESTAMP/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
        await migrate(pool);

        // Verify index idx_visitor_sessions_closed_status exists with correct columns
        const [closedIdx] = await conn.query(
          `SELECT COLUMN_NAME, SEQ_IN_INDEX
           FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'visitor_sessions'
             AND INDEX_NAME = 'idx_visitor_sessions_closed_status'
           ORDER BY SEQ_IN_INDEX`
        );
        assert.equal(closedIdx.length, 2);
        assert.equal(closedIdx[0].COLUMN_NAME, 'closed_at');
        assert.equal(closedIdx[1].COLUMN_NAME, 'status');

        // Scenario 1: Table with id INT UNSIGNED rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY id INT UNSIGNED AUTO_INCREMENT');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid id column definition on visitor_sessions: must be BIGINT UNSIGNED AUTO_INCREMENT/
        );
        // Restore id
        await conn.query('ALTER TABLE visitor_sessions MODIFY id BIGINT UNSIGNED AUTO_INCREMENT');
        await verifyVisitorSessionsSchema(conn);

        // Scenario 2: Table with vehicle_id BIGINT UNSIGNED rejected
        await conn.query('ALTER TABLE visitor_sessions DROP FOREIGN KEY fk_visitor_sessions_vehicle_id');
        await conn.query('ALTER TABLE visitor_sessions MODIFY vehicle_id BIGINT UNSIGNED NOT NULL');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid vehicle_id column definition on visitor_sessions: must be INT UNSIGNED NOT NULL/
        );
        // Restore vehicle_id and foreign key
        await conn.query('ALTER TABLE visitor_sessions MODIFY vehicle_id INT UNSIGNED NOT NULL');
        await conn.query('ALTER TABLE visitor_sessions ADD CONSTRAINT fk_visitor_sessions_vehicle_id FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE');
        await verifyVisitorSessionsSchema(conn);

        // Scenario 3: Table with status ENUM containing extra value rejected
        await conn.query("ALTER TABLE visitor_sessions MODIFY status ENUM('pending','accepted','closed','expired','archived') NOT NULL DEFAULT 'pending'");
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid status column definition on visitor_sessions: must be ENUM\('pending','accepted','closed','expired'\)/
        );
        // Restore status ENUM
        await conn.query("ALTER TABLE visitor_sessions MODIFY status ENUM('pending','accepted','closed','expired') NOT NULL DEFAULT 'pending'");
        await verifyVisitorSessionsSchema(conn);

        // Scenario 4: Table with prefix unique index on public_id(10) rejected
        await conn.query('ALTER TABLE visitor_sessions DROP INDEX uq_visitor_sessions_public_id');
        await conn.query('ALTER TABLE visitor_sessions ADD UNIQUE KEY uq_visitor_sessions_public_id (public_id(10))');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /index uq_visitor_sessions_public_id must be a full-column index; prefix index \(sub_part=10\) is rejected/
        );
        // Restore full-column unique index
        await conn.query('ALTER TABLE visitor_sessions DROP INDEX uq_visitor_sessions_public_id');
        await conn.query('ALTER TABLE visitor_sessions ADD UNIQUE KEY uq_visitor_sessions_public_id (public_id)');
        await verifyVisitorSessionsSchema(conn);

        // A unique credential index is incompatible with the declared ordinary lookup index.
        await conn.query('ALTER TABLE visitor_sessions DROP INDEX idx_visitor_sessions_credential_hash');
        await conn.query('ALTER TABLE visitor_sessions ADD UNIQUE KEY idx_visitor_sessions_credential_hash (credential_hash)');
        await assert.rejects(
          () => verifyVisitorSessionsSchema(conn),
          /index idx_visitor_sessions_credential_hash on visitor_sessions has incorrect uniqueness: expected unique=false/
        );
        await conn.query('ALTER TABLE visitor_sessions DROP INDEX idx_visitor_sessions_credential_hash');
        await conn.query('ALTER TABLE visitor_sessions ADD KEY idx_visitor_sessions_credential_hash (credential_hash)');
        await verifyVisitorSessionsSchema(conn);

        // A cross-schema FK with the same table/column names must not pass.
        const externalSchema = assertDisposableDatabaseName(`parkx_it_${randomBytes(6).toString('hex')}`);
        assertDisposableDatabaseName(externalSchema);
        await conn.query(`CREATE DATABASE \`${externalSchema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        try {
          await conn.query(`CREATE TABLE \`${externalSchema}\`.vehicles (id INT UNSIGNED NOT NULL PRIMARY KEY) ENGINE=InnoDB`);
          await conn.query('ALTER TABLE visitor_sessions DROP FOREIGN KEY fk_visitor_sessions_vehicle_id');
          await conn.query(`ALTER TABLE visitor_sessions ADD CONSTRAINT fk_visitor_sessions_vehicle_id FOREIGN KEY (vehicle_id) REFERENCES \`${externalSchema}\`.vehicles(id) ON DELETE CASCADE`);
          await assert.rejects(
            () => verifyVisitorSessionsSchema(conn),
            /foreign key must be named fk_visitor_sessions_vehicle_id and reference vehicle_id to vehicles\(id\) with ON DELETE CASCADE/
          );
          await conn.query('ALTER TABLE visitor_sessions DROP FOREIGN KEY fk_visitor_sessions_vehicle_id');
          await conn.query('ALTER TABLE visitor_sessions ADD CONSTRAINT fk_visitor_sessions_vehicle_id FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE');
          await verifyVisitorSessionsSchema(conn);
        } finally {
          assertDisposableDatabaseName(externalSchema);
          await conn.query(`DROP DATABASE \`${externalSchema}\``);
        }

        // A composite FK beginning with vehicle_id must not be mistaken for the expected FK.
        // We add a matching column on vehicles (test_status) and reference (vehicle_id, status)
        // because (vehicle_id, status) is a prefix of idx_visitor_sessions_vehicle_status (vehicle_id, status, created_at).
        // This keeps visitor_sessions strictly at 9 columns and 6 indexes, proving that the rejection
        // is triggered directly by the composite foreign key check (validFk.length !== 1).
        await conn.query("ALTER TABLE vehicles ADD COLUMN test_status ENUM('pending','accepted','closed','expired') NOT NULL DEFAULT 'pending'");
        await conn.query('ALTER TABLE vehicles ADD UNIQUE KEY uq_vehicles_id_status (id, test_status)');
        await conn.query('ALTER TABLE visitor_sessions DROP FOREIGN KEY fk_visitor_sessions_vehicle_id');
        await conn.query('ALTER TABLE visitor_sessions ADD CONSTRAINT fk_visitor_sessions_vehicle_id FOREIGN KEY (vehicle_id, status) REFERENCES vehicles(id, test_status) ON DELETE CASCADE');
        await assert.rejects(
          () => verifyVisitorSessionsSchema(conn),
          /foreign key must be named fk_visitor_sessions_vehicle_id and reference vehicle_id to vehicles\(id\) with ON DELETE CASCADE/
        );
        await conn.query('ALTER TABLE visitor_sessions DROP FOREIGN KEY fk_visitor_sessions_vehicle_id');
        await conn.query('ALTER TABLE vehicles DROP INDEX uq_vehicles_id_status');
        await conn.query('ALTER TABLE vehicles DROP COLUMN test_status');
        await conn.query('ALTER TABLE visitor_sessions ADD CONSTRAINT fk_visitor_sessions_vehicle_id FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE');
        await verifyVisitorSessionsSchema(conn);

        // Foreign key integrity check: drop FK and assert rejection
        await conn.query('ALTER TABLE visitor_sessions DROP FOREIGN KEY fk_visitor_sessions_vehicle_id');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /foreign key must be named fk_visitor_sessions_vehicle_id and reference vehicle_id to vehicles\(id\) with ON DELETE CASCADE/
        );
        // Restore foreign key
        await conn.query('ALTER TABLE visitor_sessions ADD CONSTRAINT fk_visitor_sessions_vehicle_id FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE');
        await verifyVisitorSessionsSchema(conn);

        // Invisible index rejection: make required index invisible and verify rejection
        await conn.query('ALTER TABLE visitor_sessions ALTER INDEX idx_visitor_sessions_credential_hash INVISIBLE');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /index idx_visitor_sessions_credential_hash on visitor_sessions is invisible/
        );
        // Restore index visibility and verify schema passes
        await conn.query('ALTER TABLE visitor_sessions ALTER INDEX idx_visitor_sessions_credential_hash VISIBLE');
        await verifyVisitorSessionsSchema(conn);

        // Invisible index rejection on unique index: make public_id unique index invisible and verify rejection
        await conn.query('ALTER TABLE visitor_sessions ALTER INDEX uq_visitor_sessions_public_id INVISIBLE');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /index uq_visitor_sessions_public_id on visitor_sessions is invisible/
        );
        // Restore unique index visibility and verify schema passes
        await conn.query('ALTER TABLE visitor_sessions ALTER INDEX uq_visitor_sessions_public_id VISIBLE');
        await verifyVisitorSessionsSchema(conn);

        // Invisible index rejection on compound index: make idx_visitor_sessions_closed_status invisible
        await conn.query('ALTER TABLE visitor_sessions ALTER INDEX idx_visitor_sessions_closed_status INVISIBLE');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /index idx_visitor_sessions_closed_status on visitor_sessions is invisible/
        );
        // Restore compound index visibility and verify schema passes
        await conn.query('ALTER TABLE visitor_sessions ALTER INDEX idx_visitor_sessions_closed_status VISIBLE');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: unexpected default on expires_at rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid expires_at column definition on visitor_sessions: must be TIMESTAMP NOT NULL without a default or ON UPDATE clause/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY expires_at TIMESTAMP NOT NULL');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: unexpected ON UPDATE on expires_at rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY expires_at TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid expires_at column definition on visitor_sessions: must be TIMESTAMP NOT NULL without a default or ON UPDATE clause/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY expires_at TIMESTAMP NOT NULL');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: unexpected default on accepted_at rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY accepted_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid accepted_at column definition on visitor_sessions: must be TIMESTAMP NULL DEFAULT NULL without an unexpected default or ON UPDATE clause/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY accepted_at TIMESTAMP NULL DEFAULT NULL');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: non-nullable timestamp on accepted_at rejected.
        // Note: In MySQL 8.4, `TIMESTAMP NULL` automatically normalizes to `timestamp NULL DEFAULT NULL`
        // in information_schema and SHOW CREATE TABLE. An omitted DEFAULT NULL cannot be distinguished
        // or represented in MySQL 8.4; this test verifies that declaring accepted_at as NOT NULL is rejected.
        await conn.query('ALTER TABLE visitor_sessions MODIFY accepted_at TIMESTAMP NOT NULL');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid accepted_at column definition on visitor_sessions: must be TIMESTAMP NULL DEFAULT NULL without an unexpected default or ON UPDATE clause/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY accepted_at TIMESTAMP NULL DEFAULT NULL');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: unexpected ON UPDATE on accepted_at rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY accepted_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid accepted_at column definition on visitor_sessions: must be TIMESTAMP NULL DEFAULT NULL without an unexpected default or ON UPDATE clause/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY accepted_at TIMESTAMP NULL DEFAULT NULL');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: unexpected default on closed_at rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY closed_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid closed_at column definition on visitor_sessions: must be TIMESTAMP NULL DEFAULT NULL without an unexpected default or ON UPDATE clause/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY closed_at TIMESTAMP NULL DEFAULT NULL');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: non-nullable timestamp on closed_at rejected.
        // Note: In MySQL 8.4, `TIMESTAMP NULL` automatically normalizes to `timestamp NULL DEFAULT NULL`
        // in information_schema and SHOW CREATE TABLE. An omitted DEFAULT NULL cannot be distinguished
        // or represented in MySQL 8.4; this test verifies that declaring closed_at as NOT NULL is rejected.
        await conn.query('ALTER TABLE visitor_sessions MODIFY closed_at TIMESTAMP NOT NULL');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid closed_at column definition on visitor_sessions: must be TIMESTAMP NULL DEFAULT NULL without an unexpected default or ON UPDATE clause/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY closed_at TIMESTAMP NULL DEFAULT NULL');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: unexpected ON UPDATE on closed_at rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY closed_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid closed_at column definition on visitor_sessions: must be TIMESTAMP NULL DEFAULT NULL without an unexpected default or ON UPDATE clause/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY closed_at TIMESTAMP NULL DEFAULT NULL');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: unexpected ON UPDATE on created_at rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid created_at column definition on visitor_sessions: must be TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP without ON UPDATE/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
        await verifyVisitorSessionsSchema(conn);

        // Renamed expected index rejected
        await conn.query('ALTER TABLE visitor_sessions RENAME INDEX idx_visitor_sessions_credential_hash TO idx_visitor_sessions_cred_renamed');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /unexpected extra index idx_visitor_sessions_cred_renamed found on visitor_sessions|missing required index idx_visitor_sessions_credential_hash/
        );
        await conn.query('ALTER TABLE visitor_sessions RENAME INDEX idx_visitor_sessions_cred_renamed TO idx_visitor_sessions_credential_hash');
        await verifyVisitorSessionsSchema(conn);

        // Unexpected extra index rejected
        await conn.query('ALTER TABLE visitor_sessions ADD KEY idx_extra_test (created_at)');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /unexpected extra index idx_extra_test found on visitor_sessions/
        );
        await conn.query('ALTER TABLE visitor_sessions DROP INDEX idx_extra_test');
        await verifyVisitorSessionsSchema(conn);

        // Wrong index column order rejected
        await conn.query('ALTER TABLE visitor_sessions DROP INDEX idx_visitor_sessions_expires_status');
        await conn.query('ALTER TABLE visitor_sessions ADD KEY idx_visitor_sessions_expires_status (status, expires_at)');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /index idx_visitor_sessions_expires_status column at position 1 must be expires_at, found status/
        );
        await conn.query('ALTER TABLE visitor_sessions DROP INDEX idx_visitor_sessions_expires_status');
        await conn.query('ALTER TABLE visitor_sessions ADD KEY idx_visitor_sessions_expires_status (expires_at, status)');
        await verifyVisitorSessionsSchema(conn);

        // Wrong table collation rejected
        await conn.query('ALTER TABLE visitor_sessions COLLATE utf8mb4_general_ci');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /visitor_sessions table collation must be utf8mb4_unicode_ci/
        );
        await conn.query('ALTER TABLE visitor_sessions COLLATE utf8mb4_unicode_ci');
        await verifyVisitorSessionsSchema(conn);

        // Wrong ENUM collation rejected
        await conn.query("ALTER TABLE visitor_sessions MODIFY status ENUM('pending','accepted','closed','expired') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending'");
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /must be ENUM\('pending','accepted','closed','expired'\) NOT NULL DEFAULT 'pending' with utf8mb4_unicode_ci collation/
        );
        await conn.query("ALTER TABLE visitor_sessions MODIFY status ENUM('pending','accepted','closed','expired') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending'");
        await verifyVisitorSessionsSchema(conn);

        // Column contract: explicit DEFAULT NULL on non-timestamp column rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY public_id VARCHAR(64) NULL DEFAULT NULL');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid public_id column definition on visitor_sessions: must be VARCHAR\(64\) NOT NULL\./
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY public_id VARCHAR(64) NOT NULL');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: unexpected non-NULL default on vehicle_id rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY vehicle_id INT UNSIGNED NOT NULL DEFAULT 1');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /invalid vehicle_id column definition on visitor_sessions: must be INT UNSIGNED NOT NULL\./
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY vehicle_id INT UNSIGNED NOT NULL');
        await verifyVisitorSessionsSchema(conn);

        // Foreign key name: wrong constraint name rejected
        await conn.query('ALTER TABLE visitor_sessions DROP FOREIGN KEY fk_visitor_sessions_vehicle_id');
        await conn.query('ALTER TABLE visitor_sessions ADD CONSTRAINT fk_visitor_sessions_vehicle_wrong_name FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON DELETE CASCADE');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /foreign key must be named fk_visitor_sessions_vehicle_id/
        );
        await conn.query('ALTER TABLE visitor_sessions DROP FOREIGN KEY fk_visitor_sessions_vehicle_wrong_name');
        await conn.query('ALTER TABLE visitor_sessions ADD CONSTRAINT fk_visitor_sessions_vehicle_id FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON DELETE CASCADE');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: generated column rejected
        await conn.query('ALTER TABLE visitor_sessions DROP COLUMN accepted_at, ADD COLUMN accepted_at INT AS (1 + 1) VIRTUAL AFTER expires_at');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /column accepted_at on visitor_sessions must not be a generated column/
        );
        await conn.query('ALTER TABLE visitor_sessions DROP COLUMN accepted_at, ADD COLUMN accepted_at TIMESTAMP NULL DEFAULT NULL AFTER expires_at');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: invisible column rejected
        await conn.query('ALTER TABLE visitor_sessions MODIFY credential_hash VARCHAR(64) NOT NULL INVISIBLE');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /column credential_hash on visitor_sessions must not be an invisible column/
        );
        await conn.query('ALTER TABLE visitor_sessions MODIFY credential_hash VARCHAR(64) NOT NULL VISIBLE');
        await verifyVisitorSessionsSchema(conn);

        // Index direction: descending index column rejected
        await conn.query('ALTER TABLE visitor_sessions DROP INDEX idx_visitor_sessions_expires_status');
        await conn.query('ALTER TABLE visitor_sessions ADD KEY idx_visitor_sessions_expires_status (expires_at DESC, status ASC)');
        await assert.rejects(
          async () => verifyVisitorSessionsSchema(conn),
          /index idx_visitor_sessions_expires_status column expires_at must have ascending direction \('A'\), found 'D'/
        );
        await conn.query('ALTER TABLE visitor_sessions DROP INDEX idx_visitor_sessions_expires_status');
        await conn.query('ALTER TABLE visitor_sessions ADD KEY idx_visitor_sessions_expires_status (expires_at, status)');
        await verifyVisitorSessionsSchema(conn);

        // Column contract: verification rejection before migration-ledger insertion
        await conn.query("DELETE FROM schema_migrations WHERE version = '007_visitor_sessions.sql'");
        await conn.query('ALTER TABLE visitor_sessions MODIFY expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
        await assert.rejects(
          async () => applyMigrations(pool),
          /invalid expires_at column definition on visitor_sessions/
        );
        const [ledgerCheck] = await conn.query("SELECT version FROM schema_migrations WHERE version = '007_visitor_sessions.sql'");
        assert.equal(ledgerCheck.length, 0, 'Migration 007 must not be recorded when column contract verification fails');
        // Restore expires_at and re-run migration to verify it records successfully
        await conn.query('ALTER TABLE visitor_sessions MODIFY expires_at TIMESTAMP NOT NULL');
        await applyMigrations(pool);
        const [restoredLedger] = await conn.query("SELECT version FROM schema_migrations WHERE version = '007_visitor_sessions.sql'");
        assert.equal(restoredLedger.length, 1, 'Migration 007 must be recorded when column contract is valid');
      } finally {
        conn.release();
      }
    });
  });

  await t.test('real MySQL genuinely concurrent state transitions with Promise.all', async (t) => {
    await withDatabase(t, async (pool) => {
      await migrate(pool);
      const harness = await makeApp(pool);
      t.after(() => harness.server.close());

      const [uRes] = await pool.query("INSERT INTO users (full_name, email, password_hash) VALUES ('Concurrent State User', 'concurrent-state@parkx.ai', 'hash')");
      const userId = uRes.insertId;
      const ownerCookie = await sessionFor(harness.base, userId);

      const vRes = await request(harness.base, ownerCookie, 'POST', '', {
        registration_number: 'CONC-STAT-1',
        vehicle_type: 'car',
        vehicle_model: 'Porsche 911',
        color: 'Guards Red',
      });
      const vData = await vRes.json();
      const qrToken = vData.vehicle.qrCode.token;

      // Helper to create a fresh session
      const createSession = async () => {
        const res = await fetch(`${harness.base}/api/public/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: qrToken }),
        });
        assert.equal(res.status, 201);
        return res.json();
      };

      // 1. Owner accept racing with owner close on the same session
      const s1 = await createSession();
      const [resAccept, resClose] = await Promise.all([
        request(harness.base, ownerCookie, 'POST', `/sessions/${s1.sessionId}/accept`, {}),
        request(harness.base, ownerCookie, 'POST', `/sessions/${s1.sessionId}/close`, {}),
      ]);
      const [s1Db] = await pool.query('SELECT status FROM visitor_sessions WHERE public_id = ?', [s1.sessionId]);
      assert.ok(['accepted', 'closed'].includes(s1Db[0].status));
      assert.ok([200, 400].includes(resAccept.status));
      assert.ok([200, 400].includes(resClose.status));

      // 2. Visitor close racing with owner accept on the same session
      const s2 = await createSession();
      const [resVisitorClose, resOwnerAccept] = await Promise.all([
        fetch(`${harness.base}/api/public/sessions/${s2.sessionId}/close`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Visitor-Credential': s2.visitorCredential,
          },
        }),
        request(harness.base, ownerCookie, 'POST', `/sessions/${s2.sessionId}/accept`, {}),
      ]);
      const [s2Db] = await pool.query('SELECT status FROM visitor_sessions WHERE public_id = ?', [s2.sessionId]);
      assert.ok(['accepted', 'closed'].includes(s2Db[0].status));
      assert.ok([200, 400].includes(resVisitorClose.status));
      assert.ok([200, 400].includes(resOwnerAccept.status));

      // 3. Expiration racing with close
      const s3 = await createSession();
      // Set expires_at to 1 second ago so cleanup sees it as expired
      await pool.query('UPDATE visitor_sessions SET expires_at = NOW() - INTERVAL 1 SECOND WHERE public_id = ?', [s3.sessionId]);
      const [cleanupRes, closeRes] = await Promise.all([
        runVisitorSessionCleanup(pool),
        fetch(`${harness.base}/api/public/sessions/${s3.sessionId}/close`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Visitor-Credential': s3.visitorCredential,
          },
        }),
      ]);
      const [s3Db] = await pool.query('SELECT status FROM visitor_sessions WHERE public_id = ?', [s3.sessionId]);
      assert.ok(['expired', 'closed'].includes(s3Db[0].status));
      if (s3Db[0].status === 'expired') {
        assert.equal(closeRes.status, 410);
      } else {
        assert.equal(closeRes.status, 200);
      }
    });
  });

  await t.test('real MySQL concurrent session creation and QR rotation with standardized lock ordering', async (t) => {
    await withDatabase(t, async (pool) => {
      await migrate(pool);
      const harness = await makeApp(pool);
      t.after(() => harness.server.close());

      const [uRes] = await pool.query("INSERT INTO users (full_name, email, password_hash) VALUES ('Lock Order User', 'lock-order@parkx.ai', 'hash')");
      const userId = uRes.insertId;
      const ownerCookie = await sessionFor(harness.base, userId);

      const vRes = await request(harness.base, ownerCookie, 'POST', '', {
        registration_number: 'LOCK-ORD-1',
        vehicle_type: 'suv',
        vehicle_model: 'Volvo EX90',
        color: 'Denim Blue',
      });
      const vData = await vRes.json();
      const vehicleId = vData.vehicle.id;
      const initialToken = vData.vehicle.qrCode.token;

      // Concurrently run 6 session creations using the initial token AND 2 QR rotations
      const sessionCreations = Array.from({ length: 6 }).map(() =>
        fetch(`${harness.base}/api/public/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: initialToken }),
        })
      );
      const qrRotations = Array.from({ length: 2 }).map(() =>
        request(harness.base, ownerCookie, 'POST', `/${vehicleId}/qr/rotate`, {})
      );

      const results = await Promise.all([...sessionCreations, ...qrRotations]);
      // Verify all requests finished with valid HTTP statuses without hanging or unhandled deadlocks
      for (const res of results) {
        assert.ok([200, 201, 410, 429].includes(res.status), `Unexpected status: ${res.status}`);
      }

      // Verify DB consistency: exactly 1 active QR code exists for the vehicle
      const [activeQrs] = await pool.query(
        "SELECT COUNT(*) AS n FROM qr_codes WHERE vehicle_id = ? AND status = 'active'",
        [vehicleId]
      );
      assert.equal(Number(activeQrs[0].n), 1);

      // Verify DB consistency: pending sessions count cannot exceed 5
      const [pendingSessions] = await pool.query(
        "SELECT COUNT(*) AS n FROM visitor_sessions WHERE vehicle_id = ? AND status = 'pending'",
        [vehicleId]
      );
      assert.ok(Number(pendingSessions[0].n) <= 5);

      // Verify connection pool is healthy and responsive
      const [ping] = await pool.query('SELECT 1 AS alive');
      assert.equal(ping[0].alive, 1);
    });
  });

  await t.test('real MySQL session retention cleanup: transitions expired and purges past 30 days', async (t) => {
    await withDatabase(t, async (pool) => {
      await migrate(pool);
      const [uRes] = await pool.query("INSERT INTO users (full_name, email, password_hash) VALUES ('Retention User', 'retention-test@parkx.ai', 'hash')");
      const userId = uRes.insertId;
      const [vRes] = await pool.query(
        "INSERT INTO vehicles (user_id, registration_number, vehicle_type, vehicle_model, color) VALUES (?, 'RET-1', 'car', 'M', 'C')",
        [userId]
      );
      const vId = vRes.insertId;

      const credHash = createHash('sha256').update('vcred_sample').digest('hex');

      // 1. Pending session within TTL (expires in 12h)
      await pool.query(
        `INSERT INTO visitor_sessions (public_id, vehicle_id, credential_hash, status, created_at, expires_at)
         VALUES ('vs_clean_active', ?, ?, 'pending', NOW(), NOW() + INTERVAL 12 HOUR)`,
        [vId, credHash]
      );

      // 2. Pending session past TTL (expired 2h ago)
      await pool.query(
        `INSERT INTO visitor_sessions (public_id, vehicle_id, credential_hash, status, created_at, expires_at)
         VALUES ('vs_clean_past_ttl', ?, ?, 'pending', NOW() - INTERVAL 26 HOUR, NOW() - INTERVAL 2 HOUR)`,
        [vId, credHash]
      );

      // 3. Closed session retained (closed 10 days ago, < 30 days)
      await pool.query(
        `INSERT INTO visitor_sessions (public_id, vehicle_id, credential_hash, status, created_at, expires_at, closed_at)
         VALUES ('vs_clean_closed_recent', ?, ?, 'closed', NOW() - INTERVAL 12 DAY, NOW() - INTERVAL 11 DAY, NOW() - INTERVAL 10 DAY)`,
        [vId, credHash]
      );

      // 4. Closed session past retention (closed 35 days ago, > 30 days)
      await pool.query(
        `INSERT INTO visitor_sessions (public_id, vehicle_id, credential_hash, status, created_at, expires_at, closed_at)
         VALUES ('vs_clean_closed_old', ?, ?, 'closed', NOW() - INTERVAL 37 DAY, NOW() - INTERVAL 36 DAY, NOW() - INTERVAL 35 DAY)`,
        [vId, credHash]
      );

      // Execute cleanup
      const result = await runVisitorSessionCleanup(pool, { retentionDays: 30 });
      assert.equal(result.expiredCount, 1);
      assert.equal(result.deletedCount, 1);

      // Verify active pending session is still pending
      const [activeRows] = await pool.query("SELECT status FROM visitor_sessions WHERE public_id = 'vs_clean_active'");
      assert.equal(activeRows[0].status, 'pending');

      // Verify past TTL session was marked expired
      const [expiredRows] = await pool.query("SELECT status FROM visitor_sessions WHERE public_id = 'vs_clean_past_ttl'");
      assert.equal(expiredRows[0].status, 'expired');

      // Verify recent closed session was preserved
      const [recentRows] = await pool.query("SELECT status FROM visitor_sessions WHERE public_id = 'vs_clean_closed_recent'");
      assert.equal(recentRows.length, 1);

      // Verify old closed session was purged
      const [oldRows] = await pool.query("SELECT status FROM visitor_sessions WHERE public_id = 'vs_clean_closed_old'");
      assert.equal(oldRows.length, 0);
    });
  });
});
