-- Player bios: freeform text a player can set about themselves (see the new
-- profile settings panel in the frontend), shown on their profile page
-- (frontend/user.html) and next to their leaderboard row. See
-- src/domain/users.js's updateBio()/toPublic().
--
-- Nullable, no default: distinct from an empty string as "never set one" -
-- lets the frontend render nothing rather than an empty box in that case.
-- Length is capped in the API (see routes/api.js's BIO_MAX_LENGTH), not here -
-- same split as replayUrl's length check in POST /matchmaking/alive.

-- Up Migration

ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;

-- Down Migration

ALTER TABLE users DROP COLUMN IF EXISTS bio;
