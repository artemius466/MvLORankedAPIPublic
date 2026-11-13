-- Removes gamemode as a concept from matchmaking entirely, not just from
-- rating (migration 10 already unified elo). Queued players are no longer
-- filtered by Star Chasers vs Coin Runners - any two waiting tickets can be
-- paired as long as they share a map - so matches.gamemode has nothing left
-- to snapshot (see src/domain/matchmaking.js/matches.js).

-- Up Migration

ALTER TABLE matches DROP COLUMN IF EXISTS gamemode;

-- Down Migration
--
-- Restores the column so a database can be reopened at this shape, but this
-- is not a real undo: every row's actual gamemode is gone, and nothing here
-- can reconstruct which one a given historical match was.

ALTER TABLE matches ADD COLUMN IF NOT EXISTS gamemode TEXT;
