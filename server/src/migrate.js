import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function assertNoNormalizedEmailDuplicates(connection) {
  const [duplicates] = await connection.query(
    'SELECT LOWER(TRIM(email)) AS normalized_email, COUNT(*) AS row_count FROM users GROUP BY LOWER(TRIM(email)) HAVING COUNT(*) > 1 LIMIT 10'
  );
  if (duplicates.length) {
    throw new Error(`Cannot normalize emails: ${duplicates.length} duplicate groups would collide. Resolve the affected accounts, then rerun migrations.`);
  }
}

async function ensureUniqueEmailIndex(connection) {
  const [indexes] = await connection.query('SHOW INDEX FROM users');
  const groups = new Map();
  for (const row of indexes) {
    if (Number(row.Non_unique) !== 0) continue;
    if (!groups.has(row.Key_name)) groups.set(row.Key_name, []);
    groups.get(row.Key_name).push(row.Column_name);
  }
  const hasUniqueEmail = [...groups.values()].some((columns) => columns.length === 1 && columns[0] === 'email');
  if (!hasUniqueEmail) await connection.query('ALTER TABLE users ADD UNIQUE KEY users_email_unique (email)');
}

export async function applyMigrations(pool, migrationDirectory = directory) {
  const connection = await pool.getConnection();
  try {
    const [lockRows] = await connection.query("SELECT GET_LOCK('parkx_schema_migrations', 30) AS acquired");
    if (lockRows[0]?.acquired !== 1) throw new Error('Could not acquire schema migration lock');
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(190) NOT NULL PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const files = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort();
    const [appliedRows] = await connection.query('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.map((row) => row.version));

    for (const file of files) {
      if (applied.has(file)) {
        if (file === '005_vehicle_qr_integrity.sql') {
          await verifyVehicleQrIntegritySchema(connection, { allowLegacyActiveRows: !applied.has('006_vehicle_qr_check_integrity.sql') });
        }
        if (file === '006_vehicle_qr_check_integrity.sql') await verifyStrictQrActiveConstraint(connection);
        continue;
      }
      if (file.startsWith('003_')) await assertNoNormalizedEmailDuplicates(connection);
      if (file === '005_vehicle_qr_integrity.sql') {
        await applyVehicleQrIntegrityMigration(connection);
      } else if (file === '006_vehicle_qr_check_integrity.sql') {
        await applyQrActiveCheckConstraintMigration(connection);
      } else {
        const sql = (await readFile(path.join(migrationDirectory, file), 'utf8')).replace(/^\s*--.*$/gm, '');
        for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
          await connection.query(statement);
        }
      }
      if (file.startsWith('003_')) await ensureUniqueEmailIndex(connection);
      await connection.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      console.log(`Applied migration ${file}`);
    }
  } finally {
    try { await connection.query("SELECT RELEASE_LOCK('parkx_schema_migrations')"); } catch {}
    connection.release();
  }
}

function migrationError(message) {
  return new Error(`Migration 005 schema inconsistency: ${message}`);
}

async function tableExists(connection, table) {
  const [rows] = await connection.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return rows.length > 0;
}

async function getColumn(connection, table, column) {
  const [rows] = await connection.query(
    'SELECT COLUMN_TYPE, IS_NULLABLE, EXTRA, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  return rows[0] || null;
}

async function getVehicleUserForeignKeys(connection) {
  const [rows] = await connection.query(
    `SELECT tc.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME,
            kcu.REFERENCED_COLUMN_NAME, rc.DELETE_RULE, rc.UPDATE_RULE,
            COUNT(*) OVER (PARTITION BY tc.CONSTRAINT_NAME) AS COLUMN_COUNT
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND kcu.TABLE_NAME = tc.TABLE_NAME
        AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND rc.TABLE_NAME = tc.TABLE_NAME
        AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'vehicles' AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
        AND kcu.COLUMN_NAME = 'user_id'`
  );
  return rows;
}

async function hasOrphanVehicles(connection) {
  const [rows] = await connection.query(
    `SELECT v.id FROM vehicles v LEFT JOIN users u ON u.id = v.user_id
      WHERE u.id IS NULL LIMIT 1`
  );
  return rows.length > 0;
}

async function assertVehicleMigrationDataSafe(connection) {
  const [duplicateRegistrations] = await connection.query(
    `SELECT UPPER(REPLACE(REPLACE(TRIM(registration_number), ' ', ''), '-', '')) AS canonical, COUNT(*) AS n
     FROM vehicles GROUP BY canonical HAVING COUNT(*) > 1 LIMIT 1`
  );
  if (duplicateRegistrations.length) {
    throw new Error('Vehicle registration normalization would collide. Resolve the affected registrations before applying migration 005.');
  }

  const [multipleActiveCodes] = await connection.query(
    "SELECT vehicle_id FROM qr_codes WHERE status = 'active' GROUP BY vehicle_id HAVING COUNT(*) > 1 LIMIT 1"
  );
  if (multipleActiveCodes.length) {
    throw new Error('Migration 005 found vehicles with multiple active QR passes. Resolve them before applying the one-active-pass constraint.');
  }

  if (await hasOrphanVehicles(connection)) {
    throw migrationError('vehicles.user_id contains values without a matching users.id.');
  }
}

async function ensureUserIdType(connection, table, column) {
  const current = await getColumn(connection, table, column);
  if (!current) throw migrationError(`required column ${table}.${column} is missing.`);
  if (current.GENERATION_EXPRESSION) throw migrationError(`${table}.${column} must not be generated.`);
  if (current.COLUMN_TYPE === 'bigint unsigned' && current.IS_NULLABLE === 'NO' && current.EXTRA.includes('auto_increment') === (table === 'users')) return;
  if (current.COLUMN_TYPE !== 'int unsigned' && current.COLUMN_TYPE !== 'bigint unsigned') {
    throw migrationError(`${table}.${column} has unsupported type ${current.COLUMN_TYPE}.`);
  }
  if (current.IS_NULLABLE !== 'NO' || (table === 'users' && !current.EXTRA.includes('auto_increment'))) {
    throw migrationError(`${table}.${column} has incompatible nullability or auto-increment definition.`);
  }
  const desired = table === 'users' ? 'users.id' : 'vehicles.user_id';
  if (table === 'users' && current.COLUMN_TYPE === 'bigint unsigned') return;
  if (table === 'vehicles' && current.COLUMN_TYPE === 'bigint unsigned') return;
  await connection.query(`ALTER TABLE ${table} MODIFY ${column} BIGINT UNSIGNED NOT NULL${table === 'users' ? ' AUTO_INCREMENT' : ''}`);
  const updated = await getColumn(connection, table, column);
  if (updated?.COLUMN_TYPE !== 'bigint unsigned' || updated.IS_NULLABLE !== 'NO') {
    throw migrationError(`failed to upgrade ${desired} to BIGINT UNSIGNED.`);
  }
}

function normalizeSqlDefinition(value) {
  return String(value || '').toLowerCase().replace(/_utf8mb4/g, '').replace(/[\\\s`()]/g, '');
}

async function ensureQrActiveConstraint(connection) {
  const existing = await inspectQrActiveConstraint(connection);
  if (existing === 'strict') return;
  if (existing === 'legacy') await connection.query('ALTER TABLE qr_codes DROP CHECK chk_qr_codes_active_vehicle_id');
  await addStrictQrActiveConstraint(connection);
}

async function inspectQrActiveConstraint(connection) {
  const [rows] = await connection.query(
    `SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, cc.CHECK_CLAUSE, tc.ENFORCED
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'qr_codes'
        AND tc.CONSTRAINT_NAME = 'chk_qr_codes_active_vehicle_id'`
  );
  const strict = normalizeSqlDefinition("(status = 'active' AND active_vehicle_id IS NOT NULL AND active_vehicle_id = vehicle_id) OR (status = 'revoked' AND active_vehicle_id IS NULL)");
  const legacy = normalizeSqlDefinition("(status = 'active' AND active_vehicle_id = vehicle_id) OR (status = 'revoked' AND active_vehicle_id IS NULL)");
  if (rows.length) {
    const definition = normalizeSqlDefinition(rows[0].CHECK_CLAUSE);
    if (rows[0].CONSTRAINT_TYPE !== 'CHECK' || rows[0].ENFORCED === 'NO' || (definition !== strict && definition !== legacy)) {
      throw migrationError('chk_qr_codes_active_vehicle_id exists with an incorrect or unenforced definition.');
    }
    return definition === strict ? 'strict' : 'legacy';
  }
  return false;
}

async function addStrictQrActiveConstraint(connection) {
  await connection.query(`ALTER TABLE qr_codes ADD CONSTRAINT chk_qr_codes_active_vehicle_id CHECK (
    (status = 'active' AND active_vehicle_id IS NOT NULL AND active_vehicle_id = vehicle_id)
    OR (status = 'revoked' AND active_vehicle_id IS NULL)
  )`);
  await verifyStrictQrActiveConstraint(connection);
}

async function verifyStrictQrActiveConstraint(connection) {
  const definition = await inspectQrActiveConstraint(connection);
  if (definition !== 'strict') throw migrationError('chk_qr_codes_active_vehicle_id is missing or does not require a non-null active key.');
}

async function applyQrActiveCheckConstraintMigration(connection) {
  const activeColumn = await getColumn(connection, 'qr_codes', 'active_vehicle_id');
  if (!activeColumn || activeColumn.COLUMN_TYPE !== 'int unsigned' || activeColumn.IS_NULLABLE !== 'YES' || activeColumn.GENERATION_EXPRESSION) {
    throw migrationError('qr_codes.active_vehicle_id is missing or has an incorrect definition.');
  }
  const definition = await inspectQrActiveConstraint(connection);
  const [duplicates] = await connection.query(
    "SELECT vehicle_id FROM qr_codes WHERE status = 'active' GROUP BY vehicle_id HAVING COUNT(*) > 1 LIMIT 1"
  );
  if (duplicates.length) throw migrationError('multiple active QR rows exist; resolve them before applying migration 006.');
  const [inconsistentRows] = await connection.query(
    `SELECT id FROM qr_codes WHERE
       (status = 'active' AND (active_vehicle_id IS NULL OR active_vehicle_id <> vehicle_id))
       OR (status = 'revoked' AND active_vehicle_id IS NOT NULL) LIMIT 1`
  );
  await ensureActiveQrUniqueIndex(connection);
  if (inconsistentRows.length) {
    await connection.query("UPDATE qr_codes SET active_vehicle_id = CASE WHEN status = 'active' THEN vehicle_id ELSE NULL END");
  }
  if (definition === 'strict') return;
  if (definition === 'legacy') {
    await connection.query('ALTER TABLE qr_codes DROP CHECK chk_qr_codes_active_vehicle_id');
  }
  await addStrictQrActiveConstraint(connection);
}

async function ensureActiveQrUniqueIndex(connection) {
  const [rows] = await connection.query(
    `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qr_codes'
        AND INDEX_NAME = 'uq_qr_codes_one_active_per_vehicle'
      ORDER BY SEQ_IN_INDEX`
  );
  if (rows.length) {
    if (rows.length !== 1 || Number(rows[0].NON_UNIQUE) !== 0 || Number(rows[0].SEQ_IN_INDEX) !== 1 || rows[0].COLUMN_NAME !== 'active_vehicle_id') {
      throw migrationError('uq_qr_codes_one_active_per_vehicle exists with an incorrect definition.');
    }
    return;
  }
  await connection.query('ALTER TABLE qr_codes ADD UNIQUE KEY uq_qr_codes_one_active_per_vehicle (active_vehicle_id)');
  await ensureActiveQrUniqueIndex(connection);
}

async function assertVehicleRegistrationUniqueIndex(connection) {
  const [rows] = await connection.query(
    `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehicles'
        AND INDEX_NAME = 'uq_vehicles_registration_number'
      ORDER BY SEQ_IN_INDEX`
  );
  if (rows.length !== 1 || Number(rows[0].NON_UNIQUE) !== 0 || Number(rows[0].SEQ_IN_INDEX) !== 1 || rows[0].COLUMN_NAME !== 'registration_number') {
    throw migrationError('uq_vehicles_registration_number is missing or has an incorrect definition.');
  }
}

async function verifyVehicleQrIntegritySchema(connection, { allowLegacyActiveRows = false } = {}) {
  for (const table of ['users', 'vehicles', 'qr_codes']) {
    if (!(await tableExists(connection, table))) throw migrationError(`recorded migration 005 is missing table ${table}.`);
  }
  const usersId = await getColumn(connection, 'users', 'id');
  const vehicleUserId = await getColumn(connection, 'vehicles', 'user_id');
  const registrationColumn = await getColumn(connection, 'vehicles', 'registration_number');
  const activeColumn = await getColumn(connection, 'qr_codes', 'active_vehicle_id');
  if (usersId?.COLUMN_TYPE !== 'bigint unsigned' || usersId.IS_NULLABLE !== 'NO' || !usersId.EXTRA.includes('auto_increment')) {
    throw migrationError('recorded migration 005 has an invalid users.id definition.');
  }
  if (vehicleUserId?.COLUMN_TYPE !== 'bigint unsigned' || vehicleUserId.IS_NULLABLE !== 'NO' || vehicleUserId.GENERATION_EXPRESSION) {
    throw migrationError('recorded migration 005 has an invalid vehicles.user_id definition.');
  }
  if (registrationColumn?.COLUMN_TYPE !== 'varchar(50)' || registrationColumn.IS_NULLABLE !== 'NO' || registrationColumn.GENERATION_EXPRESSION) {
    throw migrationError('recorded migration 005 has an invalid vehicles.registration_number definition.');
  }
  if (activeColumn?.COLUMN_TYPE !== 'int unsigned' || activeColumn.IS_NULLABLE !== 'YES' || activeColumn.GENERATION_EXPRESSION) {
    throw migrationError('recorded migration 005 has an invalid qr_codes.active_vehicle_id definition.');
  }
  const fks = await getVehicleUserForeignKeys(connection);
  if (fks.length !== 1 || fks[0].CONSTRAINT_NAME !== 'fk_vehicles_user_id' || Number(fks[0].COLUMN_COUNT) !== 1 || fks[0].REFERENCED_TABLE_NAME !== 'users' || fks[0].REFERENCED_COLUMN_NAME !== 'id' || fks[0].DELETE_RULE !== 'CASCADE' || fks[0].UPDATE_RULE !== 'NO ACTION') {
    throw migrationError('recorded migration 005 has an invalid vehicles.user_id foreign key.');
  }
  await assertVehicleRegistrationUniqueIndex(connection);
  const [activeIndex] = await connection.query(
    `SELECT NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='qr_codes' AND INDEX_NAME='uq_qr_codes_one_active_per_vehicle'
      ORDER BY SEQ_IN_INDEX`
  );
  if (activeIndex.length !== 1 || Number(activeIndex[0].NON_UNIQUE) !== 0 || Number(activeIndex[0].SEQ_IN_INDEX) !== 1 || activeIndex[0].COLUMN_NAME !== 'active_vehicle_id') {
    throw migrationError('recorded migration 005 has an invalid active QR unique index.');
  }
  if (!(await inspectQrActiveConstraint(connection)) && !allowLegacyActiveRows) {
    throw migrationError('recorded migration 005 is missing chk_qr_codes_active_vehicle_id.');
  }
  const [invalidRegistrations] = await connection.query(
    `SELECT id FROM vehicles WHERE registration_number <> UPPER(REPLACE(REPLACE(TRIM(registration_number), ' ', ''), '-', '')) LIMIT 1`
  );
  if (invalidRegistrations.length) throw migrationError('recorded migration 005 has non-canonical vehicle registration values.');
  if (!allowLegacyActiveRows) {
    const [invalidActiveRows] = await connection.query(
      `SELECT id FROM qr_codes WHERE
         (status = 'active' AND (active_vehicle_id IS NULL OR active_vehicle_id <> vehicle_id))
         OR (status = 'revoked' AND active_vehicle_id IS NOT NULL) LIMIT 1`
    );
    if (invalidActiveRows.length) throw migrationError('recorded migration 005 has inconsistent active QR values.');
  }
}

export async function applyVehicleQrIntegrityMigration(connection) {
  for (const table of ['users', 'vehicles', 'qr_codes']) {
    if (!(await tableExists(connection, table))) throw migrationError(`required table ${table} is missing.`);
  }
  await assertVehicleMigrationDataSafe(connection);

  let foreignKeys = await getVehicleUserForeignKeys(connection);
  if (foreignKeys.length > 1) throw migrationError('multiple foreign keys reference vehicles.user_id.');
  if (foreignKeys.length === 1) {
    const fk = foreignKeys[0];
    if (fk.CONSTRAINT_NAME !== 'fk_vehicles_user_id' || Number(fk.COLUMN_COUNT) !== 1 || fk.REFERENCED_TABLE_NAME !== 'users' || fk.REFERENCED_COLUMN_NAME !== 'id' || fk.DELETE_RULE !== 'CASCADE' || fk.UPDATE_RULE !== 'NO ACTION') {
      throw migrationError('the vehicles.user_id foreign key exists with an unexpected definition.');
    }
  }

  const usersId = await getColumn(connection, 'users', 'id');
  const vehicleUserId = await getColumn(connection, 'vehicles', 'user_id');
  if (!usersId || !vehicleUserId) throw migrationError('users.id or vehicles.user_id is missing.');
  const oldPair = usersId.COLUMN_TYPE === 'int unsigned' && vehicleUserId.COLUMN_TYPE === 'int unsigned';
  const newPair = usersId.COLUMN_TYPE === 'bigint unsigned' && vehicleUserId.COLUMN_TYPE === 'bigint unsigned';
  if (!oldPair && !newPair && foreignKeys.length) throw migrationError('foreign-key column types are an unsupported mixed state.');

  if (foreignKeys.length && oldPair) {
    await connection.query('ALTER TABLE vehicles DROP FOREIGN KEY fk_vehicles_user_id');
    foreignKeys = await getVehicleUserForeignKeys(connection);
    if (foreignKeys.length) throw migrationError('failed to remove the legacy vehicles.user_id foreign key.');
  }
  await ensureUserIdType(connection, 'users', 'id');
  await ensureUserIdType(connection, 'vehicles', 'user_id');

  foreignKeys = await getVehicleUserForeignKeys(connection);
  if (!foreignKeys.length) {
    if (await hasOrphanVehicles(connection)) throw migrationError('cannot add the user foreign key because orphan vehicles exist.');
    await connection.query('ALTER TABLE vehicles ADD CONSTRAINT fk_vehicles_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE');
    foreignKeys = await getVehicleUserForeignKeys(connection);
  }
  if (foreignKeys.length !== 1 || foreignKeys[0].CONSTRAINT_NAME !== 'fk_vehicles_user_id' || Number(foreignKeys[0].COLUMN_COUNT) !== 1 || foreignKeys[0].REFERENCED_TABLE_NAME !== 'users' || foreignKeys[0].REFERENCED_COLUMN_NAME !== 'id' || foreignKeys[0].DELETE_RULE !== 'CASCADE' || foreignKeys[0].UPDATE_RULE !== 'NO ACTION') {
    throw migrationError('vehicles.user_id foreign key does not match the required users(id) ON DELETE CASCADE definition.');
  }

  const [collisions] = await connection.query(
    `SELECT UPPER(REPLACE(REPLACE(TRIM(registration_number), ' ', ''), '-', '')) AS canonical, COUNT(*) AS n
       FROM vehicles GROUP BY canonical HAVING COUNT(*) > 1 LIMIT 1`
  );
  if (collisions.length) throw migrationError('registration normalization would create duplicate canonical values.');
  const registrationColumn = await getColumn(connection, 'vehicles', 'registration_number');
  if (!registrationColumn || registrationColumn.COLUMN_TYPE !== 'varchar(50)' || registrationColumn.IS_NULLABLE !== 'NO' || registrationColumn.GENERATION_EXPRESSION) {
    throw migrationError('vehicles.registration_number must be a non-null VARCHAR(50) column.');
  }
  const [nonCanonicalRegistrations] = await connection.query(
    `SELECT id FROM vehicles WHERE registration_number <> UPPER(REPLACE(REPLACE(TRIM(registration_number), ' ', ''), '-', '')) LIMIT 1`
  );
  if (nonCanonicalRegistrations.length) {
    await connection.query("UPDATE vehicles SET registration_number = UPPER(REPLACE(REPLACE(TRIM(registration_number), ' ', ''), '-', ''))");
  }
  await assertVehicleRegistrationUniqueIndex(connection);

  let activeColumn = await getColumn(connection, 'qr_codes', 'active_vehicle_id');
  if (!activeColumn) {
    await connection.query('ALTER TABLE qr_codes ADD COLUMN active_vehicle_id INT UNSIGNED NULL');
    activeColumn = await getColumn(connection, 'qr_codes', 'active_vehicle_id');
  }
  if (!activeColumn || activeColumn.COLUMN_TYPE !== 'int unsigned' || activeColumn.IS_NULLABLE !== 'YES' || activeColumn.GENERATION_EXPRESSION) {
    throw migrationError('qr_codes.active_vehicle_id exists with an incorrect definition.');
  }
  await inspectQrActiveConstraint(connection);

  const [activeDuplicates] = await connection.query(
    "SELECT vehicle_id FROM qr_codes WHERE status = 'active' GROUP BY vehicle_id HAVING COUNT(*) > 1 LIMIT 1"
  );
  if (activeDuplicates.length) throw migrationError('multiple active QR rows exist for a vehicle.');
  const [inconsistentActiveRows] = await connection.query(
    `SELECT id FROM qr_codes WHERE
       (status = 'active' AND (active_vehicle_id IS NULL OR active_vehicle_id <> vehicle_id))
       OR (status = 'revoked' AND active_vehicle_id IS NOT NULL) LIMIT 1`
  );
  await ensureActiveQrUniqueIndex(connection);
  if (inconsistentActiveRows.length) {
    await connection.query("UPDATE qr_codes SET active_vehicle_id = CASE WHEN status = 'active' THEN vehicle_id ELSE NULL END");
  }
  await ensureQrActiveConstraint(connection);
}

export async function runMigrations(env = process.env) {
  if (env.NODE_ENV === 'production' && (!env.MIGRATION_DB_USER || !env.MIGRATION_DB_PASSWORD)) {
    throw new Error('Production migrations require MIGRATION_DB_USER and MIGRATION_DB_PASSWORD.');
  }
  const pool = mysql.createPool({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT) || 3306,
    user: env.MIGRATION_DB_USER || env.DB_USER || 'parkx_app',
    password: env.MIGRATION_DB_PASSWORD || env.DB_PASSWORD || '',
    database: env.DB_NAME || 'parkx_db',
    waitForConnections: true,
    connectionLimit: 2,
    charset: 'utf8mb4',
  });
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations().catch((error) => {
    console.error('Migration failed:', error.code || error.message);
    process.exitCode = 1;
  });
}
