const config = require('../config');
const redis = require('../db/redis');

/**
 * Online presence. A single redis sorted set - member is the discord id,
 * score is the ms timestamp of their last /api/online heartbeat - so "who's
 * online" is just "members scored within the last presenceTtlSeconds", with
 * no separate expiry sweep needed: count() prunes the stale ones as part of
 * reading, and a player who never sends another heartbeat simply ages out of
 * the set on their own.
 */

const KEY = 'presence:online';

function touch(userId, now = Date.now()) {
  return redis.client.zAdd(KEY, { score: now, value: String(userId) });
}

// Drops anyone whose last heartbeat is older than the TTL, then reports how
// many remain. Combining the prune with every read means the count is always
// accurate without a background job.
async function count(now = Date.now()) {
  const staleBefore = now - config.presenceTtlSeconds * 1000;
  await redis.client.zRemRangeByScore(KEY, '-inf', staleBefore);
  return redis.client.zCard(KEY);
}

// Single-player check for a profile page. No prune here - a lone zScore read
// is cheap enough on its own and doesn't need to sweep the whole set.
async function isOnline(userId, now = Date.now()) {
  const score = await redis.client.zScore(KEY, String(userId));
  return score !== null && score >= now - config.presenceTtlSeconds * 1000;
}

// Batch version for the leaderboard - one ZMSCORE round trip instead of one
// zScore per row. Returns a Set of the ids (as strings) that are online.
async function onlineSet(userIds, now = Date.now()) {
  const ids = userIds.map(String);
  if (!ids.length) return new Set();

  const staleBefore = now - config.presenceTtlSeconds * 1000;
  const scores = await redis.client.zmScore(KEY, ids);
  const online = new Set();
  ids.forEach((id, i) => {
    if (scores[i] !== null && scores[i] >= staleBefore) online.add(id);
  });
  return online;
}

module.exports = { touch, count, isOnline, onlineSet };
