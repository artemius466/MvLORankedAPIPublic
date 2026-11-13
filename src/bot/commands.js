const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const users = require('../domain/users');
const matchesDomain = require('../domain/matches');
const matchmaking = require('../domain/matchmaking');
const presence = require('../domain/presence');
const activity = require('../domain/activity');
const discord = require('../integrations/discord');

const EMBED_COLOR = 0x5865f2;
const REVERTED_COLOR = 0xed4245;

// Both slash commands are admin-only. setDefaultMemberPermissions() hides
// them from non-admins in Discord's own UI (a guild owner can loosen that in
// Integrations settings), so isAdmin() below re-checks at call time too -
// the actual gate, not just a UI hint.
const playerCommand = new SlashCommandBuilder()
  .setName('player')
  .setDescription("Look up a player's ranked profile and match history.")
  .addUserOption((opt) => opt.setName('user').setDescription('The player to look up').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const matchCommand = new SlashCommandBuilder()
  .setName('match')
  .setDescription('Look up a match by its match ID. Admins can revert it from here.')
  .addStringOption((opt) => opt.setName('id').setDescription('The match ID (matchUid)').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

// Deliberately not admin-only, unlike the two above: nothing in it is
// privileged, it is about the community rather than any individual, and the
// numbers are the kind of thing people enjoy arguing about.
const statsCommand = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Most popular regions and maps, by average players online.')
  .addStringOption((opt) => opt
    .setName('window')
    .setDescription('How far back to average over (default: this week)')
    .addChoices(
      { name: 'Today', value: 'daily' },
      { name: 'This week', value: 'weekly' },
      { name: 'This month', value: 'monthly' },
    ));

const definitions = [playerCommand, matchCommand, statsCommand];

// interaction.memberPermissions is only populated for guild interactions, so
// this is also what refuses a DM (or a bot-permission-check-caching edge
// case) without a separate dmPermission flag to keep in sync.
function isAdmin(interaction) {
  return Boolean(interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function denyNotAdmin(interaction) {
  return interaction.reply({
    content: 'You need the Administrator permission to use this command.',
    flags: MessageFlags.Ephemeral,
  });
}

function eloDeltaText(delta) {
  return delta > 0 ? `+${delta}` : String(delta);
}

function unixSeconds(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function buildPlayerEmbed(row, online, recentMatches) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(row.display_name)
    .setThumbnail(discord.avatarUrl(row.discord_id, row.avatar_hash))
    .addFields(
      { name: 'Discord', value: `<@${row.discord_id}> (\`${row.discord_id}\`)` },
      { name: 'Online', value: online ? 'Yes' : 'No', inline: true },
      // Rounded for the same reason users.toPublic() rounds - ratings are
      // fractional in the database but whole numbers everywhere they are shown.
      { name: 'Elo', value: String(Math.round(row.elo)), inline: true },
    )
    .setFooter({ text: 'Joined' })
    .setTimestamp(new Date(row.created_at));

  if (recentMatches.length) {
    const lines = recentMatches.map((m) => {
      const stage = matchesDomain.displayNameForStage(m.stage);
      return `\`${m.matchUid}\` vs **${m.opponentName}** - ${eloDeltaText(m.eloDelta)} - ${stage} - <t:${unixSeconds(m.playedAt)}:R>`;
    });
    // Embed field values are capped at 1024 chars by Discord - recentMatches
    // is already limited to 10 rows (see handlePlayer), which comfortably fits.
    embed.addFields({ name: `Recent matches (${recentMatches.length})`, value: lines.join('\n').slice(0, 1024) });
  } else {
    embed.addFields({ name: 'Recent matches', value: 'No matches recorded yet.' });
  }

  return embed;
}

async function handlePlayer(interaction) {
  if (!isAdmin(interaction)) return denyNotAdmin(interaction);

  const target = interaction.options.getUser('user', true);
  const row = await users.findById(target.id);
  if (!row) {
    return interaction.reply({
      content: `${target} has not logged into the ranked API yet.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const [online, recentMatches] = await Promise.all([
    presence.isOnline(row.discord_id),
    matchesDomain.listForUser(row.discord_id, 10),
  ]);

  await interaction.reply({ embeds: [buildPlayerEmbed(row, online, recentMatches)], flags: MessageFlags.Ephemeral });
}

function buildMatchEmbed(detail) {
  const embed = new EmbedBuilder()
    .setColor(detail.revertedAt ? REVERTED_COLOR : EMBED_COLOR)
    .setTitle(`Match ${detail.matchUid}`)
    .addFields(
      { name: 'Stage', value: matchesDomain.displayNameForStage(detail.stage), inline: true },
      { name: 'Played', value: `<t:${unixSeconds(detail.playedAt)}:R>`, inline: true },
    );

  for (const player of detail.players) {
    const replay = player.replayUrl ? `\n[Replay](${player.replayUrl})` : '';
    embed.addFields({
      name: player.name || player.id,
      value: `<@${player.id}>\nElo change: ${eloDeltaText(player.eloDelta)}${replay}`,
      inline: true,
    });
  }

  if (detail.revertedAt) {
    const reason = detail.revertReason ? `\nReason: ${detail.revertReason}` : '';
    embed.addFields({
      name: 'Reverted',
      value: `By <@${detail.revertedBy}> <t:${unixSeconds(detail.revertedAt)}:R>${reason}`,
    });
  }

  return embed;
}

function revertRow(matchUid, confirming) {
  const row = new ActionRowBuilder();
  if (confirming) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`revert:confirm:${matchUid}`).setLabel('Confirm revert').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`revert:cancel:${matchUid}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId(`revert:ask:${matchUid}`).setLabel('Revert match').setStyle(ButtonStyle.Danger),
    );
  }
  return row;
}

async function handleMatch(interaction) {
  if (!isAdmin(interaction)) return denyNotAdmin(interaction);

  const matchUid = interaction.options.getString('id', true).trim();
  const rows = await matchesDomain.getByMatchUid(matchUid);
  const detail = matchesDomain.toDetail(rows);
  if (!detail) {
    return interaction.reply({ content: `No match found with id \`${matchUid}\`.`, flags: MessageFlags.Ephemeral });
  }

  const components = detail.revertedAt ? [] : [revertRow(matchUid, false)];
  await interaction.reply({ embeds: [buildMatchEmbed(detail)], components, flags: MessageFlags.Ephemeral });
}

// The three revert:<action>:<matchUid> buttons above - look-then-confirm
// rather than a bare /revert-match <id> command, so an admin always sees the
// match (via /match) before touching its elo.
async function handleRevertButton(interaction, action, matchUid) {
  if (!isAdmin(interaction)) return denyNotAdmin(interaction);

  if (action === 'ask') {
    return interaction.update({
      content: `Revert match \`${matchUid}\`? This reverses both players' elo change from this match and cannot be undone from Discord.`,
      embeds: [],
      components: [revertRow(matchUid, true)],
    });
  }

  if (action === 'cancel') {
    return interaction.update({ content: 'Revert cancelled.', embeds: [], components: [] });
  }

  if (action === 'confirm') {
    const result = await matchmaking.revertMatch(matchUid, interaction.user.id);
    if (!result.ok) {
      const messages = {
        not_found: 'That match no longer exists.',
        already_reverted: 'That match was already reverted.',
      };
      return interaction.update({ content: messages[result.code] || 'Could not revert that match.', components: [] });
    }

    const rows = await matchesDomain.getByMatchUid(matchUid);
    const detail = matchesDomain.toDetail(rows);
    return interaction.update({
      content: `Match \`${matchUid}\` reverted - elo changes for both players have been undone.`,
      embeds: detail ? [buildMatchEmbed(detail)] : [],
      components: [],
    });
  }
}

const WINDOW_LABELS = { daily: 'today', weekly: 'the past 7 days', monthly: 'the past 30 days' };

// A ranked list as one embed field. Averages are of concurrent players, so
// they are fractional and small - one decimal is the right resolution, and
// padding the numbers keeps the column readable in Discord's proportional font
// only because the whole block is fenced.
function popularField(name, entries, nameOf) {
  const ranked = entries.filter((entry) => entry.total > 0).slice(0, 10);
  if (!ranked.length) return { name, value: 'No activity recorded yet.' };

  const lines = ranked.map((entry, i) => {
    const label = nameOf(entry.key).padEnd(18);
    return `${String(i + 1).padStart(2)}. ${label} ${entry.total.toFixed(1).padStart(5)}`
      + `  (playing ${entry.playing.toFixed(1)}, queuing ${entry.queuing.toFixed(1)})`;
  });
  return { name, value: `\`\`\`\n${lines.join('\n').slice(0, 1000)}\n\`\`\`` };
}

async function handleStats(interaction) {
  const window = activity.parseWindow(interaction.options.getString('window')) || 'weekly';
  const popular = await activity.popular(window);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`Most popular - ${WINDOW_LABELS[window]}`)
    .setDescription(
      'Average number of players on each region and map at any given moment. '
      + 'A player waiting in queue counts towards every region and map they '
      + 'would accept, so these add up to more than the number of players.',
    )
    .addFields(
      popularField('Regions', popular.regions, matchesDomain.displayNameForRegion),
      popularField('Maps', popular.maps, matchesDomain.displayNameForStage),
    );

  await interaction.reply({ embeds: [embed] });
}

async function handle(interaction) {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'player') return handlePlayer(interaction);
    if (interaction.commandName === 'match') return handleMatch(interaction);
    if (interaction.commandName === 'stats') return handleStats(interaction);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('revert:')) {
    const [, action, matchUid] = interaction.customId.split(':');
    return handleRevertButton(interaction, action, matchUid);
  }
}

module.exports = { definitions, handle };
