import fs from 'node:fs';
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
        if (file === '007_visitor_sessions.sql') await verifyVisitorSessionsSchema(connection);
        continue;
      }
      if (file.startsWith('003_')) await assertNoNormalizedEmailDuplicates(connection);
      if (file === '005_vehicle_qr_integrity.sql') {
        await applyVehicleQrIntegrityMigration(connection);
      } else if (file === '006_vehicle_qr_check_integrity.sql') {
        await applyQrActiveCheckConstraintMigration(connection);
      } else if (file === '007_visitor_sessions.sql') {
        const exists = await tableExists(connection, 'visitor_sessions');
        if (exists) {
          await verifyVisitorSessionsSchema(connection);
        } else {
          const sql = (await readFile(path.join(migrationDirectory, file), 'utf8')).replace(/^\s*--.*$/gm, '');
          for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
            await connection.query(statement);
          }
          await verifyVisitorSessionsSchema(connection);
        }
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

export function migration007Error(message) {
  return new Error(`Migration 007 schema inconsistency: ${message}`);
}

export async function verifyVisitorSessionsSchema(connection) {
  // 1. Table existence & engine & collation
  const [tableRows] = await connection.query(
    'SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    ['visitor_sessions']
  );
  if (!tableRows.length) {
    throw migration007Error('required table visitor_sessions is missing.');
  }
  if ((tableRows[0].ENGINE || '').toLowerCase() !== 'innodb') {
    throw migration007Error(`visitor_sessions table engine must be InnoDB, found ${tableRows[0].ENGINE}.`);
  }
  if ((tableRows[0].TABLE_COLLATION || '').toLowerCase() !== 'utf8mb4_unicode_ci') {
    throw migration007Error(`visitor_sessions table collation must be utf8mb4_unicode_ci, found ${tableRows[0].TABLE_COLLATION}.`);
  }

  // 2. Required columns and types
  const [cols] = await connection.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
            CHARACTER_SET_NAME, COLLATION_NAME, GENERATION_EXPRESSION
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    ['visitor_sessions']
  );

  if (cols.length !== 9) {
    throw migration007Error(`visitor_sessions table must contain exactly 9 columns, found ${cols.length}.`);
  }

  // Reject generated or invisible columns across the table
  for (const c of cols) {
    if (c.GENERATION_EXPRESSION) {
      throw migration007Error(`column ${c.COLUMN_NAME} on visitor_sessions must not be a generated column.`);
    }
    if (/\binvisible\b/i.test(c.EXTRA || '')) {
      throw migration007Error(`column ${c.COLUMN_NAME} on visitor_sessions must not be an invisible column.`);
    }
    if (/\b(?:virtual|stored)\b/i.test(c.EXTRA || '')) {
      throw migration007Error(`column ${c.COLUMN_NAME} on visitor_sessions must not be a generated column.`);
    }
    if (c.COLUMN_NAME !== 'id' && /\bauto_increment\b/i.test(c.EXTRA || '')) {
      throw migration007Error(`column ${c.COLUMN_NAME} on visitor_sessions must not be auto_increment.`);
    }
  }

  const colMap = new Map(cols.map((c) => [c.COLUMN_NAME, c]));

  // id: strictly BIGINT UNSIGNED, not null, auto_increment, no default
  const idCol = colMap.get('id');
  if (
    !idCol ||
    idCol.COLUMN_TYPE !== 'bigint unsigned' ||
    idCol.IS_NULLABLE !== 'NO' ||
    !idCol.EXTRA.includes('auto_increment') ||
    idCol.COLUMN_DEFAULT !== null
  ) {
    throw migration007Error('invalid id column definition on visitor_sessions: must be BIGINT UNSIGNED AUTO_INCREMENT.');
  }

  // public_id: strictly VARCHAR(64), not null, utf8mb4_unicode_ci, no default, no on update
  const publicIdCol = colMap.get('public_id');
  if (
    !publicIdCol ||
    publicIdCol.COLUMN_TYPE !== 'varchar(64)' ||
    publicIdCol.IS_NULLABLE !== 'NO' ||
    publicIdCol.COLUMN_DEFAULT !== null ||
    publicIdCol.EXTRA.includes('auto_increment') ||
    /\bon update\b/i.test(publicIdCol.EXTRA || '') ||
    (publicIdCol.CHARACTER_SET_NAME && publicIdCol.CHARACTER_SET_NAME !== 'utf8mb4') ||
    (publicIdCol.COLLATION_NAME && publicIdCol.COLLATION_NAME !== 'utf8mb4_unicode_ci')
  ) {
    throw migration007Error('invalid public_id column definition on visitor_sessions: must be VARCHAR(64) NOT NULL.');
  }

  // vehicle_id: strictly INT UNSIGNED, not null, no default, no on update
  const vehicleIdCol = colMap.get('vehicle_id');
  if (
    !vehicleIdCol ||
    vehicleIdCol.COLUMN_TYPE !== 'int unsigned' ||
    vehicleIdCol.IS_NULLABLE !== 'NO' ||
    vehicleIdCol.COLUMN_DEFAULT !== null ||
    vehicleIdCol.EXTRA.includes('auto_increment') ||
    /\bon update\b/i.test(vehicleIdCol.EXTRA || '')
  ) {
    throw migration007Error('invalid vehicle_id column definition on visitor_sessions: must be INT UNSIGNED NOT NULL.');
  }

  // credential_hash: strictly VARCHAR(64), not null, utf8mb4_unicode_ci, no default, no on update
  const credCol = colMap.get('credential_hash');
  if (
    !credCol ||
    credCol.COLUMN_TYPE !== 'varchar(64)' ||
    credCol.IS_NULLABLE !== 'NO' ||
    credCol.COLUMN_DEFAULT !== null ||
    credCol.EXTRA.includes('auto_increment') ||
    /\bon update\b/i.test(credCol.EXTRA || '') ||
    (credCol.CHARACTER_SET_NAME && credCol.CHARACTER_SET_NAME !== 'utf8mb4') ||
    (credCol.COLLATION_NAME && credCol.COLLATION_NAME !== 'utf8mb4_unicode_ci')
  ) {
    throw migration007Error('invalid credential_hash column definition on visitor_sessions: must be VARCHAR(64) NOT NULL.');
  }

  // status: strictly ENUM('pending','accepted','closed','expired') NOT NULL DEFAULT 'pending' with utf8mb4_unicode_ci collation
  const statusCol = colMap.get('status');
  const exactStatusEnum = "enum('pending','accepted','closed','expired')";
  if (
    !statusCol ||
    statusCol.COLUMN_TYPE !== exactStatusEnum ||
    statusCol.IS_NULLABLE !== 'NO' ||
    statusCol.COLUMN_DEFAULT !== 'pending' ||
    /\bon update\b/i.test(statusCol.EXTRA || '') ||
    (statusCol.CHARACTER_SET_NAME && statusCol.CHARACTER_SET_NAME !== 'utf8mb4') ||
    (statusCol.COLLATION_NAME && statusCol.COLLATION_NAME !== 'utf8mb4_unicode_ci')
  ) {
    throw migration007Error("invalid status column definition on visitor_sessions: must be ENUM('pending','accepted','closed','expired') NOT NULL DEFAULT 'pending' with utf8mb4_unicode_ci collation.");
  }

  // created_at: strictly TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP without ON UPDATE
  const createdCol = colMap.get('created_at');
  if (
    !createdCol ||
    createdCol.COLUMN_TYPE !== 'timestamp' ||
    createdCol.IS_NULLABLE !== 'NO' ||
    String(createdCol.COLUMN_DEFAULT ?? '').trim().toLowerCase() !== 'current_timestamp' ||
    /\bon update\b/i.test(createdCol.EXTRA || '')
  ) {
    throw migration007Error('invalid created_at column definition on visitor_sessions: must be TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP without ON UPDATE.');
  }

  // expires_at: strictly TIMESTAMP NOT NULL without a default and without ON UPDATE
  const expiresCol = colMap.get('expires_at');
  if (
    !expiresCol ||
    expiresCol.COLUMN_TYPE !== 'timestamp' ||
    expiresCol.IS_NULLABLE !== 'NO' ||
    expiresCol.COLUMN_DEFAULT !== null ||
    /\bon update\b/i.test(expiresCol.EXTRA || '')
  ) {
    throw migration007Error('invalid expires_at column definition on visitor_sessions: must be TIMESTAMP NOT NULL without a default or ON UPDATE clause.');
  }

  // accepted_at: strictly TIMESTAMP NULL DEFAULT NULL without an unexpected default and without ON UPDATE
  const acceptedCol = colMap.get('accepted_at');
  if (
    !acceptedCol ||
    acceptedCol.COLUMN_TYPE !== 'timestamp' ||
    acceptedCol.IS_NULLABLE !== 'YES' ||
    acceptedCol.COLUMN_DEFAULT !== null ||
    /\bon update\b/i.test(acceptedCol.EXTRA || '')
  ) {
    throw migration007Error('invalid accepted_at column definition on visitor_sessions: must be TIMESTAMP NULL DEFAULT NULL without an unexpected default or ON UPDATE clause.');
  }

  // closed_at: strictly TIMESTAMP NULL DEFAULT NULL without an unexpected default and without ON UPDATE
  const closedCol = colMap.get('closed_at');
  if (
    !closedCol ||
    closedCol.COLUMN_TYPE !== 'timestamp' ||
    closedCol.IS_NULLABLE !== 'YES' ||
    closedCol.COLUMN_DEFAULT !== null ||
    /\bon update\b/i.test(closedCol.EXTRA || '')
  ) {
    throw migration007Error('invalid closed_at column definition on visitor_sessions: must be TIMESTAMP NULL DEFAULT NULL without an unexpected default or ON UPDATE clause.');
  }

  // Exact DDL inspection using SHOW CREATE TABLE for EVERY column
  const [createTableRows] = await connection.query('SHOW CREATE TABLE visitor_sessions');
  const createTableSql = createTableRows[0]?.['Create Table'] || '';

  const extractColDdl = (colName) => {
    const match = createTableSql.match(new RegExp(`^\\s*[\`"]?${colName}[\`"]?\\s+(.*?),?$`, 'm'));
    return match ? match[1].trim() : null;
  };

  const idDdl = extractColDdl('id');
  if (!idDdl || !/^bigint\s+unsigned\s+NOT\s+NULL\s+AUTO_INCREMENT$/i.test(idDdl) || /\bdefault\b/i.test(idDdl) || /\bon\s+update\b/i.test(idDdl) || /\binvisible\b/i.test(idDdl)) {
    throw migration007Error('invalid id column definition on visitor_sessions: must be BIGINT UNSIGNED NOT NULL AUTO_INCREMENT without defaults in DDL.');
  }

  const publicIdDdl = extractColDdl('public_id');
  if (!publicIdDdl || !/^varchar\(64\)(?:\s+CHARACTER\s+SET\s+utf8mb4)?(?:\s+COLLATE\s+utf8mb4_unicode_ci)?\s+NOT\s+NULL$/i.test(publicIdDdl) || /\bdefault\b/i.test(publicIdDdl) || /\bon\s+update\b/i.test(publicIdDdl) || /\binvisible\b/i.test(publicIdDdl)) {
    throw migration007Error('invalid public_id column definition on visitor_sessions: must be VARCHAR(64) NOT NULL without defaults in DDL.');
  }

  const vehicleIdDdl = extractColDdl('vehicle_id');
  if (!vehicleIdDdl || !/^int\s+unsigned\s+NOT\s+NULL$/i.test(vehicleIdDdl) || /\bdefault\b/i.test(vehicleIdDdl) || /\bon\s+update\b/i.test(vehicleIdDdl) || /\binvisible\b/i.test(vehicleIdDdl)) {
    throw migration007Error('invalid vehicle_id column definition on visitor_sessions: must be INT UNSIGNED NOT NULL without defaults in DDL.');
  }

  const credDdl = extractColDdl('credential_hash');
  if (!credDdl || !/^varchar\(64\)(?:\s+CHARACTER\s+SET\s+utf8mb4)?(?:\s+COLLATE\s+utf8mb4_unicode_ci)?\s+NOT\s+NULL$/i.test(credDdl) || /\bdefault\b/i.test(credDdl) || /\bon\s+update\b/i.test(credDdl) || /\binvisible\b/i.test(credDdl)) {
    throw migration007Error('invalid credential_hash column definition on visitor_sessions: must be VARCHAR(64) NOT NULL without defaults in DDL.');
  }

  const statusDdl = extractColDdl('status');
  if (!statusDdl || !/^enum\('pending','accepted','closed','expired'\)(?:\s+CHARACTER\s+SET\s+utf8mb4)?(?:\s+COLLATE\s+utf8mb4_unicode_ci)?\s+NOT\s+NULL\s+DEFAULT\s+'pending'$/i.test(statusDdl) || /\bon\s+update\b/i.test(statusDdl) || /\binvisible\b/i.test(statusDdl)) {
    throw migration007Error("invalid status column definition on visitor_sessions: must be ENUM('pending','accepted','closed','expired') NOT NULL DEFAULT 'pending' in DDL.");
  }

  const createdDdl = extractColDdl('created_at');
  if (!createdDdl || !/^timestamp\s+NOT\s+NULL\s+DEFAULT\s+CURRENT_TIMESTAMP$/i.test(createdDdl) || /\bon\s+update\b/i.test(createdDdl) || /\binvisible\b/i.test(createdDdl)) {
    throw migration007Error('invalid created_at column definition on visitor_sessions: must be TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP without ON UPDATE in DDL.');
  }

  const expiresDdl = extractColDdl('expires_at');
  if (!expiresDdl || !/^timestamp\s+NOT\s+NULL$/i.test(expiresDdl) || /\bdefault\b/i.test(expiresDdl) || /\bon\s+update\b/i.test(expiresDdl) || /\binvisible\b/i.test(expiresDdl)) {
    throw migration007Error('invalid expires_at column definition on visitor_sessions: must be TIMESTAMP NOT NULL without a default or ON UPDATE clause in DDL.');
  }

  const acceptedDdl = extractColDdl('accepted_at');
  if (!acceptedDdl || !/^timestamp\s+NULL\s+DEFAULT\s+NULL$/i.test(acceptedDdl) || /\bon\s+update\b/i.test(acceptedDdl) || /\binvisible\b/i.test(acceptedDdl)) {
    throw migration007Error('invalid accepted_at column definition on visitor_sessions: must explicitly specify DEFAULT NULL in DDL without an unexpected default or ON UPDATE clause.');
  }

  const closedDdl = extractColDdl('closed_at');
  if (!closedDdl || !/^timestamp\s+NULL\s+DEFAULT\s+NULL$/i.test(closedDdl) || /\bon\s+update\b/i.test(closedDdl) || /\binvisible\b/i.test(closedDdl)) {
    throw migration007Error('invalid closed_at column definition on visitor_sessions: must explicitly specify DEFAULT NULL in DDL without an unexpected default or ON UPDATE clause.');
  }

  // 3. Exact Index Set & Direction Verification
  const [indexes] = await connection.query(
    `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, INDEX_TYPE, IS_VISIBLE, COLLATION
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'visitor_sessions'
     ORDER BY INDEX_NAME, SEQ_IN_INDEX`
  );

  const indexGroups = new Map();
  for (const idx of indexes) {
    if (!indexGroups.has(idx.INDEX_NAME)) indexGroups.set(idx.INDEX_NAME, []);
    indexGroups.get(idx.INDEX_NAME).push(idx);
  }

  // The complete expected index set according to migration 007
  const expectedIndexes = new Map([
    [
      'PRIMARY',
      {
        unique: true,
        columns: ['id'],
      },
    ],
    [
      'uq_visitor_sessions_public_id',
      {
        unique: true,
        columns: ['public_id'],
      },
    ],
    [
      'idx_visitor_sessions_vehicle_status',
      {
        unique: false,
        columns: ['vehicle_id', 'status', 'created_at'],
      },
    ],
    [
      'idx_visitor_sessions_credential_hash',
      {
        unique: false,
        columns: ['credential_hash'],
      },
    ],
    [
      'idx_visitor_sessions_expires_status',
      {
        unique: false,
        columns: ['expires_at', 'status'],
      },
    ],
    [
      'idx_visitor_sessions_closed_status',
      {
        unique: false,
        columns: ['closed_at', 'status'],
      },
    ],
  ]);

  // Reject unexpected extra indexes
  for (const actualName of indexGroups.keys()) {
    if (!expectedIndexes.has(actualName)) {
      throw migration007Error(`unexpected extra index ${actualName} found on visitor_sessions.`);
    }
  }

  // Ensure every expected index exists
  for (const expectedName of expectedIndexes.keys()) {
    if (!indexGroups.has(expectedName)) {
      throw migration007Error(`missing required index ${expectedName} on visitor_sessions.`);
    }
  }

  if (indexGroups.size !== expectedIndexes.size) {
    throw migration007Error(`visitor_sessions must have exactly ${expectedIndexes.size} indexes, found ${indexGroups.size}.`);
  }

  // Verify each index's uniqueness, ordered columns, prefix length, visibility, and BTREE type
  for (const [name, expected] of expectedIndexes.entries()) {
    const actualCols = indexGroups.get(name);
    if (!actualCols || actualCols.length !== expected.columns.length) {
      throw migration007Error(`index ${name} on visitor_sessions has incorrect column count: expected ${expected.columns.length}, found ${actualCols?.length}.`);
    }
    const isUnique = Number(actualCols[0].NON_UNIQUE) === 0;
    if (isUnique !== expected.unique) {
      throw migration007Error(`index ${name} on visitor_sessions has incorrect uniqueness: expected unique=${expected.unique}.`);
    }
    for (let i = 0; i < expected.columns.length; i++) {
      const col = actualCols[i];
      if (col.COLUMN_NAME !== expected.columns[i]) {
        throw migration007Error(`index ${name} column at position ${i + 1} must be ${expected.columns[i]}, found ${col.COLUMN_NAME}.`);
      }
      if (Number(col.SEQ_IN_INDEX) !== i + 1) {
        throw migration007Error(`index ${name} column ${expected.columns[i]} has incorrect sequence position.`);
      }
      if (col.SUB_PART !== null && col.SUB_PART !== undefined) {
        throw migration007Error(`index ${name} must be a full-column index; prefix index (sub_part=${col.SUB_PART}) is rejected.`);
      }
      if (String(col.IS_VISIBLE).toUpperCase() !== 'YES') {
        throw migration007Error(`index ${name} on visitor_sessions is invisible; all migration 007 indexes must be visible.`);
      }
      if (String(col.INDEX_TYPE).toUpperCase() !== 'BTREE') {
        throw migration007Error(`index ${name} on visitor_sessions must have INDEX_TYPE BTREE.`);
      }
      if (col.COLLATION !== 'A') {
        throw migration007Error(`index ${name} column ${expected.columns[i]} must have ascending direction ('A'), found '${col.COLLATION}'.`);
      }
    }
  }

  // 5. Foreign key on vehicle_id -> vehicles(id) ON DELETE CASCADE
  const [schemaRows] = await connection.query('SELECT DATABASE() AS schemaName');
  const currentSchema = schemaRows[0]?.schemaName;
  const [fks] = await connection.query(
    `SELECT tc.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.ORDINAL_POSITION,
            kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
            kcu.REFERENCED_COLUMN_NAME, rc.DELETE_RULE, rc.UPDATE_RULE
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
      AND tc.TABLE_NAME = 'visitor_sessions'
      AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'`
  );

  const fkGroups = new Map();
  for (const fk of fks) {
    if (!fkGroups.has(fk.CONSTRAINT_NAME)) fkGroups.set(fk.CONSTRAINT_NAME, []);
    fkGroups.get(fk.CONSTRAINT_NAME).push(fk);
  }
  const validFk = fkGroups.size === 1 ? [...fkGroups.values()][0] : null;
  if (
    !validFk || validFk.length !== 1 ||
    validFk[0].CONSTRAINT_NAME !== 'fk_visitor_sessions_vehicle_id' ||
    validFk[0].COLUMN_NAME !== 'vehicle_id' || Number(validFk[0].ORDINAL_POSITION) !== 1 ||
    validFk[0].REFERENCED_TABLE_SCHEMA !== currentSchema ||
    validFk[0].REFERENCED_TABLE_NAME !== 'vehicles' ||
    validFk[0].REFERENCED_COLUMN_NAME !== 'id' ||
    validFk[0].DELETE_RULE !== 'CASCADE' ||
    !['NO ACTION', 'RESTRICT'].includes(validFk[0].UPDATE_RULE)
  ) {
    throw migration007Error('foreign key must be named fk_visitor_sessions_vehicle_id and reference vehicle_id to vehicles(id) with ON DELETE CASCADE.');
  }
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

export function resolveMigrationEnvPath(metaUrl = import.meta.url) {
  return fileURLToPath(new URL('../.env', metaUrl));
}

export function loadMigrationEnv({ metaUrl = import.meta.url, dotenvModule } = {}) {
  try {
    const envPath = resolveMigrationEnvPath(metaUrl);
    if (dotenvModule && typeof dotenvModule.config === 'function') {
      dotenvModule.config({ path: envPath, override: false });
    }
  } catch {}
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    const current = fileURLToPath(import.meta.url);
    const entry = path.resolve(process.argv[1]);
    if (current === entry) return true;
    return fs.existsSync(entry) && fs.realpathSync(current) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    const dotenv = await import('dotenv');
    loadMigrationEnv({ dotenvModule: dotenv });
  } catch {}

  // Safe CLI inspect mode: allows testing environment resolution without database execution or secret leakage
  if (process.argv.includes('--inspect-env') || process.argv.includes('--dry-run')) {
    const sentinelKey = process.env.MIGRATION_SENTINEL_KEY || 'MIGRATION_ENV_SENTINEL';
    const sentinelLoaded = typeof process.env[sentinelKey] === 'string' && process.env[sentinelKey].length > 0;
    process.stdout.write(JSON.stringify({
      sentinelLoaded,
      sentinelKey,
      hasTestInspectVar: typeof process.env.TEST_INSPECT_VAR === 'string',
      testInspectVarMatches: process.env.TEST_INSPECT_VAR === 'precedence_value_from_process',
    }));
    process.exit(0);
  }

  runMigrations().catch((error) => {
    console.error('Migration failed:', error.code || error.message);
    process.exitCode = 1;
  });
}
