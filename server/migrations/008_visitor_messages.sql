-- ParkX Phase 3.3: Visitor-Owner Messaging
-- Stores asynchronous two-way messages between anonymous visitors and vehicle owners.
CREATE TABLE IF NOT EXISTS visitor_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  sender_type ENUM('visitor', 'owner') NOT NULL,
  body TEXT NOT NULL,
  client_message_id VARCHAR(64) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_visitor_messages_session_id (session_id, id),
  UNIQUE KEY uq_visitor_messages_client_id (session_id, sender_type, client_message_id),
  CONSTRAINT fk_visitor_messages_session_id FOREIGN KEY (session_id) REFERENCES visitor_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
