-- Keep the foreign key compatible with the canonical BIGINT users.id schema.
-- Migration 004 is corrected for fresh installs; this forward migration also
-- upgrades installations that already applied its original INT definition.
ALTER TABLE vehicles DROP FOREIGN KEY fk_vehicles_user_id;
ALTER TABLE users MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE vehicles MODIFY user_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE vehicles ADD CONSTRAINT fk_vehicles_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

-- Store a stable, uppercase ASCII registration key with formatting separators removed.
UPDATE vehicles SET registration_number = UPPER(REPLACE(REPLACE(TRIM(registration_number), ' ', ''), '-', ''));

-- Enforce at most one active pass per vehicle; revoked rows have NULL here.
-- A regular nullable key is used for broad MySQL compatibility. The CHECK
-- constraint keeps the key synchronized with the status and vehicle columns.
ALTER TABLE qr_codes ADD COLUMN active_vehicle_id INT UNSIGNED NULL;
UPDATE qr_codes SET active_vehicle_id = vehicle_id WHERE status = 'active';
ALTER TABLE qr_codes
  ADD UNIQUE KEY uq_qr_codes_one_active_per_vehicle (active_vehicle_id),
  ADD CONSTRAINT chk_qr_codes_active_vehicle_id CHECK (
    (status = 'active' AND active_vehicle_id = vehicle_id)
    OR (status = 'revoked' AND active_vehicle_id IS NULL)
  );
