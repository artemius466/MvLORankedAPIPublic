const config = require('../config');
const db = require('../db/db');
const matchmaking = require('./matchmaking');

/**
 * Region and map popularity, averaged over a day, a week or a month.
 *
 * There was no history to derive this from - matchmaking.activitySnapshot()
 * only knows about right now, and the matches table only records games that
 * finished, which says nothing about who was around wanting to play. So this
 * samples the live snapshot on an interval and accumulates it.
 *
 * What accumulates is a running total per day, not the samples themselves (see
 * migrations/4_activity.sql): one row per region and per map per day, updated
 * in place. Every window is then a sum over those rows divided by their sample
 * counts. Sampling twice a minute for a year costs the same 78 rows a day as
 * sampling twice an hour.
 *
 * The averages are of *concurrent* players - "how many people were on this
 * region at any given moment, on average" - not a count of distinct players or
 * of matches played. A queued player is counted on every region and map they
 * would accept, so the per-map numbers add up to more than the player count.
 * That is the question worth answering here: what people want to play, not how
 * a fixed population divides up.
 */

const WINDOWS = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

/**
 * Folds one snapshot into today's totals. A single multi-row upsert rather
 * than one statement per bucket - there are ~78 of them and this runs on a
 * timer forever.
 *
 * Zero-valued buckets are written too. An empty region is a real measurement:
 * dropping it would leave that region's average computed over only the samples
 * where somebody happened to be on it, which would rank a region nobody plays
 * alongside one everybody does.
 */
async function sample() {
  const { regions, maps } = await matchmaking.activitySnapshot();
  const buckets = [
    ...regions.map((r) => ['region', String(r.region), r.playing, r.queuing]),
    ...maps.map((m) => ['map', m.mapId, m.playing, m.queuing]),
  ];
  if (!buckets.length) return 0;

  // Four parallel arrays unnested into rows - one round trip, and no
  // hand-built VALUES list with 300-odd placeholders in it.
  await db.query(
    `INSERT INTO activity_daily (day, scope, key, samples, playing_sum, queuing_sum)
     SELECT current_date, scope, key, 1, playing, queuing
       FROM unnest($1::text[], $2::text[], $3::int[], $4::int[]) AS t(scope, key, playing, queuing)
     ON CONFLICT (day, scope, key) DO UPDATE
        SET samples     = activity_daily.samples     + 1,
            playing_sum = activity_daily.playing_sum + EXCLUDED.playing_sum,
            queuing_sum = activity_daily.queuing_sum + EXCLUDED.queuing_sum`,
    [buckets.map((b) => b[0]), buckets.map((b) => b[1]), buckets.map((b) => b[2]), buckets.map((b) => b[3])],
  );

  return buckets.length;
}

function parseWindow(name) {
  return Object.prototype.hasOwnProperty.call(WINDOWS, name) ? name : null;
}

/**
 * Average concurrent players per region and per map over `window`, most
 * popular first.
 *
 * Ranked on playing + queuing together: a region with people waiting on it is
 * popular in exactly the sense being asked about, whether or not those waits
 * turned into matches. Both halves are returned separately as well, since
 * "lots of queuing, little playing" is worth being able to see - it means
 * people want that region and are not getting matched on it.
 *
 * `day > current_date - n` rather than `>=` so `daily` means today only, and
 * `weekly` the last seven days including today.
 */
async function popular(window = 'weekly') {
  const days = WINDOWS[parseWindow(window) || 'weekly'];
  const { rows } = await db.query(
    `SELECT scope, key,
            SUM(playing_sum)::float / SUM(samples) AS playing,
            SUM(queuing_sum)::float / SUM(samples) AS queuing
       FROM activity_daily
      WHERE day > current_date - $1::int AND samples > 0
      GROUP BY scope, key
      ORDER BY (SUM(playing_sum) + SUM(queuing_sum))::float / SUM(samples) DESC, key ASC`,
    [days],
  );

  const shape = (row) => ({
    key: row.key,
    playing: row.playing,
    queuing: row.queuing,
    total: row.playing + row.queuing,
  });

  return {
    window: parseWindow(window) || 'weekly',
    days,
    regions: rows.filter((r) => r.scope === 'region').map(shape),
    maps: rows.filter((r) => r.scope === 'map').map(shape),
  };
}

let timer = null;

// Sampling is the only thing that produces this data, so a period where the
// API is down is simply a period with fewer samples - see the migration for
// why that does not skew the averages.
function start() {
  if (timer || !(config.activitySampleSeconds > 0)) return;

  const run = () => sample().catch((err) => console.error('Activity sample failed:', err));
  run();
  timer = setInterval(run, config.activitySampleSeconds * 1000);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { WINDOWS, parseWindow, sample, popular, start, stop };
