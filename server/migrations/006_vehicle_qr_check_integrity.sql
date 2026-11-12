-- Forward correction for MySQL's three-valued CHECK semantics: active rows
-- must explicitly require a non-NULL active_vehicle_id. Apply via migrate.js,
-- which safely replaces the legacy named CHECK and resumes after interruption.
ALTER TABLE qr_codes DROP CHECK chk_qr_codes_active_vehicle_id;
ALTER TABLE qr_codes ADD CONSTRAINT chk_qr_codes_active_vehicle_id CHECK (
  (status = 'active' AND active_vehicle_id IS NOT NULL AND active_vehicle_id = vehicle_id)
  OR (status = 'revoked' AND active_vehicle_id IS NULL)
);
