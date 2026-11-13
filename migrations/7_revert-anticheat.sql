-- Reverts migrations 5_anticheat.sql and 6_anticheat-platform.sql, which
-- shipped the anti-cheat launcher scheme and were then rolled back at the
-- application level (see reverts of commits af8c471 and 33b51ab). The SQL
-- files for 5 and 6 no longer exist on disk, so `db:migrate:down` can't undo
-- them; a forward migration is the doc-recommended way to unwind a change
-- that's already deployed - see docs/migrations.md, "Rolling back".
--
-- Any database that never applied 5/6 (e.g. a fresh clone since the revert)
-- treats this as a no-op thanks to DROP ... IF EXISTS.

-- Up Migration

DROP INDEX IF EXISTS anticheat_config_platform_set_at_idx;
DROP INDEX IF EXISTS anticheat_config_set_at_idx;
DROP TABLE IF EXISTS anticheat_config;

-- Down Migration
--
-- Recreates the table in the shape migration 6 left it in (with the platform
-- column), so a down-then-up round-trip lands back where we started. The
-- historical rows are gone, which the original migrations couldn't have
-- reconstructed either - this is a schema rollback, not a data restore.

CREATE TABLE IF NOT EXISTS anticheat_config (
  id            SERIAL PRIMARY KEY,
  expected_hash TEXT NOT NULL,
  set_by        TEXT NOT NULL,
  set_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  platform      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS anticheat_config_platform_set_at_idx ON anticheat_config (platform, set_at DESC);
