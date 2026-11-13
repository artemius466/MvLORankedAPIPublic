const config = require('../config');
const db = require('../db/db');
const discord = require('../integrations/discord');
const presence = require('./presence');

// A player's full Glicko-2 state, in the shape glicko.js works with. One
// rating shared across every ranked match - matchmaking no longer divides
// players by gamemode at all, see migrations/10_unify-elo.sql and
// migrations/11_drop-match-gamemode.sql.
//
// `rating` is the number the API calls elo; rd and vol are the rest of the
// player's Glicko-2 state (see src/domain/glicko.js); ratedAt is when their
// last rated match landed, and decayedAt how far inactivity decay has been
// charged up to (see ./ratingDecay.js) - deliberately separate, since the
// sweep needs both "idle for how long" and "billed up to when".
function ratingFor(row) {
  return {
    rating: Number(row.elo),
    rd: Number(row.rd),
    vol: Number(row.vol),
    ratedAt: row.rated_at,
  };
}

function getBanStatus(row, now = Date.now()) {
  if (!row || !row.banned_until) return null;
  const bannedUntilMs = new Date(row.banned_until).getTime();
  if (bannedUntilMs <= now) return null;
  const diffMs = bannedUntilMs - now;
  const hoursLeft = Math.ceil(diffMs / (1000 * 60 * 60));
  return {
    isBanned: true,
    reason: row.ban_reason || 'No reason provided',
    bannedUntil: row.banned_until,
    hoursLeft,
  };
}

// Never leak the stored Discord tokens to the browser. `online` is optional -
// callers that don't have a presence lookup handy (e.g. /me) just omit it and
// no `online` field is sent, rather than lying with a hardcoded false.
//
// Ratings are stored as doubles (Glicko-2 produces fractional ones) but have
// always been whole numbers on the wire, so they are rounded here rather than
// in the database. rd and volatility are deliberately not exposed at all -
// they are how the rating is arrived at, not something a player acts on.
function toPublic(row, online) {
  const ban = getBanStatus(row);
  return {
    id: row.discord_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: discord.avatarUrl(row.discord_id, row.avatar_hash),
    bio: row.bio || null,
    country: row.country || null,
    elo: Math.round(row.elo),
    refreshedAt: row.discord_refreshed_at,
    createdAt: row.created_at,
    ...(online !== undefined ? { online } : {}),
    ...(ban ? { ban } : {}),
  };
}

async function findById(discordId) {
  const { rows } = await db.query('SELECT * FROM users WHERE discord_id = $1', [discordId]);
  return rows[0] || null;
}

// Bio is validated (trimmed, length-capped) by the route before this is
// called - see routes/api.js's PUT /me/bio. `bio` may be null to clear it.
async function updateBio(discordId, bio) {
  const { rows } = await db.query(
    'UPDATE users SET bio = $2, updated_at = now() WHERE discord_id = $1 RETURNING *',
    [discordId, bio],
  );
  return rows[0];
}

// `country` is validated against countries.isValid() by the route before
// this is called - see routes/api.js's PUT /me/country. May be null to clear it.
async function updateCountry(discordId, country) {
  const { rows } = await db.query(
    'UPDATE users SET country = $2, updated_at = now() WHERE discord_id = $1 RETURNING *',
    [discordId, country],
  );
  return rows[0];
}

// Top players by rating, plus how many ranked players exist in total so the
// frontend can say "top N of M" (and page through the rest via offset)
// without a second round trip. Banned players are excluded.
async function leaderboard(limit, offset = 0) {
  const [{ rows: top }, { rows: counted }] = await Promise.all([
    db.query(
      `SELECT * FROM users
        WHERE banned_until IS NULL OR banned_until <= now()
        ORDER BY elo DESC, created_at ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    db.query('SELECT COUNT(*)::int AS count FROM users WHERE banned_until IS NULL OR banned_until <= now()'),
  ]);
  const online = await presence.onlineSet(top.map((row) => row.discord_id));
  return { total: counted[0].count, players: top.map((row) => toPublic(row, online.has(String(row.discord_id)))) };
}

// Admin panel listing - every user, ordered by rating. Explicit column select
// because admin.sql can't be trusted to remember not to leak the stored
// Discord tokens the way SELECT * would. `q` narrows to a display name,
// username or discord id substring. Rows carry how many matches line up as
// `user_id` (each real match is one row per perspective) and the timestamp of
// the most recent one, so an admin can spot dead accounts at a glance.
const LIST_ALL_COLUMNS = `
  discord_id, username, display_name, avatar_hash,
  bio, country, elo, rd, vol,
  banned_until, ban_reason, banned_at, banned_by,
  created_at, updated_at, discord_refreshed_at,
  (SELECT COUNT(*) FROM matches m WHERE m.user_id = u.discord_id)::int AS matches_played,
  (SELECT MAX(played_at) FROM matches m WHERE m.user_id = u.discord_id) AS last_match_at`;

// `start` is the placeholder number the search params begin at - $1/$2 in a
// COUNT, $3/$4 when limit/offset already hold $1/$2. pg numbers placeholders
// by their position in the SQL, so both callers must pass a coherent range.
function listAllWhere(query, start) {
  const q = (query || '').trim();
  if (!q) return { sql: '', params: [] };
  const ilike = start;
  const exact = start + 1;
  return {
    sql: ` WHERE display_name ILIKE $${ilike} OR username ILIKE $${ilike} OR discord_id = $${exact}`,
    params: [`%${q}%`, q],
  };
}

async function listAll({ limit, offset = 0, query }) {
  const where = listAllWhere(query, 3);
  const { rows } = await db.query(
    `SELECT ${LIST_ALL_COLUMNS}
       FROM users u${where.sql}
      ORDER BY u.elo DESC, u.created_at ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset, ...where.params],
  );
  return rows.map((row) => ({ ...row, avatar_url: discord.avatarUrl(row.discord_id, row.avatar_hash) }));
}

async function countAll(query) {
  const where = listAllWhere(query, 1);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count FROM users u${where.sql}`,
    where.params,
  );
  return rows[0].count;
}

// First login creates the row (with the starting elo); later logins refresh
// the profile and tokens but must never reset elo.
async function upsertFromDiscord(profile, tokens) {
  const { rows } = await db.query(
    `INSERT INTO users (discord_id, username, display_name, avatar_hash, elo,
                        discord_access_token, discord_refresh_token, discord_token_expires_at,
                        discord_refreshed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (discord_id) DO UPDATE SET
       username                 = EXCLUDED.username,
       display_name             = EXCLUDED.display_name,
       avatar_hash              = EXCLUDED.avatar_hash,
       discord_access_token     = EXCLUDED.discord_access_token,
       discord_refresh_token    = EXCLUDED.discord_refresh_token,
       discord_token_expires_at = EXCLUDED.discord_token_expires_at,
       discord_refreshed_at     = now(),
       updated_at               = now()
     RETURNING *`,
    [
      profile.id,
      profile.username,
      profile.global_name || profile.username,
      profile.avatar,
      config.startingElo,
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt,
    ],
  );
  return rows[0];
}

// Returns a usable access token, rotating it through Discord when it is close
// to expiry. Null when the user has no refresh token left (revoked access).
async function validAccessToken(row) {
  const expiresAt = row.discord_token_expires_at ? new Date(row.discord_token_expires_at).getTime() : 0;
  if (row.discord_access_token && expiresAt > Date.now() + 60_000) {
    return row.discord_access_token;
  }
  if (!row.discord_refresh_token) return null;

  const tokens = await discord.refreshAccessToken(row.discord_refresh_token);
  await db.query(
    `UPDATE users SET discord_access_token = $2, discord_refresh_token = $3,
                      discord_token_expires_at = $4, updated_at = now()
      WHERE discord_id = $1`,
    [row.discord_id, tokens.accessToken, tokens.refreshToken, tokens.expiresAt],
  );
  return tokens.accessToken;
}

/**
 * Re-reads the Discord profile if the cached copy is older than
 * config.profileRefreshMinutes. Returns { user, refreshed, error }.
 *
 * The staleness check and the claim are one atomic UPDATE, so concurrent page
 * loads only produce a single call to Discord. A failed fetch keeps the claim,
 * which doubles as a backoff: we will not hammer Discord for another interval.
 */
async function refreshProfile(row) {
  const claim = await db.query(
    `UPDATE users SET discord_refreshed_at = now()
      WHERE discord_id = $1
        AND discord_refreshed_at < now() - make_interval(mins => $2)
      RETURNING discord_id`,
    [row.discord_id, config.profileRefreshMinutes],
  );
  if (claim.rowCount === 0) return { user: row, refreshed: false };

  try {
    const accessToken = await validAccessToken(row);
    if (!accessToken) {
      return { user: row, refreshed: false, error: 'discord_access_revoked' };
    }
    const profile = await discord.fetchCurrentUser(accessToken);
    const { rows } = await db.query(
      `UPDATE users SET username = $2, display_name = $3, avatar_hash = $4, updated_at = now()
        WHERE discord_id = $1
        RETURNING *`,
      [row.discord_id, profile.username, profile.global_name || profile.username, profile.avatar],
    );
    return { user: rows[0], refreshed: true };
  } catch (err) {
    console.error(`Discord profile refresh failed for ${row.discord_id}:`, err.message);
    return { user: row, refreshed: false, error: 'discord_refresh_failed' };
  }
}

/**
 * Writes the result of a rated match: Glicko-2 hands back the player's whole
 * new state at once (see glicko.update), so unlike the additive path below
 * this sets all three values outright and stamps when it happened.
 *
 * Absolute writes cannot be made race-free the way an increment can, but
 * nothing races them: matchmaking allows a player exactly one ticket, so they
 * can only be settling one match at a time, and the decay sweep skips anyone
 * whose ratedAt is recent.
 */
async function applyRating(discordId, next, at = new Date()) {
  await db.query(
    `UPDATE users SET elo = $2, rd = $3, vol = $4, rated_at = $5, updated_at = now()
      WHERE discord_id = $1`,
    [discordId, next.rating, next.rd, next.vol, at],
  );
}

/**
 * Additive counterpart to applyRating(), used only to undo a match (see
 * matchmaking.revertMatch()). Deltas rather than absolutes precisely because
 * a revert has to compose with whatever the player has done since: subtracting
 * this match's own contribution nets out to undoing it in any order, where
 * restoring a snapshot would silently discard every later match.
 *
 * `rd`/`vol` are optional - rows written before matches recorded them have
 * only a rating delta to give back.
 */
async function applyRatingDelta(discordId, deltas) {
  await db.query(
    `UPDATE users SET elo = elo + $2, rd = rd + $3, vol = vol + $4, updated_at = now()
      WHERE discord_id = $1`,
    [discordId, deltas.rating, deltas.rd || 0, deltas.vol || 0],
  );
}

async function banUser(discordId, { reason, hours, bannedBy }) {
  const safeHours = Math.max(1, Number(hours) || 1);
  const safeReason = (reason || '').trim().slice(0, 500) || null;
  const { rows } = await db.query(
    `UPDATE users
        SET banned_until = now() + make_interval(hours => $2),
            ban_reason   = $3,
            banned_at    = now(),
            banned_by    = $4,
            updated_at   = now()
      WHERE discord_id   = $1
  RETURNING *`,
    [discordId, safeHours, safeReason, bannedBy || null],
  );
  return rows[0] || null;
}

async function unbanUser(discordId) {
  const { rows } = await db.query(
    `UPDATE users
        SET banned_until = NULL,
            ban_reason   = NULL,
            banned_at    = NULL,
            banned_by    = NULL,
            updated_at   = now()
      WHERE discord_id   = $1
  RETURNING *`,
    [discordId],
  );
  return rows[0] || null;
}

module.exports = {
  toPublic,
  getBanStatus,
  banUser,
  unbanUser,
  ratingFor,
  findById,
  updateBio,
  updateCountry,
  leaderboard,
  listAll,
  countAll,
  upsertFromDiscord,
  refreshProfile,
  applyRating,
  applyRatingDelta,
};

