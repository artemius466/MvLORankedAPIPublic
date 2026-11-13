-- Player country flags: an optional self-reported ISO 3166-1 alpha-2 code
-- (e.g. 'JP'), shown as a flag emoji next to a player's name on their
-- profile page and on the leaderboard, same spots as their bio (see
-- migration 8). See src/domain/countries.js for the valid code list and
-- src/domain/users.js's updateCountry()/toPublic().
--
-- Stored as the raw 2-letter code rather than a flag/emoji string so the
-- frontend can derive the emoji (or swap it for a different flag rendering
-- later) rather than persisting a presentation choice. Nullable, no default -
-- distinct from "no country" as a deliberate choice.

-- Up Migration

ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT;

-- Down Migration

ALTER TABLE users DROP COLUMN IF EXISTS country;
