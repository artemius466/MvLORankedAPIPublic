-- Collapses the two independent rating tracks (elo_coin_runners/elo_star_chasers,
-- see migration 2's comment for why they existed) back into one shared rating.
-- Gamemode selection itself is untouched - Star Chasers and Coin Runners are
-- still different games a player picks between when queueing (see
-- src/domain/matchmaking.js's GAMEMODES) - only the idea of a *rating* being
-- divided by gamemode goes away.
--
-- users.elo has sat unused since migration 1 added the two per-gamemode
-- columns (its own comment called it "close to vestigial"); it is repurposed
-- here as that single combined rating rather than adding yet another column.

-- Up Migration

ALTER TABLE users ALTER COLUMN elo TYPE DOUBLE PRECISION;

ALTER TABLE users ADD COLUMN IF NOT EXISTS rd  DOUBLE PRECISION NOT NULL DEFAULT 200;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vol DOUBLE PRECISION NOT NULL DEFAULT 0.06;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rated_at   TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS decayed_at TIMESTAMPTZ;

-- Star Chasers survives as the one track, rather than averaging the two or
-- keeping whichever is higher, so every player lands on a number they have
-- actually held before - it was already the site's main/default gamemode
-- (see frontend/js/modes.js).
UPDATE users SET
  elo        = elo_star_chasers,
  rd         = rd_star_chasers,
  vol        = vol_star_chasers,
  rated_at   = rated_at_star_chasers,
  decayed_at = decayed_at_star_chasers;

ALTER TABLE users DROP COLUMN IF EXISTS elo_coin_runners;
ALTER TABLE users DROP COLUMN IF EXISTS elo_star_chasers;
ALTER TABLE users DROP COLUMN IF EXISTS rd_coin_runners;
ALTER TABLE users DROP COLUMN IF EXISTS rd_star_chasers;
ALTER TABLE users DROP COLUMN IF EXISTS vol_coin_runners;
ALTER TABLE users DROP COLUMN IF EXISTS vol_star_chasers;
ALTER TABLE users DROP COLUMN IF EXISTS rated_at_coin_runners;
ALTER TABLE users DROP COLUMN IF EXISTS rated_at_star_chasers;
ALTER TABLE users DROP COLUMN IF EXISTS decayed_at_coin_runners;
ALTER TABLE users DROP COLUMN IF EXISTS decayed_at_star_chasers;

-- Decay is charged against the one rating now, so a row no longer has a
-- ladder to name.
ALTER TABLE rating_decay DROP COLUMN IF EXISTS gamemode;

-- Down Migration
--
-- Restores the two-track shape, both tracks seeded from the single rating
-- this migration collapsed them into. This is not a true undo: whatever the
-- Coin Runners track actually held before Up ran is gone, and past
-- rating_decay rows carry no record of which original track they were
-- charged against - the recreated gamemode column is backfilled with a
-- placeholder rather than a guess dressed up as real data.

ALTER TABLE rating_decay ADD COLUMN IF NOT EXISTS gamemode TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE rating_decay ALTER COLUMN gamemode DROP DEFAULT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS elo_coin_runners DOUBLE PRECISION NOT NULL DEFAULT 1000;
ALTER TABLE users ADD COLUMN IF NOT EXISTS elo_star_chasers DOUBLE PRECISION NOT NULL DEFAULT 1000;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rd_coin_runners  DOUBLE PRECISION NOT NULL DEFAULT 200;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rd_star_chasers  DOUBLE PRECISION NOT NULL DEFAULT 200;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vol_coin_runners DOUBLE PRECISION NOT NULL DEFAULT 0.06;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vol_star_chasers DOUBLE PRECISION NOT NULL DEFAULT 0.06;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rated_at_coin_runners TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rated_at_star_chasers TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS decayed_at_coin_runners TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS decayed_at_star_chasers TIMESTAMPTZ;

UPDATE users SET
  elo_coin_runners = elo, elo_star_chasers = elo,
  rd_coin_runners = rd, rd_star_chasers = rd,
  vol_coin_runners = vol, vol_star_chasers = vol,
  rated_at_coin_runners = rated_at, rated_at_star_chasers = rated_at,
  decayed_at_coin_runners = decayed_at, decayed_at_star_chasers = decayed_at;

ALTER TABLE users DROP COLUMN IF EXISTS decayed_at;
ALTER TABLE users DROP COLUMN IF EXISTS rated_at;
ALTER TABLE users DROP COLUMN IF EXISTS vol;
ALTER TABLE users DROP COLUMN IF EXISTS rd;
ALTER TABLE users ALTER COLUMN elo TYPE INTEGER USING round(elo)::integer;
