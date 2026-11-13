const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('../config');
const commands = require('./commands');
const statsBoard = require('./statsBoard');

let client = null;

async function registerCommands() {
  const body = commands.definitions.map((c) => c.toJSON());
  // Guild-scoped registration propagates instantly and is what you want
  // while iterating; global (no DISCORD_GUILD_ID) can take up to an hour to
  // show up everywhere, per Discord's own docs.
  if (config.discordGuildId) {
    await client.application.commands.set(body, config.discordGuildId);
  } else {
    await client.application.commands.set(body);
  }
}

// No privileged intents needed: slash command options and the invoking
// member's permissions both ride along in the interaction payload itself,
// and the stats embed only ever sends/edits messages in channels it's
// explicitly configured for - none of that requires GuildMembers or
// MessageContent.
async function start() {
  if (!config.discordBotToken) {
    console.log('DISCORD_BOT_TOKEN not set - Discord bot disabled.');
    return null;
  }

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Discord bot logged in as ${readyClient.user.tag}`);
    try {
      await registerCommands();
    } catch (err) {
      console.error('Discord bot: failed to register slash commands:', err);
    }
    statsBoard.start(client);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await commands.handle(interaction);
    } catch (err) {
      console.error('Discord bot: interaction handler failed:', err);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong handling that.', ephemeral: true }).catch(() => {});
      }
    }
  });

  await client.login(config.discordBotToken);
  return client;
}

// Powers the site gate (src/domain/siteGate.js) - does a plain REST lookup of
// one member, which (unlike listing/searching all members) needs no
// privileged GuildMembers intent, so the bot's intents above stay untouched.
async function hasRole(guildId, roleId, discordUserId) {
  if (!client) return false;
  try {
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId));
    // force: true - members.fetch() otherwise returns whatever's already in
    // the client's cache without hitting the API, so a role added/removed on
    // Discord after this user's first check would never be seen again until
    // the bot process restarted and the cache started empty.
    const member = await guild.members.fetch({ user: discordUserId, force: true });
    return member.roles.cache.has(roleId);
  } catch (err) {
    // Unknown Member/User (10007/10013) just means they're not in the guild.
    if (err.code === 10007 || err.code === 10013) return false;
    console.error('Discord bot: role check failed:', err);
    return false;
  }
}

function stop() {
  statsBoard.stop();
  if (client) {
    client.destroy();
    client = null;
  }
}

module.exports = { start, stop, hasRole };
