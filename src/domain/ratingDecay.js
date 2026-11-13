const config = require('../config');
const db = require('../db/db');

/**
 * Rating decay for players who stop showing up.
 *
 * Not the same thing as the rating-deviation inflation Glicko-2 already
 * applies to an idle player (see glicko.idle()). That one widens the
 * uncertainty around a rating without judging it - we have not decided they
 * got worse, only that we are less sure. This one actually takes points off,
 * which is a ladder policy rather than anything the math asks for: a position
 * on the ladder is a claim about how you play now, and someone who stopped
 * playing months ago has stopped backing it.
 *
 * There is no floor. Keep not playing and it keeps going, below the starting
 * rating and past it. That is deliberate: a floor would mean an abandoned
 * account permanently occupying a rung, which is the thing decay exists to
 * prevent.
 *
 * Rate and threshold are config.ratingDecayPerDay / ratingDecayIdleDays;
 * setting the rate to 0 disables the whole thing.
 */

// Smallest amount worth charging, in rating points. Without a floor, any two
// sweeps close together - two process restarts in a minute, say - would each
// charge a sliver of a point and each write an audit row for it, burying the
// real entries in noise. Anything under this is simply left unbilled and picked
// up by the next sweep, since decayed_at only advances for players actually
// charged; nothing is forgiven, only deferred.
const MIN_CHARGE = 0.01;

/**
 * One sweep, as a single statement.
 *
 * The whole thing is one CTE so the update and its audit rows cannot come
 * apart: postgres evaluates `charged` once, and both the UPDATE it drives and
 * the INSERT that records it see exactly the same set of players. Doing it as
 * two queries would leave a window where a crash logs a decay that never
 * happened, or applies one nothing records.
 *
 * Idempotence comes from `decayed_at`, which is how far decay has been billed
 * up to. Points owed are counted from whichever is later: the moment the idle
 * threshold was crossed, or the last time they were charged. So running the
 * sweep twice in a row charges nothing the second time, and a sweep missed
 * because the process was down is simply charged in full by the next one -
 * cadence never changes the total.
 *
 * Returns what it did so the caller can log it; callers that only want the
 * side effect can ignore the result.
 */
async function sweep() {
  if (!(config.ratingDecayPerDay > 0)) return { players: 0, points: 0 };

  const { rows } = await db.query(
    `WITH charged AS (
       SELECT discord_id,
              -- Only the idleness not already billed. GREATEST picks up
              -- decayed_at once it exists, and the threshold crossing before
              -- that (decayed_at is NULL until the first charge).
              EXTRACT(EPOCH FROM now() - GREATEST(
                COALESCE(decayed_at, TIMESTAMPTZ '-infinity'),
                rated_at + make_interval(days => $1::int)
              )) / 86400 AS unbilled_days,
              EXTRACT(EPOCH FROM now() - rated_at) / 86400 AS idle_days
         FROM users
        WHERE rated_at IS NOT NULL
          AND rated_at < now() - make_interval(days => $1::int)
     ),
     owed AS (
       SELECT discord_id, unbilled_days * $2::float AS points, idle_days
         FROM charged
        WHERE unbilled_days * $2::float >= $3::float
     ),
     applied AS (
       UPDATE users u
          SET elo = u.elo - owed.points,
              decayed_at = now(),
              updated_at = now()
         FROM owed
        WHERE u.discord_id = owed.discord_id
        RETURNING u.discord_id, owed.points, u.elo AS rating_after, owed.idle_days
     )
     INSERT INTO rating_decay (user_id, points, rating_after, idle_days)
     SELECT discord_id, points, rating_after, idle_days FROM applied
     RETURNING user_id, points`,
    [config.ratingDecayIdleDays, config.ratingDecayPerDay, MIN_CHARGE],
  );

  return { players: rows.length, points: rows.reduce((sum, row) => sum + Number(row.points), 0) };
}

let timer = null;

// Runs once at startup and then on its own interval, same shape as the session
// sweep in server.js. The startup run matters: it is what charges the idleness
// accrued while the process was down.
function start() {
  if (timer || !(config.ratingDecayPerDay > 0)) return;

  const run = () => sweep()
    .then(({ players, points }) => {
      if (players) console.log(`Rating decay: ${players} rating(s) decayed, ${Math.round(points)} points total`);
    })
    .catch((err) => console.error('Rating decay sweep failed:', err));

  run();
  timer = setInterval(run, config.ratingDecaySweepHours * 60 * 60 * 1000);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { sweep, start, stop };
