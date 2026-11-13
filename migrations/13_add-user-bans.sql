-- Adds ban columns to users so administrators can ban players for a specified
-- duration. When banned_until is in the future, the player cannot queue for ranked
-- matches, receives a warning on opening the website, and is excluded from the
-- public leaderboard.

-- Up Migration

ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_by TEXT;

CREATE INDEX IF NOT EXISTS users_banned_until_idx ON users (banned_until);

-- Down Migration

DROP INDEX IF EXISTS users_banned_until_idx;
ALTER TABLE users DROP COLUMN IF EXISTS banned_by;
ALTER TABLE users DROP COLUMN IF EXISTS banned_at;
ALTER TABLE users DROP COLUMN IF EXISTS ban_reason;
ALTER TABLE users DROP COLUMN IF EXISTS banned_until;
