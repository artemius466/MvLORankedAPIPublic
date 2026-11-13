const crypto = require('crypto');
const config = require('../config');
const discord = require('../integrations/discord');
const glicko = require('./glicko');
const matches = require('./matches');
const users = require('./users');
const redis = require('../db/redis');

/**
 * Redis-backed matchmaking. Queue tickets, pending matches and match outcomes
 * all live in redis (see src/db/redis.js) under the `mm:` prefix, so a
 * restart - or a second API process - shares the same queue instead of
 * starting from empty. A match is still never written to postgres: it only
 * exists here until both players are ready and the host has handed a Photon
 * room code to the other side. Persisting real matches comes later.
 *
 * Everything below is now async and can interleave with any other call -
 * there is no single event-loop turn protecting a read-modify-write the way
 * there was when this was a plain Map. Two races actually matter in
 * practice (a same user firing two mutating requests at once is not one of
 * them - the client is a sequential state machine, never two):
 *
 *   1. Two players accepting the same match at once - the common case, not
 *      an edge case. `responses` therefore lives in its own redis hash (see
 *      setResponse()) so each acceptance is a single atomic HSET: neither
 *      side's "yes" can be lost to a read-modify-write on a shared blob.
 *      Promoting the match to "ready" only flips state/expiresAt - it never
 *      recomputes anything data-dependent (host included; see
 *      promoteToReady()) - so if both sides' requests both end up doing it
 *      (see respond()), the second write is redundant but not wrong.
 *
 *   2. Two ticks running at once - the 1s background interval racing a poll,
 *      or two API processes each running their own interval - both trying
 *      to pair the same tickets. tick() is wrapped in a short redis lock
 *      (SET NX PX + a compare-and-delete release script) so only one pass of
 *      expire*()/formMatches() ever runs at a time. A caller that loses the
 *      race just skips that pass - the timer and every poll grab it
 *      constantly, so nothing waits long for the next one.
 *
 * Tickets and matches also carry a generous "safety net" TTL in redis on top
 * of their own expire*() sweeps below, pinned to the same lastSeenAt/
 * expiresAt fields the sweeps use, so a crashed process can never strand a
 * key in redis forever. Outcomes skip the sweep entirely and just use a
 * plain redis TTL (config.mmOutcomeTtlSeconds) - there is no equivalent of
 * an expireOutcomes() pass anymore.
 *
 * "ready" is still just a room-code handoff. Once *both* players have called
 * /matchmaking/alive at least once - proving the room exists and both sides
 * actually got there - the match becomes "playing", the one state where
 * matches.js/users.js get touched, since
 * this is the point a match can actually finish for real:
 *
 *   - independent self-reported results (see setResult()) settle the match
 *     and apply a Glicko-2 rating update (see ./glicko.js) the moment both
 *     sides agree on who won;
 *   - going quiet on /alive for config.mmAliveStaleSeconds forfeits to
 *     whoever is still sending it (also elo-affecting - see
 *     expirePlayingMatches());
 *   - disagreeing self-reports, or hitting the non-refreshable
 *     config.mmMatchMaxSeconds ceiling from the moment play started, end the
 *     match with no elo for either side.
 *
 * Only the first two write a matches.js row; a disputed/timed-out match
 * leaves no history, same as it never having reached "playing" at all.
 *
 * Whichever of the above `finishPlaying()` would otherwise apply, a missing
 * replay still overrides it: if only one side ever called /alive with a
 * `replayUrl`, they win outright, win or lose or dispute or timeout
 * notwithstanding - a real result with no proof behind it does not stand
 * next to one that has it. See finishPlaying() itself for the detail.
 */

// One source of truth for the legal map pool: the same base maps the ruleset
// page and the seeded match history draw on, keyed by their bare (region-less)
// id. Nobody picks from this at queue time anymore - every pair is
// compatible on maps by construction, and the actual map is decided by a
// CS2-style veto once the match is ready (see the map veto section further
// down). Which region a match lands on is still decided per-pair from ping,
// not selected up front - see pickRegion() below.
const MAPS = matches.BASE_MAPS.map((id) => ({
  id,
  name: matches.MAP_DISPLAY_NAMES[id] || id,
}));

// Every region a player can be matched into, in the same order/index
// matches.REGION_COUNT and REGION_DISPLAY_NAMES use - that index is what a
// ticket's `pings` array is keyed by.
const REGIONS = matches.REGION_DISPLAY_NAMES.map((name, id) => ({ id, name }));

const MAP_BY_ID = new Map(MAPS.map((m) => [m.id, m]));
const REGION_BY_ID = new Map(REGIONS.map((r) => [r.id, r]));

// A missing or invalid ping reading for a region is treated as the worst
// possible connection - it should never make a region look falsely viable,
// only a player's own maxPing can do that (by being just as high).
const MAX_PING_MS = 5000;
// Being re-paired with the player who just declined you reads as a bug, so the
// two sit out a cooldown before they can meet again.
const REMATCH_COOLDOWN_MS = 60_000;

/**
 * A ticket's Glicko-2 state, in the shape src/domain/glicko.js works with -
 * just the ticket's own snapshot of the player's one rating (see users.js's
 * ratingFor()).
 *
 * Defaults cover tickets written into redis before Glicko-2 landed, which
 * carry an elo and nothing else.
 */
function ticketRating(ticket) {
  return {
    rating: ticket.elo,
    rd: ticket.rd ?? config.glickoDefaultRd,
    vol: ticket.vol ?? config.glickoDefaultVolatility,
    ratedAt: ticket.ratedAt ?? null,
  };
}

let timer = null;

// --- redis storage -----------------------------------------------------

const KEY_PREFIX = 'mm:';
const TICKETS_INDEX = `${KEY_PREFIX}tickets`;
const MATCHES_INDEX = `${KEY_PREFIX}matches`;
const TICK_LOCK_KEY = `${KEY_PREFIX}lock:tick`;
const TICK_LOCK_TTL_MS = 5000;

const ticketKey = (userId) => `${KEY_PREFIX}ticket:${userId}`;
const matchKey = (matchId) => `${KEY_PREFIX}match:${matchId}`;
const responsesKey = (matchId) => `${KEY_PREFIX}match:${matchId}:responses`;
// Each player's independent "who won" self-report while playing. Separate
// hash for the same reason `responses` is: two results arriving at once must
// never lose one to a read-modify-write.
const resultsKey = (matchId) => `${KEY_PREFIX}match:${matchId}:results`;
// Each player's own replay upload URL, keyed the same way as `results` and
// for the same reason - written by alive() alongside a result, read back by
// finishPlaying() when it writes the matches.js history rows.
const replaysKey = (matchId) => `${KEY_PREFIX}match:${matchId}:replays`;
const outcomeKey = (userId) => `${KEY_PREFIX}outcome:${userId}`;

// Safety-net TTL on top of expireTickets()/expirePlayingMatches() below,
// refreshed on every write. Takes the looser of the two staleness windows
// that can apply to a ticket (queue/ready vs. actually playing) so that
// however an operator tunes them relative to each other, this never fires
// before the real staleness check gets a chance to - only a crashed process
// should ever hit it.
const TICKET_TTL_MS = (Math.max(config.mmTicketStaleSeconds, config.mmAliveStaleSeconds) + 30) * 1000;
// Same idea for matches: keeps the key (and its responses hash) alive a
// little past whatever expiresAt the match currently carries.
const MATCH_TTL_BUFFER_MS = 30_000;

async function saveTicket(ticket) {
  const key = ticketKey(ticket.userId);
  await redis.client.multi()
    .set(key, JSON.stringify(ticket))
    .pExpireAt(key, ticket.lastSeenAt + TICKET_TTL_MS)
    .sAdd(TICKETS_INDEX, ticket.userId)
    .exec();
}

async function loadTicket(userId) {
  const raw = await redis.client.get(ticketKey(userId));
  return raw ? JSON.parse(raw) : null;
}

async function deleteTicket(userId) {
  await redis.client.multi()
    .del(ticketKey(userId))
    .sRem(TICKETS_INDEX, userId)
    .exec();
}

async function loadAllTickets() {
  const userIds = await redis.client.sMembers(TICKETS_INDEX);
  if (!userIds.length) return [];

  const raw = await redis.client.mGet(userIds.map(ticketKey));
  const tickets = [];
  const dangling = [];
  raw.forEach((value, i) => (value ? tickets.push(JSON.parse(value)) : dangling.push(userIds[i])));
  // The index and the keys themselves can only drift apart if a key was
  // reaped by its safety-net TTL - prune it here rather than re-discovering
  // the same hole on every future tick.
  if (dangling.length) await redis.client.sRem(TICKETS_INDEX, dangling);
  return tickets;
}

async function saveMatch(match) {
  const key = matchKey(match.id);
  const ttlAt = match.expiresAt + MATCH_TTL_BUFFER_MS;
  await redis.client.multi()
    .set(key, JSON.stringify(match))
    .pExpireAt(key, ttlAt)
    .pExpireAt(responsesKey(match.id), ttlAt)
    .pExpireAt(resultsKey(match.id), ttlAt)
    .pExpireAt(replaysKey(match.id), ttlAt)
    .sAdd(MATCHES_INDEX, match.id)
    .exec();
}

async function loadMatch(matchId) {
  const raw = await redis.client.get(matchKey(matchId));
  return raw ? JSON.parse(raw) : null;
}

async function deleteMatch(matchId) {
  await redis.client.multi()
    .del(matchKey(matchId))
    .del(responsesKey(matchId))
    .del(resultsKey(matchId))
    .del(replaysKey(matchId))
    .sRem(MATCHES_INDEX, matchId)
    .exec();
}

// A "check it still exists, then delete it" done as two separate round trips
// has a gap two concurrent teardowns can both slip through (e.g. a player's
// own agreed result and the disconnect sweep resolving the same match at
// the same instant). That is harmless for endMatch() - both outcomes it
// could ever race with are elo-free, so a double-teardown is at worst a
// wrong-but-plausible reason string - but not for finishPlaying(), where it
// would double-apply elo and double-write history. One atomic script closes
// the gap for both: exactly one caller ever gets `true` back.
const CLAIM_MATCH_SCRIPT = `
if redis.call('exists', KEYS[1]) == 1 then
  redis.call('del', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
  redis.call('srem', KEYS[5], ARGV[1])
  return 1
else
  return 0
end
`;

async function claimMatch(matchId) {
  const claimed = await redis.client.eval(CLAIM_MATCH_SCRIPT, {
    keys: [matchKey(matchId), responsesKey(matchId), resultsKey(matchId), replaysKey(matchId), MATCHES_INDEX],
    arguments: [matchId],
  });
  return claimed === 1;
}

async function loadAllMatches() {
  const matchIds = await redis.client.sMembers(MATCHES_INDEX);
  if (!matchIds.length) return [];

  const raw = await redis.client.mGet(matchIds.map(matchKey));
  const activeMatches = [];
  const dangling = [];
  raw.forEach((value, i) => (value ? activeMatches.push(JSON.parse(value)) : dangling.push(matchIds[i])));
  if (dangling.length) await redis.client.sRem(MATCHES_INDEX, dangling);
  return activeMatches;
}

// Null if either ticket is already gone. A ticket only ever disappears
// together with its match (endMatch() below always deletes both), so this
// doubles as "has a concurrent caller already torn this match down" -
// callers must treat it exactly like the match itself being missing rather
// than assume both players are always there once `match` has been loaded.
async function loadPlayers(match) {
  const [a, b] = await Promise.all(match.playerIds.map(loadTicket));
  return a && b ? [a, b] : null;
}

function getResponses(matchId) {
  return redis.client.hGetAll(responsesKey(matchId));
}

// Atomic: this is the one write two different players' requests genuinely
// race on (both hitting accept around the same moment), so it cannot be a
// read-modify-write of a `responses` field embedded in the match blob - that
// shape could silently lose whichever side's HSET-equivalent lost the race.
async function setResponse(matchId, userId, value) {
  await redis.client.hSet(responsesKey(matchId), userId, value);
}

function getResults(matchId) {
  return redis.client.hGetAll(resultsKey(matchId));
}

// Own explicit TTL (mirrors the responses hash at match creation, see
// createMatch()) rather than relying on the next saveMatch() to land after
// this HSET first creates the key.
async function setResult(match, userId, value) {
  const key = resultsKey(match.id);
  const ttlAt = match.hardExpiresAt + MATCH_TTL_BUFFER_MS;
  await redis.client.multi().hSet(key, userId, value).pExpireAt(key, ttlAt).exec();
}

function getReplays(matchId) {
  return redis.client.hGetAll(replaysKey(matchId));
}

// Mirrors setResult() - own explicit TTL for the same reason. Only ever
// called alongside a result (see alive() below), never on its own.
async function setReplay(match, userId, url) {
  const key = replaysKey(match.id);
  const ttlAt = match.hardExpiresAt + MATCH_TTL_BUFFER_MS;
  await redis.client.multi().hSet(key, userId, url).pExpireAt(key, ttlAt).exec();
}

async function saveOutcome(userId, outcome) {
  await redis.client.set(outcomeKey(userId), JSON.stringify(outcome), {
    expiration: { type: 'EX', value: config.mmOutcomeTtlSeconds },
  });
}

async function loadOutcome(userId) {
  const raw = await redis.client.get(outcomeKey(userId));
  return raw ? JSON.parse(raw) : null;
}

async function deleteOutcome(userId) {
  await redis.client.del(outcomeKey(userId));
}

// Drains the one-shot record of how a player's last match ended.
async function takeOutcome(userId) {
  const outcome = await loadOutcome(userId);
  if (!outcome) return null;
  await deleteOutcome(userId);
  return { matchId: outcome.matchId, reason: outcome.reason, requeued: outcome.requeued };
}

// Lua so the check-and-delete is one atomic step: releasing with a plain DEL
// could delete a lock a *different* holder acquired after ours expired.
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

// Runs fn() only if no other tick is currently in flight, anywhere. Silently
// skips fn() otherwise - ticks are frequent and idempotent, so losing an
// occasional one to a concurrent caller is invisible to clients.
async function withTickLock(fn) {
  const token = crypto.randomBytes(9).toString('base64url');
  const acquired = await redis.client.set(TICK_LOCK_KEY, token, {
    condition: 'NX',
    expiration: { type: 'PX', value: TICK_LOCK_TTL_MS },
  });
  if (!acquired) return;

  try {
    await fn();
  } finally {
    await redis.client.eval(RELEASE_LOCK_SCRIPT, { keys: [TICK_LOCK_KEY], arguments: [token] });
  }
}

// --- helpers ---------------------------------------------------------------

function clampPing(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return MAX_PING_MS;
  return Math.min(Math.round(n), MAX_PING_MS);
}

// A ticket's per-region ping readings, keyed by region index (0..REGION_COUNT-1)
// the same way REGIONS/matches.REGION_COUNT does. `raw` is an array positional
// by region, same shape on the wire in both directions - see queue/poll below.
// A region the caller left out clamps to MAX_PING_MS via clampPing() itself,
// same as an omitted single `ping` used to.
function parsePings(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const pings = {};
  for (let region = 0; region < matches.REGION_COUNT; region++) {
    pings[region] = clampPing(arr[region]);
  }
  return pings;
}

function pingsArray(pings) {
  return Array.from({ length: matches.REGION_COUNT }, (_, region) => pings[region]);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function opponentOf(players, userId) {
  return players.find((p) => p.userId !== userId);
}

/**
 * The options a client may set before queuing. Always succeeds - pings/
 * maxPing are clamped rather than rejected (see clampPing()), and maps are no
 * longer picked at queue time at all (see the map veto section further down)
 * - so unlike before, there is nothing here a caller can get wrong.
 */
function parseOptions(body = {}) {
  return {
    // One ping reading per region (see parsePings()) plus the worst ping this
    // player will accept - together these decide which regions this ticket
    // can be paired onto, never a region picked up front. Omitting maxPing
    // defaults to MAX_PING_MS, i.e. "any region is fine".
    pings: parsePings(body.pings),
    maxPing: clampPing(body.maxPing),
    version: body.version,
  };
}

// --- elo band --------------------------------------------------------------

/**
 * Rule 1 + 2: the standard band for the first minute, then one extra step for
 * every further whole minute spent waiting, capped by mmMaxEloRange.
 */
function eloRange(ticket, now) {
  const steps = Math.floor((now - ticket.queuedAt) / (config.mmExpansionIntervalSeconds * 1000));
  const range = config.mmBaseEloRange + Math.max(0, steps) * config.mmEloExpansionStep;
  return config.mmMaxEloRange > 0 ? Math.min(range, config.mmMaxEloRange) : range;
}

/**
 * Rule 2's compensation, as reported to the client. This used to invent its
 * own multipliers from how far past the standard band the pairing sat; now it
 * reports what Glicko-2 is actually going to do (see glicko.project()) in the
 * same shape, so the wire format - and the client's "win big / lose little"
 * line - is unchanged.
 *
 * The compensation itself is no longer something this file arranges: rating a
 * win over a much stronger opponent higher than a win over a peer is what
 * Glicko-2 does natively, so layering a hand-rolled multiplier on top would
 * count the rating gap twice. What survives is the reporting.
 *
 * The multipliers are relative to *this match's own* average swing, not to any
 * fixed number of points, and that is deliberate. How far a Glicko-2 result
 * moves you depends as much on how well established the two ratings are as on
 * the gap between them - an unplaced player's first match moves them several
 * times further than a veteran's hundredth, with no asymmetry involved at all.
 * Dividing that out leaves exactly what this field is for and what it has
 * always meant: 1 and 1 for an even match, tilted when one side is carrying
 * the risk. It also keeps the pair self-consistent, since the two multipliers
 * now always average 1.
 *
 * Exact, not an estimate: neither player can play anything else between the
 * match locking in and settling, so these are the numbers that will land.
 * Shown to both clients from the moment the match is locked in - never during
 * the accept prompt itself, since the multipliers invert straight back to the
 * opponent's rating (see matchView()).
 */
function eloStake(self, opponent, now) {
  const { winDelta, lossDelta } = glicko.project(self, opponent, now);
  const loss = Math.abs(lossDelta);
  const reference = (winDelta + loss) / 2;
  if (reference <= 0) return { winMultiplier: 1, lossMultiplier: 1, favoured: false };

  const winMultiplier = round2(winDelta / reference);
  const lossMultiplier = round2(loss / reference);
  return {
    winMultiplier,
    lossMultiplier,
    // Compared after rounding so this can never contradict the two numbers
    // shown beside it - an even match differs in the fifteenth decimal place,
    // which is not something to call anyone the underdog over.
    favoured: winMultiplier > lossMultiplier,
  };
}

// --- public views ----------------------------------------------------------

// Ratings are fractional internally (Glicko-2) but whole numbers on the wire,
// same as everywhere else the API reports one - see users.toPublic(). `ping`
// is this player's reading for the region the match actually landed on, not
// their best or latest overall - the only one that means anything once the
// region is already fixed.
function playerView(ticket, region) {
  return {
    id: ticket.userId,
    username: ticket.username,
    displayName: ticket.displayName,
    avatarUrl: discord.avatarUrl(ticket.userId, ticket.avatarHash),
    elo: Math.round(ticket.elo),
    ping: ticket.pings[region],
  };
}

/**
 * Rule 7: everything the client needs to render the "opponent found" screen -
 * except, while the match is still `pending`, anything at all about the
 * opponent. The accept prompt is the one moment knowing who (or how highly
 * rated) they are could change a player's answer, so both sides decide on the
 * match itself - map, clock - and nothing else. That deliberately
 * includes the elo-derived fields, not just the name and avatar: eloDifference
 * is the opponent's rating outright once you know your own, and eloStake's
 * multipliers invert back to the same number (see eloStake()), so leaving
 * either in would hand back exactly what `opponent` was withheld to hide.
 *
 * Everything held back appears the moment both sides have accepted and the
 * match can no longer be dodged - `ready` onwards, i.e. every state the match
 * poll reports other than "waiting".
 */
function matchView(match, players, userId, now) {
  const view = {
    matchId: match.id,
    // Absent until the map veto (see the map veto section above) has
    // settled on one - unlike `region`, this can't be known at match-
    // formation time, since it depends on the host/guest election that only
    // happens once both sides have accepted (see promoteToReady()).
    ...(match.map ? { map: match.map } : {}),
    // Which region this match will actually be played on - decided from both
    // sides' pings at match-formation time (see pickRegion()), never chosen
    // by either player. Shown from `pending` on: unlike the opponent reveal,
    // knowing the region ahead of accepting cannot bias either player's
    // answer.
    region: match.region,
    expiresInSeconds: Math.max(0, Math.ceil((match.expiresAt - now) / 1000)),
  };
  if (match.state === 'pending') return view;

  const self = players.find((p) => p.userId === userId);
  const opponent = opponentOf(players, userId);
  const gap = Math.abs(self.elo - opponent.elo);
  return {
    ...view,
    opponent: playerView(opponent, match.region.id),
    eloStake: eloStake(ticketRating(self), ticketRating(opponent), now),
    // Why this pairing was allowed at all - useful for a "wide search" badge.
    eloDifference: Math.round(gap),
    outsideBaseRange: gap > config.mmBaseEloRange,
  };
}

function queueView(ticket, now) {
  return {
    pings: pingsArray(ticket.pings),
    maxPing: ticket.maxPing,
    waitedSeconds: Math.floor((now - ticket.queuedAt) / 1000),
    eloRange: eloRange(ticket, now),
    elo: Math.round(ticket.elo),
    // Null once the band has stopped growing.
    nextExpansionInSeconds: eloRange(ticket, now) >= config.mmMaxEloRange && config.mmMaxEloRange > 0
      ? null
      : config.mmExpansionIntervalSeconds
        - Math.floor(((now - ticket.queuedAt) / 1000) % config.mmExpansionIntervalSeconds),
  };
}

// --- wait estimate -----------------------------------------------------

function formatMMSS(totalSeconds) {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const mm = String(Math.floor(clamped / 60)).padStart(2, '0');
  const ss = String(clamped % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Read-only wait estimate, meant for a client that has not queued yet - so it
 * needs no session and touches no ticket of its own. There is no historical
 * record of past match-formation times to draw on (matches.js only starts
 * recording once a match is actually playing), so this instead looks at who
 * is *currently* searching - maps no longer factor into who can pair with
 * whom (see the map veto section further down), so every waiting ticket
 * counts. How long those players have already been waiting is a reasonable
 * proxy for how long a new arrival would wait too - under steady-state
 * queueing, time-already-waited and time-still-to-wait have the same
 * average.
 */
async function estimateWait(now = Date.now()) {
  const pool = (await loadAllTickets()).filter((t) => !t.matchId);

  if (!pool.length) {
    return { estimate: 'Currently no one is queueing' };
  }

  const avgWaitedMs = pool.reduce((sum, t) => sum + (now - t.queuedAt), 0) / pool.length;
  return { estimate: `Estimated time: ${formatMMSS(avgWaitedMs / 1000)}` };
}

// --- region stats (Discord bot's live stats embed) --------------------------

/**
 * Who is doing what right now, broken down by region *and* by individual map.
 * `playing` counts players in a live match on that region/map; `queuing`
 * counts players who would accept it - i.e. whichever regions are still
 * within a queued ticket's own maxPing, exactly the same test formMatches()
 * uses to pair it (see commonRegions()).
 *
 * Maps are counted per *base* map, summed across every region - "how popular
 * is Ghost House", not "how popular is Ghost House in Europe". Which region
 * people are on is already the other half of this function, and keeping the
 * two dimensions independent is what makes either one readable.
 *
 * A queued ticket counts once per viable region and once per selected map -
 * so it can be counted in several regions and several maps at once, and the
 * totals deliberately sum past the number of players online. That is the
 * honest reading of the question these numbers answer: "how many people
 * would play this", not "how are the players divided up".
 *
 * Used live by the Discord stats embed (via regionStats() below) and sampled
 * over time by activity.js to build the popularity averages.
 */
async function activitySnapshot() {
  const [tickets, activeMatches] = await Promise.all([loadAllTickets(), loadAllMatches()]);

  const regions = Array.from({ length: matches.REGION_COUNT }, (_, region) => ({ region, playing: 0, queuing: 0 }));
  // `queuing` stays 0 for every map below: nobody picks a map before a match
  // forms anymore (see the map veto section further down), so "queuing for
  // this map" isn't a thing that can happen - the field is only kept so
  // activity.js's generic [type, key, playing, queuing] recording doesn't
  // need a special case for maps.
  const maps = new Map(matches.BASE_MAPS.map((base) => [base, { mapId: base, playing: 0, queuing: 0 }]));

  for (const match of activeMatches) {
    if (match.state !== 'playing') continue;
    if (regions[match.region.id]) regions[match.region.id].playing += match.playerIds.length;
    // match.map is only ever unset before "playing" (still being vetoed - see
    // resolveMapVeto()), and this loop only counts "playing" matches, so it
    // is always decided by the time we get here.
    const map = maps.get(match.map.id);
    if (map) map.playing += match.playerIds.length;
  }

  for (const ticket of tickets) {
    if (ticket.matchId) continue; // already paired - counted as "playing" above once that match is live, not still "queuing"

    for (let region = 0; region < matches.REGION_COUNT; region++) {
      if (ticket.pings[region] <= ticket.maxPing) regions[region].queuing += 1;
    }
  }

  return { regions, maps: [...maps.values()] };
}

// Just the region half of activitySnapshot(), which is all the live embed in
// src/bot/statsBoard.js needs.
async function regionStats() {
  return (await activitySnapshot()).regions;
}

/**
 * Admin-triggered undo for a settled match (the Discord bot's /match "Revert"
 * button - see src/bot/commands.js). Subtracts each side's recorded change -
 * rating, rd and volatility alike - regardless of whatever has happened to
 * either player since: applyRatingDelta() is purely additive, so backing out
 * this match's own contribution composes with every later match instead of
 * discarding them the way restoring a snapshot would. The matches rows
 * themselves are kept, just flagged (see matches.markReverted()), so the
 * history still shows what happened.
 *
 * Under Glicko-2 this is an approximation, and was under flat elo too: it
 * leaves the player where they would be if this match's numbers had never been
 * added, not where replaying their whole history without this match would put
 * them. Those differ because rd and volatility feed how much *later* matches
 * moved them. Replaying history is the only exact answer and is not worth its
 * cost for an admin action this rare.
 *
 * Rows written before Glicko-2 landed carry no rd/vol columns; those revert
 * the rating alone, which is exactly what they contributed.
 */
async function revertMatch(matchUid, revertedBy, reason) {
  const rows = await matches.getByMatchUid(matchUid);
  if (!rows.length) return { ok: false, code: 'not_found' };
  if (rows[0].reverted_at) return { ok: false, code: 'already_reverted' };

  if (!(await matches.markReverted(matchUid, revertedBy, reason))) {
    return { ok: false, code: 'already_reverted' };
  }

  await Promise.all(rows.map((row) => users.applyRatingDelta(row.user_id, {
    rating: -row.elo_delta,
    rd: row.rd_after === null ? 0 : -(row.rd_after - row.rd_before),
    vol: row.vol_after === null ? 0 : -(row.vol_after - row.vol_before),
  })));
  return { ok: true };
}

// --- match lifecycle -------------------------------------------------------

// Regions where both sides' own ping reading for that region is within their
// own maxPing - the one thing that decides whether a region is playable at
// all, never a player's selection. Order doesn't matter here; pickRegion()
// below is what actually picks the best of these once a pair is otherwise
// compatible.
function commonRegions(a, b) {
  const regions = [];
  for (let region = 0; region < matches.REGION_COUNT; region++) {
    if (a.pings[region] <= a.maxPing && b.pings[region] <= b.maxPing) regions.push(region);
  }
  return regions;
}

/**
 * The elo band plus region viability. Maps no longer factor in at all here -
 * every pair is compatible on maps by construction, since nobody picks one
 * before a match forms anymore (see the map veto section further down).
 * Returns the regions both sides could actually play on and the elo gap when
 * the two tickets may play each other, otherwise null.
 */
function compatibility(a, b, now) {
  if (a.avoid[b.userId] > now || b.avoid[a.userId] > now) return null;

  const regions = commonRegions(a, b);
  if (!regions.length) return null;

  // The wider of the two bands decides: a player who waited long enough to
  // expand should actually be pulled a match rather than having to wait for
  // someone else to expand just as far. eloStake() then compensates whoever
  // ends up outside their own standard band.
  const gap = Math.abs(a.elo - b.elo);
  if (gap > Math.max(eloRange(a, now), eloRange(b, now))) return null;

  return { regions, gap };
}

// Picks the region that gives the pair the best worst-case connection: the
// one minimizing max(a's ping there, b's ping there), so neither side is
// carrying a materially worse connection than the other could have had.
// Ties (including the common case of only one viable region) fall back to
// the lower total of the two pings, then to the lowest region index, so two
// independent callers computing this from the same two tickets always agree
// without needing to compare notes.
function pickRegion(a, b, regions) {
  let best = null;
  for (const region of regions) {
    const worst = Math.max(a.pings[region], b.pings[region]);
    const total = a.pings[region] + b.pings[region];
    if (!best || worst < best.worst || (worst === best.worst && total < best.total)) {
      best = { region, worst, total };
    }
  }
  return best.region;
}

async function createMatch(a, b, fit, now) {
  const region = pickRegion(a, b, fit.regions);
  const match = {
    id: crypto.randomBytes(9).toString('base64url'),
    region: REGION_BY_ID.get(region),
    // The map is not picked here at all anymore - see the map veto section
    // below. `map`/`stageName` are filled in by resolveMapVeto() once the
    // host and guest have banned their way down to one.
    map: null,
    mapPool: MAPS.map((m) => m.id),
    mapBans: [],
    stageName: null,
    playerIds: [a.userId, b.userId],
    state: 'pending',
    createdAt: now,
    expiresAt: now + config.mmAcceptSeconds * 1000,
    // Rule 9's host election: uniformly random, and decided once, right here
    // - createMatch() only ever runs once per match, under formMatches()'s
    // tick lock - rather than at promoteToReady() time below, where two
    // concurrent accept requests independently recomputing it could each
    // roll a different answer (unlike the old ping-based election, a random
    // pick is not a pure function either side can safely redo). Hidden from
    // both clients until `ready` regardless (see matchView()), so deciding
    // it this early leaks nothing. The map veto below also runs host-vs-guest
    // off this same election - see mapVetoTurn().
    hostId: crypto.randomInt(2) === 0 ? a.userId : b.userId,
    roomCode: null,
    readyAt: null,
  };

  a.matchId = match.id;
  b.matchId = match.id;

  const ttlAt = match.expiresAt + MATCH_TTL_BUFFER_MS;
  await Promise.all([
    saveMatch(match),
    // Own explicit TTL rather than relying on saveMatch()'s (which targets
    // this same key) landing after this HSET creates it.
    redis.client.multi()
      .hSet(responsesKey(match.id), { [a.userId]: 'pending', [b.userId]: 'pending' })
      .pExpireAt(responsesKey(match.id), ttlAt)
      .exec(),
    saveTicket(a),
    saveTicket(b),
  ]);

  return match;
}

// --- map veto (CS2-style exclusion) -----------------------------------
//
// Runs once a match is `ready` (see promoteToReady()), before the host is
// allowed to publish a room code (see publishRoomCode()). The host bans two
// maps, then the guest bans one, off the same host/guest election
// createMatch() already made - leaving one map out of the starting pool to
// actually play on (or, if the pool ever grows past four maps, whatever's
// left once the scripted turns run out - see resolveMapVeto()).

// Whose turn it is to ban next, indexed by how many bans have happened so
// far this match.
const MAP_VETO_ORDER = ['host', 'host', 'guest'];

function bannedMapIdSet(match) {
  return new Set(match.mapBans.map((b) => b.mapId));
}

// Maps not yet banned, in mapPool order.
function remainingMapIds(match) {
  const banned = bannedMapIdSet(match);
  return match.mapPool.filter((id) => !banned.has(id));
}

// 'host' | 'guest' | null - null once match.map is decided.
function mapVetoTurn(match) {
  if (match.map) return null;
  return MAP_VETO_ORDER[match.mapBans.length] || null;
}

function isPlayersTurn(match, userId) {
  const turn = mapVetoTurn(match);
  if (turn === 'host') return match.hostId === userId;
  if (turn === 'guest') return match.hostId !== userId;
  return false;
}

// Finalizes match.map/stageName the instant the veto has nothing left to
// decide: either the scripted order above has run its course, or (a pool
// smaller than four maps) only one survivor is left early. More than one
// survivor once the scripted order runs out - only reachable if the pool
// grows past four maps - is broken by a random pick, the same rule
// formMatches() used to pick the map before this feature existed.
function resolveMapVeto(match) {
  if (match.map) return;

  const remaining = remainingMapIds(match);
  if (remaining.length > 1 && match.mapBans.length < MAP_VETO_ORDER.length) return;

  const finalId = remaining.length === 1 ? remaining[0] : remaining[crypto.randomInt(remaining.length)];
  match.map = MAP_BY_ID.get(finalId);
  match.stageName = `${match.region.id}${finalId}`;
}

// What the "ready" match poll shows about the veto while it's still going -
// see matchStatus(). null once match.map is decided: matchView()'s own `map`
// field has the answer at that point, so there is nothing left to add here.
function mapVetoView(match, userId) {
  if (match.map) return null;
  return {
    turn: mapVetoTurn(match),
    yourTurn: isPlayersTurn(match, userId),
    remainingMaps: remainingMapIds(match).map((id) => MAP_BY_ID.get(id)),
    bannedMaps: match.mapBans.map((b) => MAP_BY_ID.get(b.mapId)),
  };
}

/**
 * The map veto endpoint. Only the player whose turn it is may call this, and
 * only while the match is `ready` and undecided - see mapVetoTurn() above.
 */
async function banMap(userId, mapId, now = Date.now()) {
  const ticket = await loadTicket(userId);
  const match = ticket && ticket.matchId ? await loadMatch(ticket.matchId) : null;
  if (!match || match.state !== 'ready') return { ok: false, code: 'no_ready_match' };
  if (!MAP_BY_ID.has(mapId)) return { ok: false, code: 'unknown_map' };

  // Re-read fresh right before mutating - same reasoning as respond()'s
  // accept-promotion: an accidental double-tap firing two requests for the
  // same ban must not both apply against the same now-stale turn.
  const fresh = await loadMatch(match.id);
  if (!fresh || fresh.state !== 'ready') return { ok: false, code: 'no_ready_match' };
  if (fresh.map) return { ok: false, code: 'map_already_decided' };
  if (!isPlayersTurn(fresh, userId)) return { ok: false, code: 'not_your_turn' };

  const remaining = remainingMapIds(fresh);
  if (!remaining.includes(mapId)) return { ok: false, code: 'map_already_banned' };
  if (remaining.length <= 1) return { ok: false, code: 'no_maps_left' }; // never ban the last map standing

  fresh.mapBans.push({ by: userId, mapId, at: now });
  resolveMapVeto(fresh);
  await saveMatch(fresh);

  ticket.lastSeenAt = now;
  await saveTicket(ticket);

  return { ok: true, status: await matchStatus(userId, now) };
}

/**
 * Tears a match down and tells both sides why. Players in `fault` (declined,
 * left, or never answered) drop out of matchmaking entirely; the other side is
 * put back in the queue keeping its original queuedAt, so being let down does
 * not also cost it the elo band it had already earned by waiting.
 */
async function endMatch(match, players, now, cause, fault) {
  // Two teardown triggers can legitimately fire for the same match near-
  // simultaneously (e.g. a decline arriving right as the accept-window sweep
  // also expires it). claimMatch() is atomic, so exactly one caller proceeds;
  // everyone else treats it as a no-op instead of overwriting a just-recorded
  // outcome with a second, equally-true-but-different reason.
  if (!(await claimMatch(match.id))) return;

  await Promise.all(players.map(async (player) => {
    const atFault = fault.has(player.userId);
    const opponent = opponentOf(players, player.userId);

    await saveOutcome(player.userId, {
      matchId: match.id,
      reason: atFault ? cause : `opponent_${cause}`,
      requeued: !atFault,
      at: now,
    });

    if (atFault) {
      await deleteTicket(player.userId);
    } else {
      player.matchId = null;
      player.avoid[opponent.userId] = now + REMATCH_COOLDOWN_MS;
      player.lastSeenAt = now;
      await saveTicket(player);
    }
  }));
}

/**
 * Ends a "playing" match. Unlike endMatch(), there is no "fault" requeue path
 * here - a real game was (or should have been) played, so both sides simply
 * leave matchmaking; queuing again is a fresh decision, not an entitlement.
 *
 * `resolution.winnerId` present -> a legitimate result: run the Glicko-2
 * update eloStake() has been projecting since the match went ready, and
 * append a matches.js row for each side. Absent -> no legitimate winner
 * (disputed self-reports, both sides went quiet, or the match simply ran too
 * long) - no elo, no history, just a definite ending for both.
 *
 * Before any of that, `resolution` can still be overridden by a missing
 * replay: if exactly one side ever uploaded one via alive() (see
 * setReplay()), they win outright ('opponent_no_replay' / 'no_replay')
 * regardless of what `resolution` said - a self-reported win, a forfeit, even
 * a dispute or timeout all yield to whoever actually has proof. Both sides
 * having one, or neither, leaves `resolution` untouched.
 */
async function finishPlaying(match, players, now, resolution) {
  // Unlike endMatch()'s equivalent guard, this one is load-bearing for
  // correctness, not just tidiness: a plain check-then-delete would leave a
  // gap where e.g. a player's own agreed result and the disconnect sweep
  // could both slip through and double-apply elo for the same match.
  // claimMatch() is atomic, so exactly one caller ever proceeds.
  // Read before claimMatch() below, which deletes this same hash - whatever
  // replay(s) either side uploaded via alive() (see setReplay()) need to be
  // read while they still exist, regardless of which path settled the match
  // (agreed result, disconnect, forfeit - a replay upload only requires a
  // result on that side's own alive() call, not that both sides agreed).
  const replays = await getReplays(match.id);
  if (!(await claimMatch(match.id))) return;

  // Helper function to get the winner side from a replay URL
  async function getReplayWinner(replayUrl) {
    if (!replayUrl) return null;
    try {
      const response = await globalThis.fetch(replayUrl);
      if (!response.ok) return null;
      const arrayBuffer = await response.arrayBuffer();
      const metadata = matches.parseReplayMetadata(arrayBuffer);
      if (!metadata.hasHostClientResult) return null;
      return metadata.winner.side; // "host" or "client"
    } catch (err) {
      console.error(`Failed to fetch or parse replay ${replayUrl}:`, err);
      return null;
    }
  }

  // Determine if we should consider the replay (only for self-reported resolutions)
  const shouldConsiderReplay = resolution.winnerId !== undefined || resolution.reason === 'disputed';

  let winnerId = resolution.winnerId;
  let winnerReason = resolution.winnerReason;
  let loserReason = resolution.loserReason;

  if (shouldConsiderReplay) {
    // We are going to try to get the winner from the replays.
    const [playerA, playerB] = players;
    const aHasReplay = Boolean(replays[playerA.userId]);
    const bHasReplay = Boolean(replays[playerB.userId]);

    // Get replay results for each player that has a replay
    const replayAResult = aHasReplay ? await getReplayWinner(replays[playerA.userId]) : null;
    const replayBResult = bHasReplay ? await getReplayWinner(replays[playerB.userId]) : null;

    let replayWinnerSide = null; // null means draw/invalid, otherwise "host" or "client"

    if (replayAResult === null && replayBResult === null) {
      // No valid replays -> draw
      replayWinnerSide = null;
      console.log("finishPlaying: 0")
    } else if (replayAResult !== null && replayBResult === null) {
      replayWinnerSide = replayAResult;
      console.log("finishPlaying: 1")
    } else if (replayAResult === null && replayBResult !== null) {
      replayWinnerSide = replayBResult;
      console.log("finishPlaying: 2")
    } else {
      // Both are non-null
      if (replayAResult === replayBResult) {
        console.log("finishPlaying: 3")
        replayWinnerSide = replayAResult;
      } else {
        console.log("finishPlaying: 4")
        // They disagree -> draw
        replayWinnerSide = null;
      }
    }

    if (replayWinnerSide !== null) {
      // We have a clear winner from the replays
      if (replayWinnerSide === "host") {
        winnerId = match.hostId;
      } else {
        winnerId = opponentOf(players, match.hostId).userId;
      }
      winnerReason = 'won_by_replay';
      loserReason = 'lost_by_replay';
    } else {
      // Draw from replays
      winnerId = null;
      winnerReason = undefined;
      loserReason = 'draw_by_replay';
    }
  }

  // Now, if we have a winnerId (either from the original resolution or from the replay), we apply elo and record.
  // Otherwise, we treat as draw (no elo, no history) and set the outcome for both to the draw reason.
  if (winnerId) {
    const winner = players.find((p) => p.userId === winnerId);
    const loser = opponentOf(players, winner.userId);

    // Read both players' ratings back from postgres rather than trusting the
    // snapshot their tickets have carried since enqueue: the decay sweep
    // (ratingDecay.js) can have moved either of them in between, and applying
    // a Glicko-2 update computed against a stale rating would silently undo
    // it. The tickets' copies stay good enough for the band and the projected
    // stake, neither of which has to be exact.
    const [winnerRow, loserRow] = await Promise.all([
      users.findById(winner.userId), users.findById(loser.userId),
    ]);
    const winnerBefore = users.ratingFor(winnerRow);
    const loserBefore = users.ratingFor(loserRow);

    // Both sides of a match are one simultaneous update, so each is rated
    // against the other's *pre-match* numbers - never against what this same
    // settlement just gave the other player.
    const winnerAfter = glicko.rate(winnerBefore, loserBefore, 1, now);
    const loserAfter = glicko.rate(loserBefore, winnerBefore, 0, now);
    const winDelta = winnerAfter.rating - winnerBefore.rating;
    const loseDelta = loserAfter.rating - loserBefore.rating;
    const at = new Date(now);

    await Promise.all([
      users.applyRating(winner.userId, winnerAfter, at),
      users.applyRating(loser.userId, loserAfter, at),
      matches.record({
        userId: winner.userId, opponentId: loser.userId, opponentName: loser.displayName,
        matchUid: match.id, stage: match.stageName, eloDelta: winDelta,
        replayUrl: replays[winner.userId],
        rating: {
          rdBefore: winnerBefore.rd, rdAfter: winnerAfter.rd,
          volBefore: winnerBefore.vol, volAfter: winnerAfter.vol,
        },
      }),
      matches.record({
        userId: loser.userId, opponentId: winner.userId, opponentName: winner.displayName,
        matchUid: match.id, stage: match.stageName, eloDelta: loseDelta,
        replayUrl: replays[loser.userId],
        rating: {
          rdBefore: loserBefore.rd, rdAfter: loserAfter.rd,
          volBefore: loserBefore.vol, volAfter: loserAfter.vol,
        },
      }),
      saveOutcome(winner.userId, { matchId: match.id, reason: winnerReason, requeued: false, at: now }),
      saveOutcome(loser.userId, { matchId: match.id, reason: loserReason, requeued: false, at: now }),
      deleteTicket(winner.userId),
      deleteTicket(loser.userId),
    ]);
  } else {
    // Draw or no winner: set outcome for both and delete tickets.
    await Promise.all(players.flatMap((player) => [
      saveOutcome(player.userId, { matchId: match.id, reason: loserReason, requeued: false, at: now }),
      deleteTicket(player.userId),
    ]));
  }
}

// Both sides said yes, so the match can actually be played. The host was
// already decided at createMatch() time (see there) - this only flips the
// state and gives the room-code handoff its own window.
function promoteToReady(match, now) {
  match.state = 'ready';
  match.readyAt = now;
  match.expiresAt = now + config.mmReadyTtlSeconds * 1000;
}

/**
 * Pairs everyone who can be paired. Oldest ticket first so the longest wait is
 * served first, and among the candidates the closest elo wins - expanding a
 * band lets a distant opponent in, it does not make one preferable.
 */
async function formMatches(now) {
  const all = await loadAllTickets();
  const waiting = all.filter((t) => !t.matchId).sort((a, b) => a.queuedAt - b.queuedAt);

  const taken = new Set();
  for (const ticket of waiting) {
    if (taken.has(ticket.userId)) continue;

    let best = null;
    for (const other of waiting) {
      if (other === ticket || taken.has(other.userId)) continue;
      const fit = compatibility(ticket, other, now);
      if (!fit) continue;
      if (!best || fit.gap < best.fit.gap || (fit.gap === best.fit.gap && other.queuedAt < best.other.queuedAt)) {
        best = { other, fit };
      }
    }
    if (!best) continue;

    taken.add(ticket.userId);
    taken.add(best.other.userId);
    await createMatch(ticket, best.other, best.fit, now);
  }
}

async function expireMatches(now) {
  const activeMatches = await loadAllMatches();
  for (const match of activeMatches) {
    if (match.state !== 'pending' || match.expiresAt > now) continue;

    const [players, responses] = await Promise.all([loadPlayers(match), getResponses(match.id)]);
    if (!players) continue; // a concurrent request already ended this one

    // Whoever never answered is at fault. If both went quiet, both are.
    const fault = new Set(players.filter((p) => responses[p.userId] !== 'accepted').map((p) => p.userId));
    await endMatch(match, players, now, 'timeout', fault);
  }
}

async function expireTickets(now) {
  const staleBefore = now - config.mmTicketStaleSeconds * 1000;
  const tickets = await loadAllTickets();
  for (const ticket of tickets) {
    if (ticket.lastSeenAt >= staleBefore) continue;

    const match = ticket.matchId ? await loadMatch(ticket.matchId) : null;
    // During the accept phase mmAcceptSeconds is the authoritative clock: it is
    // longer than the stale window, and expiring the ticket here would cut a
    // player's decision short and report it as a walkout rather than a timeout.
    // "playing" has its own dedicated, elo-affecting staleness check below
    // (expirePlayingMatches) - this generic one must not also fire for it.
    if (match && (match.state === 'pending' || match.state === 'playing')) continue;

    // Going quiet after accepting is a walkout - the opponent is waiting on a
    // room that is never going to arrive, so free them up now.
    if (match) {
      const players = await loadPlayers(match);
      if (players) await endMatch(match, players, now, 'left', new Set([ticket.userId]));
    }
    await deleteTicket(ticket.userId);
  }
}

async function expireReadyMatches(now) {
  const activeMatches = await loadAllMatches();
  for (const match of activeMatches) {
    if (match.state !== 'ready' || match.expiresAt > now) continue;

    // Nobody is at fault here - the room simply went unclaimed long enough
    // that the clients have moved on. Both sides drop out of matchmaking, but
    // the outcome still says why so a late poll gets a real answer.
    const players = await loadPlayers(match);
    if (!players) continue; // a concurrent request already ended this one
    await deleteMatch(match.id);
    await Promise.all(players.map(async (player) => {
      await deleteTicket(player.userId);
      await saveOutcome(player.userId, { matchId: match.id, reason: 'expired', requeued: false, at: now });
    }));
  }
}

/**
 * The disconnect/hard-cap watchdog for matches that are actually being
 * played. A player who has never sent /matchmaking/alive is judged against
 * playingStartedAt (one full grace window to show up at all) rather than a
 * missing aliveAt.
 */
async function expirePlayingMatches(now) {
  const activeMatches = await loadAllMatches();
  for (const match of activeMatches) {
    if (match.state !== 'playing') continue;

    const players = await loadPlayers(match);
    if (!players) continue; // a concurrent request already ended this one

    // The non-refreshable ceiling takes priority: even if both are still
    // sending /alive, a match cannot hold two tickets hostage forever.
    if (now > match.hardExpiresAt) {
      await finishPlaying(match, players, now, { reason: 'match_expired' });
      continue;
    }

    const staleAt = (p) => (p.aliveAt || match.playingStartedAt) + config.mmAliveStaleSeconds * 1000;
    const [a, b] = players;
    const aStale = now > staleAt(a);
    const bStale = now > staleAt(b);

    if (aStale && bStale) {
      await finishPlaying(match, players, now, { reason: 'both_disconnected' });
    } else if (aStale) {
      await finishPlaying(match, players, now, {
        winnerId: b.userId, winnerReason: 'opponent_disconnected', loserReason: 'disconnected',
      });
    } else if (bStale) {
      await finishPlaying(match, players, now, {
        winnerId: a.userId, winnerReason: 'opponent_disconnected', loserReason: 'disconnected',
      });
    }
  }
}

/**
 * One pass of the whole system. Idempotent with respect to `now`, so the poll
 * routes can call it for a fresh answer while the background interval keeps
 * things moving for clients that have gone quiet. Guarded by withTickLock()
 * so only one pass ever runs at a time across every caller and every process.
 */
async function tick(now = Date.now()) {
  await withTickLock(async () => {
    await expireTickets(now);
    await expireMatches(now);
    await expireReadyMatches(now);
    await expirePlayingMatches(now);
    await formMatches(now);
  });
}

// --- operations the API layer calls ----------------------------------------

/**
 * Rule 3: enters the queue with the player's chosen options. Re-queuing while
 * already searching, or with a live match, is refused - a player must cancel
 * or resolve whatever they are already in before starting a new search.
 */
async function enqueue(user, options, now = Date.now()) {
  const existing = await loadTicket(user.discord_id);
  if (existing && existing.matchId) {
    return { ok: false, code: 'match_in_progress' };
  }
  if (existing) {
    return { ok: false, code: 'already_queued' };
  }

  console.log(`User ${user.display_name} queued with pings: ${pingsArray(options.pings)} maxPing: ${options.maxPing}`)

  // The whole Glicko-2 state, not just the rating: the band below only needs
  // the rating, but matchView()'s eloStake projection needs all of it, and
  // re-reading the user row on every poll to get it would be wasteful.
  // finishPlaying() deliberately does not trust this snapshot - see there.
  const rating = users.ratingFor(user);

  const ticket = {
    userId: user.discord_id,
    username: user.username,
    displayName: user.display_name,
    avatarHash: user.avatar_hash,
    elo: rating.rating,
    rd: rating.rd,
    vol: rating.vol,
    ratedAt: rating.ratedAt,
    pings: options.pings,
    maxPing: options.maxPing,
    queuedAt: now,
    lastSeenAt: now,
    matchId: null,
    // Opponents this ticket may not be re-paired with yet: userId -> until ts.
    avoid: {},
  };

  await saveTicket(ticket);
  await deleteOutcome(ticket.userId);
  await tick(now);

  return { ok: true, status: await status(ticket.userId, now) };
}

// Leaves the queue, and abandons a pending/ready match if one had just been
// found. Cancelling a "playing" match is a forfeit, not a free walkout - it
// is treated exactly like going quiet on /matchmaking/alive (elo applies to
// both sides), so a losing player cannot dodge the loss by cancelling
// instead of just disconnecting.
async function leave(userId, now = Date.now()) {
  const ticket = await loadTicket(userId);
  if (!ticket) return { ok: true, left: false };

  const match = ticket.matchId ? await loadMatch(ticket.matchId) : null;
  if (match) {
    const players = await loadPlayers(match);
    if (players) {
      if (match.state === 'playing') {
        const opponent = opponentOf(players, userId);
        await finishPlaying(match, players, now, {
          winnerId: opponent.userId, winnerReason: 'opponent_forfeited', loserReason: 'forfeited',
        });
        // A forfeit is consequential (it just cost elo) unlike a plain
        // cancel, so - unlike the branch below - leave the outcome
        // finishPlaying() just wrote in place for the next poll to surface,
        // instead of immediately clearing it.
        return { ok: true, left: true };
      }
      await endMatch(match, players, now, 'left', new Set([userId]));
    }
  }
  await deleteTicket(userId);
  await deleteOutcome(userId);
  return { ok: true, left: true };
}

/**
 * The queue poll (endpoint 2). Reports searching / found / idle, carries the
 * refreshed per-region ping readings into the ticket, and surfaces how the
 * previous match ended exactly once.
 */
async function status(userId, now = Date.now(), pings, maxPing) {
  const ticket = await loadTicket(userId);
  if (ticket) {
    if (pings !== undefined) ticket.pings = parsePings(pings);
    if (maxPing !== undefined) ticket.maxPing = clampPing(maxPing);
    ticket.lastSeenAt = now;
    await saveTicket(ticket);
  }

  await tick(now);

  const lastMatch = await takeOutcome(userId);
  const live = await loadTicket(userId);
  if (!live) {
    return { status: 'idle', ...(lastMatch ? { lastMatch } : {}) };
  }

  if (live.matchId) {
    const match = await loadMatch(live.matchId);
    if (match) {
      const [players, responses] = await Promise.all([loadPlayers(match), getResponses(match.id)]);
      // players is null only if a concurrent request tore the match down in
      // the instant between the two loads above - fall through to
      // "searching" using the ticket's own current state, same as if `match`
      // itself had already been missing.
      if (players) {
        return {
          status: 'found',
          match: matchView(match, players, userId, now),
          response: responses[userId],
          ...(lastMatch ? { lastMatch } : {}),
        };
      }
    }
  }

  return { status: 'searching', queue: queueView(live, now), ...(lastMatch ? { lastMatch } : {}) };
}

// Endpoints 3 and 4. `accepted: false` is a decline, which ends the match and
// takes the decliner out of matchmaking.
async function respond(userId, accepted, now = Date.now()) {
  const ticket = await loadTicket(userId);
  const match = ticket && ticket.matchId ? await loadMatch(ticket.matchId) : null;
  if (!match || match.state !== 'pending') return { ok: false, code: 'no_pending_match' };

  ticket.lastSeenAt = now;
  await saveTicket(ticket);

  if (!accepted) {
    const players = await loadPlayers(match);
    // players is null if a concurrent sweep (e.g. the accept-window timeout)
    // already ended this match - nothing left to decline, and matchStatus()
    // below will correctly report whatever that other ending recorded.
    if (players) await endMatch(match, players, now, 'declined', new Set([userId]));
    return { ok: true, status: await matchStatus(userId, now) };
  }

  await setResponse(match.id, userId, 'accepted');
  const [players, responses] = await Promise.all([loadPlayers(match), getResponses(match.id)]);

  if (players && players.every((p) => responses[p.userId] === 'accepted')) {
    // Both players accepting within the same instant is the common case, not
    // an edge case - re-check the match is still pending right before
    // promoting rather than trusting the `match` fetched above, so this can
    // never clobber a match the accept-window timeout sweep just tore down.
    // If the *other* side's request is promoting at the same moment, both
    // computations only flip state/expiresAt - hostId was already fixed at
    // createMatch() time (see there), so the loser of this race just
    // performs a harmless, equivalent overwrite.
    const fresh = await loadMatch(match.id);
    if (fresh && fresh.state === 'pending') {
      promoteToReady(fresh, now);
      await saveMatch(fresh);
    }
  }

  return { ok: true, status: await matchStatus(userId, now) };
}

/**
 * The match poll (endpoint 5), used from the moment a player accepts. Reports
 * waiting / ready / ended, and once ready carries the host decision plus the
 * Photon room code as soon as the host publishes one.
 */
async function matchStatus(userId, now = Date.now(), pings, maxPing) {
  const ticket = await loadTicket(userId);
  if (ticket) {
    if (pings !== undefined) ticket.pings = parsePings(pings);
    if (maxPing !== undefined) ticket.maxPing = clampPing(maxPing);
    ticket.lastSeenAt = now;
    await saveTicket(ticket);
  }

  await tick(now);

  const lastMatch = await takeOutcome(userId);
  const live = await loadTicket(userId);
  const match = live && live.matchId ? await loadMatch(live.matchId) : null;

  const players = match ? await loadPlayers(match) : null;
  if (!players) {
    // Either there was no match, or (rarely) a concurrent request tore it
    // down between the two loads above - both cases report the same way.
    if (lastMatch) return { status: 'ended', ...lastMatch };
    return { status: 'none' };
  }

  // Same `match` shape as /matchmaking/poll reports, so a client only needs
  // one model for it no matter which poll the answer came from.
  const base = matchView(match, players, userId, now);

  if (match.state === 'pending') {
    const responses = await getResponses(match.id);
    return {
      status: 'waiting',
      match: base,
      accepted: responses[userId] === 'accepted',
      opponentAccepted: responses[opponentOf(players, userId).userId] === 'accepted',
    };
  }

  if (match.state === 'playing') {
    const results = await getResults(match.id);
    return {
      status: 'playing',
      match: base,
      isHost: match.hostId === userId,
      hostId: match.hostId,
      roomCode: match.roomCode,
      resultSubmitted: results[userId] !== undefined,
      // Deliberately not the opponent's actual value: revealing it before
      // you have submitted your own would let a dishonest client just copy
      // it, defeating the whole point of independently self-reported results.
      opponentResultSubmitted: results[opponentOf(players, userId).userId] !== undefined,
    };
  }

  const veto = mapVetoView(match, userId);
  return {
    status: 'ready',
    match: base,
    isHost: match.hostId === userId,
    hostId: match.hostId,
    // The host is expected to create the Photon room and publish the code
    // once the map veto below is done - see publishRoomCode(). The guest
    // keeps polling this until roomCode stops being null.
    roomCode: match.roomCode,
    // Only present while the veto is still going - once match.map is decided
    // it shows up on `match` itself instead (see matchView()), so there is
    // nothing left to add here.
    ...(veto ? { mapVeto: veto } : {}),
  };
}

// Endpoint 6: the elected host hands over the Photon room code.
async function publishRoomCode(userId, rawCode, now = Date.now()) {
  const ticket = await loadTicket(userId);
  const match = ticket && ticket.matchId ? await loadMatch(ticket.matchId) : null;
  if (!match || match.state !== 'ready') return { ok: false, code: 'no_ready_match' };
  if (match.hostId !== userId) return { ok: false, code: 'not_host' };
  // The map veto (see above) has to settle before there is anything for the
  // room to actually be played on.
  if (!match.map) return { ok: false, code: 'map_not_decided' };

  const roomCode = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!roomCode || roomCode.length > 64) return { ok: false, code: 'invalid_room_code' };

  ticket.lastSeenAt = now;
  await saveTicket(ticket);

  match.roomCode = roomCode;
  // The guest still has to read this, so give the match a fresh full window
  // rather than letting the accept-phase clock run it out.
  match.expiresAt = Math.max(match.expiresAt, now + config.mmReadyTtlSeconds * 1000);
  await saveMatch(match);

  return { ok: true, status: await matchStatus(userId, now) };
}

/**
 * Endpoint 8, the heartbeat both players send throughout actual gameplay.
 * Requires a room code to exist (i.e. the host has actually created the
 * room). The match only becomes "playing" once *both* sides have called
 * this at least once - one side confirming just leaves it "ready" until the
 * other does too, same as promoting to "ready" itself needs both accepts.
 * `result` is optional and independent per player: `true` means "the host
 * won" as far as *this* client's game concluded, `false` means the other
 * player did. Once both sides have reported, agreement settles the match
 * with elo; disagreement means someone is lying, and settles it with none.
 * `replayUrl` is optional and only meaningful alongside `result` - the
 * replay itself lives on whatever external service the client uploaded it
 * to; this is just where it landed, kept here until finishPlaying() reads it
 * back once the match actually settles (see getReplays() there).
 */
async function alive(userId, result, replayUrl, now = Date.now()) {
  const ticket = await loadTicket(userId);
  const match = ticket && ticket.matchId ? await loadMatch(ticket.matchId) : null;
  if (!match || (match.state !== 'ready' && match.state !== 'playing')) {
    return { ok: false, code: 'no_active_match' };
  }
  if (match.state === 'ready' && !match.roomCode) {
    return { ok: false, code: 'room_not_ready' };
  }

  ticket.lastSeenAt = now;
  ticket.aliveAt = now;
  await saveTicket(ticket);

  let current = match;
  if (match.state === 'ready') {
    // Re-load fresh so this player's own aliveAt write above is visible -
    // only promote once neither ticket's aliveAt is still empty.
    const players = await loadPlayers(match);
    if (players && players.every((p) => p.aliveAt)) {
      current = { ...match, state: 'playing', playingStartedAt: now };
      current.hardExpiresAt = now + config.mmMatchMaxSeconds * 1000;
      // expiresAt is reused as-is by saveTicket()/saveMatch()'s redis-level
      // safety-net TTL and by matchView()'s expiresInSeconds - pointing it at
      // the (non-refreshable) hard cap keeps both meaningful for the whole
      // "playing" phase instead of expiring the key ~2 minutes in.
      current.expiresAt = current.hardExpiresAt;
      await saveMatch(current);
    }
  }

  if (current.state === 'playing' && typeof result === 'boolean') {
    await setResult(current, userId, result ? 'true' : 'false');
    if (replayUrl) await setReplay(current, userId, replayUrl);

    const [results, players] = await Promise.all([getResults(current.id), loadPlayers(current)]);
    if (players && results[players[0].userId] !== undefined && results[players[1].userId] !== undefined) {
      // Re-check fresh and still "playing" right before settling, same
      // reasoning as respond()'s accept-promotion: a disconnect sweep could
      // have ended this match in the instant between the reads above.
      const fresh = await loadMatch(current.id);
      if (fresh && fresh.state === 'playing') {
        if (results[players[0].userId] === results[players[1].userId]) {
          const hostWon = results[players[0].userId] === 'true';
          const winnerId = hostWon ? fresh.hostId : opponentOf(players, fresh.hostId).userId;
          await finishPlaying(fresh, players, now, { winnerId, winnerReason: 'won', loserReason: 'lost' });
        } else {
          await finishPlaying(fresh, players, now, { reason: 'disputed' });
        }
      }
    }
  }

  return { ok: true, status: await matchStatus(userId, now) };
}

// --- lifecycle -------------------------------------------------------------

// Keeps queues moving for clients that have gone quiet; the poll routes tick
// on their own for anything that needs an immediate answer.
function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => console.error('Matchmaking tick failed:', err));
  }, 1000);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Test seam: drops all state without touching the interval.
async function reset() {
  const [userIds, matchIds] = await Promise.all([
    redis.client.sMembers(TICKETS_INDEX),
    redis.client.sMembers(MATCHES_INDEX),
  ]);

  const multi = redis.client.multi();
  for (const userId of userIds) multi.del(ticketKey(userId));
  for (const matchId of matchIds) multi.del(matchKey(matchId)).del(responsesKey(matchId)).del(resultsKey(matchId));
  multi.del(TICKETS_INDEX).del(MATCHES_INDEX);
  await multi.exec();

  // Outcomes are not indexed - they normally just age out on their own TTL -
  // but a reset used between tests needs them gone immediately too.
  for await (const key of redis.client.scanIterator({ MATCH: `${KEY_PREFIX}outcome:*` })) {
    await redis.client.del(key);
  }
}

module.exports = {
  MAPS,
  REGIONS,
  parseOptions,
  estimateWait,
  activitySnapshot,
  regionStats,
  revertMatch,
  enqueue,
  status,
  respond,
  matchStatus,
  banMap,
  publishRoomCode,
  alive,
  leave,
  tick,
  start,
  stop,
  reset,
};
