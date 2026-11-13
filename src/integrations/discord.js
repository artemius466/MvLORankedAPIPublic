const config = require('../config');

const API = 'https://discord.com/api/v10';
const SCOPE = 'identify';

class DiscordError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
  }
}

function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: config.discordClientID,
    redirect_uri: config.discordRedirectUri,
    response_type: 'code',
    scope: SCOPE,
    prompt: 'none',
    state,
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.discordClientID,
      client_secret: config.discordClientSecret,
      ...body,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new DiscordError(data.error_description || data.error || 'Discord token request failed', res.status);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // expires_in is seconds from now.
    expiresAt: new Date(Date.now() + (Number(data.expires_in) || 0) * 1000),
  };
}

function exchangeCode(code) {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.discordRedirectUri,
  });
}

function refreshAccessToken(refreshToken) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function fetchCurrentUser(accessToken) {
  const res = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new DiscordError('Failed to fetch the Discord profile', res.status);
  }
  return res.json();
}

// Animated avatars are served as .gif and their hash is prefixed with a_.
function avatarUrl(discordId, avatarHash, size = 128) {
  if (!avatarHash) {
    const index = (BigInt(discordId) >> 22n) % 6n;
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.${ext}?size=${size}`;
}

module.exports = {
  DiscordError,
  authorizeUrl,
  exchangeCode,
  refreshAccessToken,
  fetchCurrentUser,
  avatarUrl,
};
