-- ParkX Phase 3.2: Anonymous Visitor Sessions
-- Stores temporary contact sessions between unauthenticated visitors and vehicle owners.
CREATE TABLE IF NOT EXISTS visitor_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(64) NOT NULL,
  vehicle_id INT UNSIGNED NOT NULL,
  credential_hash VARCHAR(64) NOT NULL,
  status ENUM('pending', 'accepted', 'closed', 'expired') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  accepted_at TIMESTAMP NULL DEFAULT NULL,
  closed_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_visitor_sessions_public_id (public_id),
  KEY idx_visitor_sessions_vehicle_status (vehicle_id, status, created_at),
  KEY idx_visitor_sessions_credential_hash (credential_hash),
  KEY idx_visitor_sessions_expires_status (expires_at, status),
  KEY idx_visitor_sessions_closed_status (closed_at, status),
  CONSTRAINT fk_visitor_sessions_vehicle_id FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
