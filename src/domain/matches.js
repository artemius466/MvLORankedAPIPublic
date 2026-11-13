const db = require('../db/db');

const HISTORY_SIZE = 50;

// Which physical region each stage prefix corresponds to, as shown to players.
// Indexed by the same number STAGES prefixes with, so this and REGION_COUNT
// above have to stay the same length.
const REGION_DISPLAY_NAMES = [
  '🇸🇬 Asia',
  '🇦🇺 Australia',
  '🇨🇦 Canada, East',
  '🇪🇺 Europe',
  '🇭🇰 Hong Kong',
  '🇮🇳 India',
  '🇯🇵 Japan',
  '🇰🇷 South Korea',
  '🇷🇺 Russia',
  '🇧🇷 South America',
  '🇹🇷 Turkey',
  '🇦🇪 United Arab Emirates',
  '🇺🇸 USA, East',
  '🇺🇸 USA, South Central',
  '🇺🇸 USA, West',
  '🇿🇦 South Africa',
];

// Every stage exists once per region, as a region-prefixed variant of the same
// underlying map (e.g. region 3's grass stage is '3defaultgrassstage'). Bump
// this if more regions are added - STAGES below is derived from it, nothing
// else needs to change.
const REGION_COUNT = REGION_DISPLAY_NAMES.length;

// The legal random pool, before the per-region prefix is applied. Display
// names for these live in MAP_DISPLAY_NAMES below.
const BASE_MAPS = [
  // 'defaultgrassstage', 'customjunglestage', 'defaultbricksstage', 'customskymap', 'custombonusmap', 'defaultfortressmap',
  // 'defaultpipesmap', 'customvolcanomap', 'customdesertmap', 'defaulticestage', 'custombeachmap', 'customghosthousemap',
  'defaultgrassstage', 'customjunglestage', 'defaultbricksstage','customdesertmap',
];

// Same stages the ruleset page lists as the legal random pool, expanded across
// every region (region-major order, matching the old hand-written list).
const STAGES = Array.from({ length: REGION_COUNT }, (_, region) =>
  BASE_MAPS.map((base) => `${region}${base}`)
).flat();

// Human-readable name for each base map, keyed by the same id BASE_MAPS uses
// (i.e. with the region prefix already stripped). Used anywhere a stage id
// needs to be shown to a player - match history, map pickers, etc.
const MAP_DISPLAY_NAMES = {
  defaultgrassstage: 'Grassland',
  customjunglestage: 'Jungle',
  defaultbricksstage: 'Brick',
  customskymap: 'Sky',
  custombonusmap: 'Bonus',
  defaultfortressmap: 'Fortress',
  defaultpipesmap: 'Pipes',
  customvolcanomap: 'Volcano',
  customdesertmap: 'Desert',
  defaulticestage: 'Ice',
  custombeachmap: 'Beach',
  customghosthousemap: 'Ghost House',
};

// Strips the region prefix off a stage id, e.g. '3customskymap' ->
// 'customskymap', which is the form BASE_MAPS and MAP_DISPLAY_NAMES are keyed
// by. Already-stripped ids pass through unchanged, so this is safe to apply
// twice.
function baseMapOfStage(stageId) {
  return String(stageId).replace(/^\d+/, '');
}

// Maps a stage id to its display name, e.g. '3customskymap' -> 'Sky'. Takes
// either form thanks to baseMapOfStage() above. Falls back to the raw id for
// anything unmapped rather than throwing, since this only ever feeds display
// strings.
function displayNameForStage(stageId) {
  return MAP_DISPLAY_NAMES[baseMapOfStage(stageId)] || stageId;
}

// Same contract as displayNameForStage() for a region index, which may arrive
// as a number or as the string an activity_daily key holds.
function displayNameForRegion(region) {
  return REGION_DISPLAY_NAMES[Number(region)] || `Region ${region}`;
}

// eloDelta is stored as a double (Glicko-2 produces fractional rating changes)
// but has always been a whole number on the wire, so it is rounded here rather
// than in the database - see migrations/2_glicko.sql. The rd/vol columns are
// not exposed at all; they exist only so a revert can reverse the whole
// update.
function toPublic(row) {
  return {
    id: row.id,
    matchUid: row.match_uid,
    opponentId: row.opponent_id,
    opponentName: row.opponent_name,
    stage: row.stage,
    eloDelta: Math.round(row.elo_delta),
    replayUrl: row.replay_url,
    playedAt: row.played_at,
  };
}

async function listForUser(userId, limit = HISTORY_SIZE) {
  const { rows } = await db.query(
    `SELECT id, match_uid, opponent_id, opponent_name, stage, elo_delta, replay_url, played_at
       FROM matches WHERE user_id = $1
       ORDER BY played_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map(toPublic);
}

// One row from `userId`'s point of view - a settled match calls this once
// per player, each with its own sign on eloDelta. matchUid correlates the two
// rows written for the same real match (see getByMatchUid/toDetail below);
// replayUrl is optional - a player who reported a result without attaching a
// replay simply has none on their row.
//
// `rating` is the player's whole Glicko-2 state either side of this match
// ({ rdBefore, rdAfter, volBefore, volAfter }), kept so revertMatch() can undo
// the confidence and volatility change too, not just the rating. Optional, for
// the same reason the columns are nullable: rows predating Glicko-2 have none.
async function record({
  userId, opponentId, opponentName, matchUid, stage, eloDelta, replayUrl, rating = {},
}) {
  await db.query(
    `INSERT INTO matches (user_id, opponent_id, opponent_name, match_uid, stage, elo_delta, replay_url,
                          rd_before, rd_after, vol_before, vol_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      userId, opponentId, opponentName, matchUid, stage, eloDelta, replayUrl || null,
      rating.rdBefore ?? null, rating.rdAfter ?? null, rating.volBefore ?? null, rating.volAfter ?? null,
    ],
  );
}

// Both rows recorded for the same real match (see record()'s matchUid), one
// per player's perspective. Used to build the "detailed match" view a click
// on a history row opens.
async function getByMatchUid(matchUid) {
  const { rows } = await db.query(
    `SELECT id, user_id, match_uid, opponent_id, opponent_name, stage, elo_delta, replay_url, played_at,
            reverted_at, reverted_by, revert_reason, rd_before, rd_after, vol_before, vol_after
       FROM matches WHERE match_uid = $1
       ORDER BY id ASC`,
    [matchUid],
  );
  return rows;
}

// Atomically flags both of a match's rows as reverted - a no-op (returns
// false) if it was already reverted, so a caller can tell "just reverted it"
// from "someone beat me to it" without a separate read-then-write race.
async function markReverted(matchUid, revertedBy, reason) {
  const { rowCount } = await db.query(
    `UPDATE matches SET reverted_at = now(), reverted_by = $2, revert_reason = $3
       WHERE match_uid = $1 AND reverted_at IS NULL`,
    [matchUid, revertedBy, reason || null],
  );
  return rowCount > 0;
}

// Admin panel listing of every match, newest first. Each real match is two
// rows (one per player perspective) sharing a matchUid, so this pages through
// distinct matchUids and reassembles each into one detail object via
// toDetail(). `q` narrows to a matchUid substring or to matches involving a
// given player name or discord id (either side). Rows with no matchUid (pre-
// matchmaking history) surface as their own pseudo-match, but cannot be
// reverted - revertMatch() keys off matchUid.
// `start` is the placeholder number the search params begin at - $1/$2 in a
// COUNT, $3/$4 when limit/offset already hold $1/$2 (pg numbers placeholders
// by position, so both callers must pass a coherent range). Rows without a
// matchUid are pre-matchmaking history with nothing to revert; they are
// excluded here so the COUNT and the list always agree.
function listAllWhere(alias, query, start) {
  const q = (query || '').trim();
  if (!q) return { sql: ` WHERE ${alias}.match_uid IS NOT NULL`, params: [] };
  const ilike = start;
  const exact = start + 1;
  return {
    sql: ` WHERE ${alias}.match_uid IS NOT NULL AND (${alias}.match_uid ILIKE $${ilike} OR ${alias}.user_id = $${exact} OR ${alias}.opponent_name ILIKE $${ilike} OR ${alias}.opponent_id = $${exact})`,
    params: [`%${q}%`, q],
  };
}

async function listAll({ limit, offset = 0, query }) {
  const where = listAllWhere('m', query, 3);
  const { rows } = await db.query(
    `SELECT m.match_uid
       FROM matches m${where.sql}
      GROUP BY m.match_uid
      ORDER BY MAX(m.played_at) DESC, MAX(m.id) DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, ...where.params],
  );
  const uids = rows.map((row) => row.match_uid).filter(Boolean);
  if (!uids.length) return [];
  const { rows: detailRows } = await db.query(
    `SELECT id, user_id, match_uid, opponent_id, opponent_name, stage, elo_delta, replay_url, played_at,
            reverted_at, reverted_by, revert_reason, rd_before, rd_after, vol_before, vol_after
       FROM matches WHERE match_uid = ANY($1)
      ORDER BY id ASC`,
    [uids],
  );
  return uids.map((uid) => toDetail(detailRows.filter((row) => row.match_uid === uid)));
}

async function countAll(query) {
  const where = listAllWhere('m', query, 1);
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT m.match_uid)::int AS count FROM matches m${where.sql}`,
    where.params,
  );
  return rows[0].count;
}

// Combines the two per-perspective rows getByMatchUid() returns into one
// object describing the whole match. Each row only knows the *opponent's*
// name from its own perspective (see the matches table comment), so row B's
// opponent_name is where row A's own display name comes from, and vice
// versa - no separate "own name" column needed.
function toDetail(rows) {
  if (!rows.length) return null;
  const [first] = rows;
  const other = (row) => rows.find((r) => r !== row) || null;

  return {
    matchUid: first.match_uid,
    stage: first.stage,
    playedAt: first.played_at,
    // Both rows are flagged together by markReverted() below, so either
    // row's copy of these three is authoritative.
    revertedAt: first.reverted_at,
    revertedBy: first.reverted_by,
    revertReason: first.revert_reason,
    players: rows.map((row) => {
      const opponentRow = other(row);
      return {
        id: row.user_id,
        // Only knowable via the other row's opponent_name (see the matches
        // table comment) - null in the rare case that row has not landed yet.
        name: opponentRow ? opponentRow.opponent_name : null,
        eloDelta: Math.round(row.elo_delta),
        replayUrl: row.replay_url,
      };
    }),
  };
}

function toUint8Array(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return new Uint8Array(source);
}

function parseReplayMetadata(source) {
  const bytes = toUint8Array(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const readBytes = (length) => {
    requireBytes(length);
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const requireBytes = (length) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) {
      throw new Error("Replay is truncated or contains an invalid length.");
    }
  };
  const u8 = () => { requireBytes(1); return bytes[offset++]; };
  const i8 = () => { requireBytes(1); return view.getInt8(offset++); };
  const i32 = () => { requireBytes(4); const value = view.getInt32(offset, true); offset += 4; return value; };
  const i64 = () => { requireBytes(8); const value = view.getBigInt64(offset, true); offset += 8; return value; };
  const text = new TextDecoder("utf-8", { fatal: true });
  const readString = () => text.decode(readBytes(read7BitEncodedInt()));
  const read7BitEncodedInt = () => {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const value = u8();
      result |= (value & 0x7f) << shift;
      if ((value & 0x80) === 0) return result >>> 0;
    }
    throw new Error("Invalid .NET string length.");
  };
  const atLeast = (actual, expected) => actual[0] > expected[0]
    || (actual[0] === expected[0] && (actual[1] > expected[1]
      || (actual[1] === expected[1] && (actual[2] > expected[2]
        || (actual[2] === expected[2] && actual[3] >= expected[3])))));

  if (text.decode(readBytes(7)) !== "MvLO-RP") throw new Error("Not an MvLO replay file.");

  const versionParts = [u8(), u8(), u8(), u8()];
  const unixTimestamp = i64();
  const initialFrame = i32();
  const replayLengthInFrames = i32();
  const customName = readString();
  const rulesJson = readString();
  let rules;
  try { rules = JSON.parse(rulesJson); } catch { rules = null; }

  const players = [];
  for (let index = 0, count = u8(); index < count; index++) {
    const nickname = readString();
    const finalObjectiveCount = i32();
    const team = u8();
    // Keeping Int64 values as strings avoids JavaScript precision loss.
    const characterAssetId = atLeast(versionParts, [2, 0, 5, 0]) ? i64().toString() : u8();
    const playerRef = i32();
    players.push({ nickname, finalObjectiveCount, team, characterAssetId, playerRef });
  }
  const winningTeam = i8();

  if (atLeast(versionParts, [2, 1, 0, 0])) {
    const addonCount = i32();
    for (let index = 0; index < addonCount; index++) readBytes(16);
  }

  const payloadLengths = [i32(), i32(), i32(), i32()];
  const payloadStart = offset;
  for (const length of payloadLengths) readBytes(length);

  let winnerSide = null;
  if (bytes.length - offset >= 5 && text.decode(bytes.subarray(offset, offset + 4)) === "MVLR") {
    const hostWon = bytes[offset + 4];
    if (hostWon === 0 || hostWon === 1) winnerSide = hostWon ? "host" : "client";
  }

  return {
    version: versionParts.join("."),
    unixTimestamp: unixTimestamp.toString(),
    date: new Date(Number(unixTimestamp) * 1000).toISOString(),
    initialFrame,
    replayLengthInFrames,
    customName,
    rules,
    players,
    winningTeam: winningTeam < 0 ? null : winningTeam,
    winner: winnerSide === null ? null : { side: winnerSide, hostWon: winnerSide === "host" },
    hasHostClientResult: winnerSide !== null,
    payloadOffset: payloadStart,
  };
}

module.exports = {
  HISTORY_SIZE,
  REGION_COUNT,
  BASE_MAPS,
  STAGES,
  MAP_DISPLAY_NAMES,
  REGION_DISPLAY_NAMES,
  baseMapOfStage,
  displayNameForStage,
  displayNameForRegion,
  parseReplayMetadata,
  toPublic,
  listForUser,
  listAll,
  countAll,
  record,
  getByMatchUid,
  markReverted,
  toDetail,
};
