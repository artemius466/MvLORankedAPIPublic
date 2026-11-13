-- Region and map popularity over time. See src/domain/activity.js and
-- docs/stats.md.
--
-- "Average players on a region this week" needs history, and nothing here had
-- any: matchmaking's region breakdown was an instantaneous snapshot for the
-- Discord embed, and matches.played_at only records games that finished, not
-- who was around wanting to play.
--
-- So the API samples the live snapshot on an interval. It does not store the
-- samples: this table is a running total per day, incremented in place, which
-- is all any of the daily/weekly/monthly averages actually need. That keeps
-- the whole thing at 6 regions + 72 maps = 78 rows per day no matter how often
-- sampling happens, so nothing here ever needs pruning and the windows stay
-- cheap to query.
--
-- Averages are sum / samples. Keeping `samples` per row rather than assuming
-- a fixed interval is what makes the numbers survive a restart, a config
-- change to the sample rate, or a period where the API was simply down: those
-- show up as fewer samples, not as an average dragged towards zero.

-- Up Migration

CREATE TABLE IF NOT EXISTS activity_daily (
  day         DATE   NOT NULL,
  scope       TEXT   NOT NULL,            -- 'region' | 'map'
  key         TEXT   NOT NULL,            -- region number, or the map id
  samples     INTEGER NOT NULL DEFAULT 0,
  playing_sum BIGINT  NOT NULL DEFAULT 0,
  queuing_sum BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, key)
);
CREATE INDEX IF NOT EXISTS activity_daily_day_idx ON activity_daily (day);

-- Down Migration

DROP TABLE IF EXISTS activity_daily;
