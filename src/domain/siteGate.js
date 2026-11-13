const config = require('../config');
const discordBot = require('../bot/client');

// Effectively off unless every piece it needs is actually configured, so a
// deployment that sets SITE_GATE_ENABLED=true but never got around to the
// role id (or the bot) doesn't lock everyone out by accident.
function configured() {
  return Boolean(
    config.siteGateEnabled
    && config.siteGateRoleId
    && config.discordGuildId
    && config.discordBotToken,
  );
}

async function isAuthorized(discordId) {
  if (!configured()) return true;
  if (!discordId) return false;
  return discordBot.hasRole(config.discordGuildId, config.siteGateRoleId, discordId);
}

module.exports = { configured, isAuthorized };
