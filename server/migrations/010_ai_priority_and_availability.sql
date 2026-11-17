-- ParkX Phase 3.5: AI Priority Classification & Owner Availability
-- 1. Owner availability status, transition versioning, and automated reply configuration
ALTER TABLE users
  ADD COLUMN availability_status ENUM('available', 'busy', 'away') NOT NULL DEFAULT 'available',
  ADD COLUMN auto_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN auto_reply_busy VARCHAR(500) NULL DEFAULT 'I am currently busy. I have received your message and will respond as soon as possible.',
  ADD COLUMN auto_reply_away VARCHAR(500) NULL DEFAULT 'I am currently away from my vehicle. I have received your message and will respond when I return.',
  ADD COLUMN availability_version INT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN availability_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- 2. Visitor message priority classification and automated reply flag
ALTER TABLE visitor_messages
  ADD COLUMN priority ENUM('urgent', 'high', 'normal', 'low') NOT NULL DEFAULT 'normal',
  ADD COLUMN priority_reason VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN priority_overridden BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN is_auto_reply BOOLEAN NOT NULL DEFAULT FALSE,
  ADD KEY idx_visitor_messages_priority (session_id, priority);

-- 3. Visitor session priority, manual override tracking, and anti-spam auto-reply state
ALTER TABLE visitor_sessions
  ADD COLUMN session_priority ENUM('urgent', 'high', 'normal', 'low') NOT NULL DEFAULT 'normal',
  ADD COLUMN priority_overridden BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN last_auto_reply_status ENUM('available', 'busy', 'away') NULL DEFAULT NULL,
  ADD COLUMN last_auto_reply_version INT UNSIGNED NULL DEFAULT NULL,
  ADD KEY idx_visitor_sessions_priority (session_priority, created_at);
