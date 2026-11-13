const db = require('../db/db');

// Long enough to cover a slow Discord login, short enough that an unclaimed
// row does not sit around with a live session token in it.
const HANDOFF_TTL_MINUTES = 5;

// Called from /api/callback once a session has actually been minted.
async function recordSuccess(state, token, userId) {
  if (!state) return;
  await db.query(
    `INSERT INTO device_logins (state, token, user_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))
     ON CONFLICT (state) DO UPDATE SET
       token = EXCLUDED.token, user_id = EXCLUDED.user_id, error = NULL, expires_at = EXCLUDED.expires_at`,
    [state, token, userId, HANDOFF_TTL_MINUTES],
  );
}

// Called from /api/callback for every failure branch, so a polling client
// finds out login failed instead of polling until it gives up on its own.
async function recordError(state, error) {
  if (!state) return;
  await db.query(
    `INSERT INTO device_logins (state, error, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))
     ON CONFLICT (state) DO UPDATE SET error = EXCLUDED.error, expires_at = EXCLUDED.expires_at`,
    [state, error, HANDOFF_TTL_MINUTES],
  );
}

// Polled by the game client. Returns null while still pending (or once the
// row has expired) - the caller cannot tell those two apart, which is fine
// since it is expected to give up client-side after its own timeout.
async function claim(state) {
  if (!state) return null;
  const { rows } = await db.query(
    'DELETE FROM device_logins WHERE state = $1 AND expires_at > now() RETURNING token, user_id, error',
    [state],
  );
  return rows[0] || null;
}

async function purgeExpired() {
  await db.query('DELETE FROM device_logins WHERE expires_at < now()');
}

module.exports = { recordSuccess, recordError, claim, purgeExpired };
