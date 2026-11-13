const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const redis = require('../db/redis');
const presence = require('../domain/presence');
const matchmaking = require('../domain/matchmaking');
const matches = require('../domain/matches');
const activity = require('../domain/activity');

const EMBED_COLOR = 0x57f287;
// Own prefix, separate from matchmaking.js's 'mm:' - just a message id per
// channel, kept around so a restart edits the same message instead of
// spamming a new one in every refresh cycle.
const MESSAGE_KEY_PREFIX = 'bot:statsMessage:';
// How many regions/maps the "most popular" line names. Three each keeps the
// embed to a glance; /stats has the full ranking.
const POPULAR_SHOWN = 3;

let timer = null;

function messageKey(channelId) {
  return `${MESSAGE_KEY_PREFIX}${channelId}`;
}

// "Europe (2.4), USA East (1.1)" - one line per scope, or null when there is
// nothing to say yet, which is the case for the first week after this ships
// and any time ACTIVITY_SAMPLE_SECONDS is 0.
function popularLine(entries, nameOf) {
  const named = entries.filter((e) => e.total > 0).slice(0, POPULAR_SHOWN);
  if (!named.length) return null;
  return named.map((e) => `${nameOf(e.key)} (${e.total.toFixed(1)})`).join(', ');
}

async function buildEmbed() {
  const [online, regions, weekly] = await Promise.all([
    presence.count(),
    matchmaking.regionStats(),
    activity.popular('weekly'),
  ]);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Mario vs Luigi Ranked - Live Stats')
    .addFields({ name: 'Online', value: `\`\`\`${online} player online\`\`\``, inline: false });

  for (const { region, playing, queuing } of regions) {
    embed.addFields({
      name: matches.displayNameForRegion(region),
      value: `\`🟢 Playing: ${playing}\n🔵 Queuing: ${queuing}\``,
      inline: true,
    });
  }

  // Average concurrent players over the past week, so the embed says something
  // about the game's shape and not only about this exact moment.
  const topRegions = popularLine(weekly.regions, matches.displayNameForRegion);
  const topMaps = popularLine(weekly.maps, matches.displayNameForStage);
  if (topRegions) embed.addFields({ name: 'Most popular regions (7d avg)', value: topRegions, inline: false });
  if (topMaps) embed.addFields({ name: 'Most popular maps (7d avg)', value: topMaps, inline: false });

  embed.setFooter({ text: 'Updated' }).setTimestamp(Date.now());
  return embed;
}

// Reuses one message per channel across refreshes (and across a restart -
// the id lives in redis, same as every other piece of shared runtime state
// this project keeps there) rather than posting a fresh one every interval.
async function upsertMessage(channel) {
  const embed = await buildEmbed();
  const key = messageKey(channel.id);
  const existingId = await redis.client.get(key);

  if (existingId) {
    try {
      const message = await channel.messages.fetch(existingId);
      await message.edit({ embeds: [embed] });
      return;
    } catch (err) {
      // Message was deleted, or the bot lost access to it - fall through and
      // post a fresh one instead of failing the whole refresh.
    }
  }

  const message = await channel.send({ embeds: [embed] });
  await redis.client.set(key, message.id);
}

async function refresh(client) {
  for (const channelId of config.discordStatsChannelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel) await upsertMessage(channel);
    } catch (err) {
      console.error(`Discord stats embed: could not refresh channel ${channelId}:`, err.message);
    }
  }
}

function start(client) {
  if (!config.discordStatsChannelIds.length || timer) return;

  refresh(client).catch((err) => console.error('Discord stats embed: initial refresh failed:', err));
  timer = setInterval(() => {
    refresh(client).catch((err) => console.error('Discord stats embed: refresh failed:', err));
  }, config.discordStatsRefreshSeconds * 1000);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop };
