-- Glicko-2 replaces the flat +-20 elo. See src/domain/glicko.js and
-- docs/rating.md.
--
-- Ratings keep their column names, their scale and their current values -
-- nothing client-facing changes shape - but they stop being integers, because
-- Glicko-2 produces fractional ratings and rounding after every match would
-- let the error compound. Rounding moves to the edges instead (users.toPublic,
-- matches.toPublic, matchmaking's views, the bot embeds), so the API still
-- reports whole numbers.
--
-- Alongside each rating a player now carries the other two Glicko-2 state
-- variables per gamemode: rd (how sure we are of the rating) and vol (how
-- erratic their results have been), plus when they were last rated so idleness
-- can be charged against rd.
--
-- Existing players keep their rating but start at the default rd, since a flat
-- elo number carries no confidence information to convert. Their first few
-- matches under Glicko-2 will therefore move them further than usual, which is
-- the honest outcome: nothing about the old ratings said how well measured
-- they were. rated_at is backfilled from real match history below so an
-- already-inactive player is not treated as brand new.
--
-- The 200 / 0.06 defaults duplicate config.glickoDefaultRd and
-- glickoDefaultVolatility (200 rather than Glickman's 350 on purpose - see the
-- comment on glickoDefaultRd). Same tradeoff the baseline's starting elo
-- makes: a migration cannot read the app config, and these only apply to rows
-- inserted without an explicit value.

-- Up Migration

ALTER TABLE users ALTER COLUMN elo_coin_runners TYPE DOUBLE PRECISION;
ALTER TABLE users ALTER COLUMN elo_star_chasers TYPE DOUBLE PRECISION;

ALTER TABLE users ADD COLUMN IF NOT EXISTS rd_coin_runners  DOUBLE PRECISION NOT NULL DEFAULT 200;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rd_star_chasers  DOUBLE PRECISION NOT NULL DEFAULT 200;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vol_coin_runners DOUBLE PRECISION NOT NULL DEFAULT 0.06;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vol_star_chasers DOUBLE PRECISION NOT NULL DEFAULT 0.06;

-- Nullable on purpose: NULL means "never rated in this gamemode", which is
-- distinct from "rated a long time ago" and must not be charged idleness.
ALTER TABLE users ADD COLUMN IF NOT EXISTS rated_at_coin_runners TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rated_at_star_chasers TIMESTAMPTZ;

-- matches.gamemode snapshots the human-readable name (see matchmaking.js's
-- finishPlaying), so that is what these match on.
UPDATE users u
   SET rated_at_coin_runners = m.last_played
  FROM (SELECT user_id, MAX(played_at) AS last_played FROM matches
         WHERE gamemode = 'Coin Runners' GROUP BY user_id) m
 WHERE m.user_id = u.discord_id;

UPDATE users u
   SET rated_at_star_chasers = m.last_played
  FROM (SELECT user_id, MAX(played_at) AS last_played FROM matches
         WHERE gamemode = 'Star Chasers' GROUP BY user_id) m
 WHERE m.user_id = u.discord_id;

ALTER TABLE matches ALTER COLUMN elo_delta TYPE DOUBLE PRECISION;

-- What this match did to the player's rd and volatility, so the Discord bot's
-- revert can reverse the whole Glicko-2 update rather than just the rating
-- half. Nullable: rows written before this migration have no such record, and
-- revertMatch() treats a missing pair as "rating only".
ALTER TABLE matches ADD COLUMN IF NOT EXISTS rd_before  DOUBLE PRECISION;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS rd_after   DOUBLE PRECISION;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS vol_before DOUBLE PRECISION;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS vol_after  DOUBLE PRECISION;

-- Down Migration

ALTER TABLE matches DROP COLUMN IF EXISTS vol_after;
ALTER TABLE matches DROP COLUMN IF EXISTS vol_before;
ALTER TABLE matches DROP COLUMN IF EXISTS rd_after;
ALTER TABLE matches DROP COLUMN IF EXISTS rd_before;
ALTER TABLE matches ALTER COLUMN elo_delta TYPE INTEGER USING round(elo_delta)::integer;

ALTER TABLE users DROP COLUMN IF EXISTS rated_at_star_chasers;
ALTER TABLE users DROP COLUMN IF EXISTS rated_at_coin_runners;
ALTER TABLE users DROP COLUMN IF EXISTS vol_star_chasers;
ALTER TABLE users DROP COLUMN IF EXISTS vol_coin_runners;
ALTER TABLE users DROP COLUMN IF EXISTS rd_star_chasers;
ALTER TABLE users DROP COLUMN IF EXISTS rd_coin_runners;

ALTER TABLE users ALTER COLUMN elo_coin_runners TYPE INTEGER USING round(elo_coin_runners)::integer;
ALTER TABLE users ALTER COLUMN elo_star_chasers TYPE INTEGER USING round(elo_star_chasers)::integer;
