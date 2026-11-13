-- The schema as it stood before migrations existed, lifted verbatim out of
-- src/db/db.js's old SCHEMA string (which ran on every boot). Every statement
-- here is idempotent, so a database created by that old code applies this
-- baseline as a no-op and simply records it - no dump/restore needed to adopt
-- migrations on an existing deployment.
--
-- The starting elo is a literal 1000 rather than config.startingElo, which is
-- what the string used to interpolate. The column default is close to
-- vestigial anyway: users.upsertFromDiscord() passes the configured starting
-- rating explicitly on the only INSERT that ever creates a user.

-- Up Migration

CREATE TABLE IF NOT EXISTS users (
  discord_id               TEXT PRIMARY KEY,
  username                 TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  avatar_hash              TEXT,
  elo                      INTEGER NOT NULL DEFAULT 1000,
  discord_access_token     TEXT,
  discord_refresh_token    TEXT,
  discord_token_expires_at TIMESTAMPTZ,
  discord_refreshed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- Single-use CSRF nonces for the OAuth round trip.
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx ON oauth_states (expires_at);

-- Handoff for non-browser (e.g. in-game) logins: /api/callback writes the
-- outcome here keyed by the same state the client got from /api/login, and
-- the client polls for it. Single-use - claimed rows are deleted on read.
-- token is stored in cleartext, same as it is in the URL fragment the web
-- flow uses; the short TTL and unguessable state key give it the same
-- exposure window as that fragment.
CREATE TABLE IF NOT EXISTS device_logins (
  state      TEXT PRIMARY KEY,
  token      TEXT,
  user_id    TEXT REFERENCES users(discord_id) ON DELETE CASCADE,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS device_logins_expires_at_idx ON device_logins (expires_at);

-- One row per match, from user_id's point of view. opponent_id/opponent_name
-- are not a FK to users: the opponent may never have logged in themselves, so
-- their name is snapshotted here rather than requiring a join.
-- replay_url is nullable: not every match has a replay attached (older rows,
-- or a player who reported a result without uploading one).
CREATE TABLE IF NOT EXISTS matches (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  opponent_id   TEXT NOT NULL,
  opponent_name TEXT NOT NULL,
  stage         TEXT NOT NULL,
  elo_delta     INTEGER NOT NULL,
  replay_url    TEXT,
  played_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS matches_user_id_played_at_idx ON matches (user_id, played_at DESC);

-- Was NOT NULL when replay upload was still planned as day-one functionality;
-- relaxed now that it is off. No-op once already nullable.
ALTER TABLE matches ALTER COLUMN replay_url DROP NOT NULL;

-- Correlates the two rows (one per side) written for the same real match -
-- matchmaking.js sets it to the redis match id (finishPlaying()), so a
-- detail view can pull both perspectives back together. gamemode is
-- similarly a snapshot, same reasoning as opponent_name above. Both added
-- after matches already shipped, hence the separate ALTERs rather than being
-- part of the CREATE TABLE above.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS match_uid TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS gamemode TEXT;
CREATE INDEX IF NOT EXISTS matches_match_uid_idx ON matches (match_uid);

-- Ranked ELO is now tracked separately per gamemode rather than as one
-- combined number (the two queues - Coin Runners and Star Chasers - were
-- already paired independently of one another, see matchmaking.js's
-- GAMEMODES, so a single shared rating never reflected either queue on its
-- own). The original 'elo' column is left in place rather than dropped, same
-- reasoning as the other ALTERs above.
ALTER TABLE users ADD COLUMN IF NOT EXISTS elo_coin_runners INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE users ADD COLUMN IF NOT EXISTS elo_star_chasers INTEGER NOT NULL DEFAULT 1000;

-- Lets an admin (the Discord bot's /match "Revert" button - see
-- src/domain/matchmaking.js's revertMatch()) undo a fraudulent result: the
-- row stays in history rather than being deleted, so what happened and who
-- reverted it is still visible, but its elo contribution is reversed.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS reverted_by TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS revert_reason TEXT;

-- Down Migration

DROP TABLE IF EXISTS matches;
DROP TABLE IF EXISTS device_logins;
DROP TABLE IF EXISTS oauth_states;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
