const crypto = require('crypto');
const config = require('../config');
const db = require('../db/db');

// Tokens are only ever stored hashed, so a dump of the sessions table cannot be
// replayed against the API.
function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function create(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  await db.query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hash(token), userId, expiresAt],
  );
  return { token, expiresAt };
}

// Returns the joined user row, or null when the token is unknown/expired.
async function resolve(token) {
  if (!token) return null;
  const { rows } = await db.query(
    `UPDATE sessions SET last_seen_at = now()
      WHERE token_hash = $1 AND expires_at > now()
      RETURNING user_id, expires_at`,
    [hash(token)],
  );
  return rows[0] || null;
}

async function destroy(token) {
  if (!token) return;
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)]);
}

// Powers the frontend's profile settings "sessions" panel - every device the
// caller is currently logged in on, not just this request's. token_hash is
// exposed as `id`: it is a one-way digest of the token (see hash() above),
// so handing it back to its own owner cannot be used to reconstruct the
// session token itself. `current` marks whichever row belongs to the token
// this very request authenticated with, so the frontend can label it and
// stop the caller from casually revoking the session they are looking at it
// from.
async function list(userId, currentToken) {
  const { rows } = await db.query(
    `SELECT token_hash, created_at, last_seen_at, expires_at FROM sessions
      WHERE user_id = $1 AND expires_at > now()
      ORDER BY last_seen_at DESC`,
    [userId],
  );
  const currentHash = currentToken ? hash(currentToken) : null;
  return rows.map((row) => ({
    id: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    current: row.token_hash === currentHash,
  }));
}

// Revokes one session by the `id` list() handed out. Scoped to userId so one
// account can never revoke another's session even if it somehow guessed the
// hash - returns false (route reports 404) rather than leaking whether a
// given id belongs to someone else.
async function destroyById(userId, id) {
  if (!id) return false;
  const { rowCount } = await db.query(
    'DELETE FROM sessions WHERE token_hash = $1 AND user_id = $2',
    [id, userId],
  );
  return rowCount > 0;
}

// "Log out everywhere else" - keeps the caller's own current session alive
// so the button doesn't also sign out the tab it was clicked from.
async function destroyOthers(userId, keepToken) {
  const { rowCount } = await db.query(
    'DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2',
    [userId, hash(keepToken)],
  );
  return rowCount;
}

// --- OAuth CSRF nonces -----------------------------------------------------

async function createOAuthState() {
  const state = crypto.randomBytes(24).toString('base64url');
  await db.query(
    "INSERT INTO oauth_states (state, expires_at) VALUES ($1, now() + interval '15 minutes')",
    [state],
  );
  return state;
}

// Single use: consuming a state also deletes it.
async function consumeOAuthState(state) {
  if (!state) return false;
  const { rowCount } = await db.query(
    'DELETE FROM oauth_states WHERE state = $1 AND expires_at > now()',
    [state],
  );
  return rowCount > 0;
}

async function purgeExpired() {
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query('DELETE FROM oauth_states WHERE expires_at < now()');
}

module.exports = {
  create,
  resolve,
  destroy,
  list,
  destroyById,
  destroyOthers,
  createOAuthState,
  consumeOAuthState,
  purgeExpired,
};
