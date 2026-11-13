-- Rating decay for inactive players. See src/domain/ratingDecay.js and
-- docs/rating.md.
--
-- Distinct from the rd inflation Glicko-2 already does for idleness: that only
-- widens the uncertainty around a rating, this actually moves the rating. A
-- ladder position is a claim about how you play now, and someone who stopped
-- playing months ago has stopped backing that claim.
--
-- decayed_at_* is how far decay has been charged up to, which is not the same
-- as rated_at_* (when they last played) and cannot be folded into it: the sweep
-- needs to know both "have they been idle long enough to owe anything" and
-- "how much of that idleness has already been billed". NULL means never
-- charged, which the sweep reads as "start from when the idle threshold was
-- first crossed".

-- Up Migration

ALTER TABLE users ADD COLUMN IF NOT EXISTS decayed_at_coin_runners TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS decayed_at_star_chasers TIMESTAMPTZ;

-- One row per player per sweep that actually took points off them. Decay that
-- happens silently is the kind of thing that produces support questions nobody
-- can answer six weeks later; this is what answers them.
CREATE TABLE IF NOT EXISTS rating_decay (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  gamemode     TEXT NOT NULL,
  points       DOUBLE PRECISION NOT NULL,   -- always positive: how much was taken
  rating_after DOUBLE PRECISION NOT NULL,
  idle_days    DOUBLE PRECISION NOT NULL,   -- how long since their last rated match
  decayed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rating_decay_user_id_decayed_at_idx ON rating_decay (user_id, decayed_at DESC);

-- Down Migration

DROP TABLE IF EXISTS rating_decay;
ALTER TABLE users DROP COLUMN IF EXISTS decayed_at_star_chasers;
ALTER TABLE users DROP COLUMN IF EXISTS decayed_at_coin_runners;
