-- ParkX Phase 3.4: Owner Notifications and Unread Message Tracking
-- 1. Persistent unread tracking: add read cursor to visitor_sessions
ALTER TABLE visitor_sessions
  ADD COLUMN owner_last_read_message_id BIGINT UNSIGNED NULL DEFAULT NULL;

-- 2. Browser push notification subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  endpoint VARCHAR(512) NOT NULL,
  p256dh VARCHAR(255) NOT NULL,
  auth VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_subscriptions_endpoint (endpoint),
  KEY idx_push_subscriptions_user_id (user_id),
  CONSTRAINT fk_push_subscriptions_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
