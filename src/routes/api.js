const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const discord = require('../integrations/discord');
const sessions = require('../auth/sessions');
const users = require('../domain/users');
const matches = require('../domain/matches');
const matchmaking = require('../domain/matchmaking');
const deviceLogin = require('../auth/deviceLogin');
const countries = require('../domain/countries');
const presence = require('../domain/presence');
const siteGate = require('../domain/siteGate');
const announcements = require('../domain/announcements');

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  // Header only - a token in the query string would end up in access logs.
  return scheme && scheme.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

// Populates req.user / req.token when a valid session token is present.
async function loadUser(req, res, next) {
  try {
    const token = bearerToken(req);
    const session = await sessions.resolve(token);
    if (session) {
      const row = await users.findById(session.user_id);
      if (row) {
        req.token = token;
        req.user = row;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}

// The frontend reads the token out of the URL fragment: it never reaches a
// server log or a Referer header the way a query parameter would.
function frontendRedirect(fragment) {
  const base = config.frontendUrl.endsWith('/') ? config.frontendUrl : `${config.frontendUrl}/`;
  return `${base}#${fragment}`;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractPhotonToken(req) {
  const fromQuery = req.query && (req.query.photonToken || req.query.photontoken || req.query.photon_token);
  const fromBody = req.body && (req.body.photonToken || req.body.photontoken || req.body.photon_token);
  const fromHeaders = req.headers && (req.headers['x-photon-token'] || req.headers['photontoken']);
  const raw = fromQuery || fromBody || fromHeaders;
  return typeof raw === 'string' ? raw.trim() : null;
}

// --- Photon Custom Server Authentication ----------------------------------
// Called by Photon Cloud/Server when a game client connects with Custom Authentication.
// Photon forwards query parameters or POST data (JSON or form-urlencoded).
//
// Expected JSON responses per Photon documentation:
//   ResultCode 1: Success (includes UserId, Nickname, optional Data)
//   ResultCode 2: Failed (invalid/expired credentials, or player is banned)
//   ResultCode 3: Invalid parameters (missing token)
const photonAuthHandler = async (req, res, next) => {
  try {
    const photonToken = extractPhotonToken(req);

    if (!config.photonToken) {
      return res.json({
        ResultCode: 2,
        Message: 'PHOTON_TOKEN is not configured on the server.',
      });
    }

    if (!photonToken) {
      return res.json({
        ResultCode: 3,
        Message: 'Missing photonToken parameter.',
      });
    }

    if (!timingSafeEqualStr(photonToken, config.photonToken)) {
      return res.json({
        ResultCode: 2,
        Message: 'Invalid photonToken.',
      });
    }

    const rawToken = (req.body && (req.body.token || req.body.data || req.body.sessionToken || req.body.session))
      || req.query.token
      || req.query.data
      || req.query.sessionToken
      || req.query.session
      || bearerToken(req);

    const token = typeof rawToken === 'string' ? rawToken.trim() : null;

    if (!token) {
      return res.json({
        ResultCode: 3,
        Message: 'Missing session token.',
      });
    }

    let user = null;
    if (req.user && req.token === token) {
      user = req.user;
    } else {
      const session = await sessions.resolve(token);
      if (!session) {
        return res.json({
          ResultCode: 2,
          Message: 'Invalid or expired session token.',
        });
      }
      user = await users.findById(session.user_id);
      if (!user) {
        return res.json({
          ResultCode: 2,
          Message: 'User not found.',
        });
      }
    }

    const ban = users.getBanStatus(user);
    if (ban) {
      const hoursText = `${ban.hoursLeft} hour${ban.hoursLeft === 1 ? '' : 's'}`;
      return res.json({
        ResultCode: 2,
        Message: `You are banned from playing.\nReason: ${ban.reason}\nTime left: ${hoursText}.`,
      });
    }

    res.json({
      ResultCode: 1,
      UserId: String(user.discord_id),
      Nickname: user.display_name || user.username,
      Data: {
        elo: Math.round(user.elo),
        username: user.username,
        displayName: user.display_name || user.username,
      },
    });
  } catch (err) {
    next(err);
  }
};

// --- Game Client Pre-flight Authentication (AuthenticationHandler.Authenticate) ---
// Handshake endpoint called by NSMB.Networking.AuthenticationHandler.Authenticate()
// URL: /auth/init or /api/auth/init
//
// Query parameters:
//   userid: string (PlayerPrefs "id", optional)
//   token: string (PlayerPrefs "token", optional)
//   args: byte (client settings flags, optional)
//
// Responses:
//   HTTP 200: JSON string containing token (Unity strips quotes and passes it as values.AddAuthParameter("data", result))
//   HTTP 403: JSON BanMessage { Id, Message, Expiration } (Unity shows in-game ban dialog)
//   HTTP 401: JSON BanMessage { Id: 0, Message: '...', Expiration: null } (Missing or expired session)
const authInitHandler = async (req, res, next) => {
  try {
    const rawToken = (req.body && (req.body.token || req.body.sessionToken || req.body.session))
      || req.query.token
      || req.query.sessionToken
      || req.query.session
      || bearerToken(req);

    const token = typeof rawToken === 'string' ? rawToken.trim() : null;
    const rawUserId = req.query.userid || req.query.userId || (req.body && (req.body.userid || req.body.userId));
    const userId = typeof rawUserId === 'string' ? rawUserId.trim() : null;

    // Development backdoor when devLoginEnabled and token is omitted (e.g. IsDevelopmentBuild in Unity)
    if (!token && config.devLoginEnabled) {
      const devId = (userId && /^[0-9]{1,19}$/.test(userId)) ? userId : '1';
      const profile = { id: devId, username: `dev_user_${devId}`, global_name: `Dev User ${devId}`, avatar: null };
      const row = await users.upsertFromDiscord(profile, { accessToken: null, refreshToken: null, expiresAt: null });
      const session = await sessions.create(row.discord_id);
      return res.json(session.token);
    }

    if (!token) {
      return res.status(401).json({
        Id: 0,
        Message: 'Missing session token. Please sign in first.',
        Expiration: null,
      });
    }

    const session = await sessions.resolve(token);
    if (!session) {
      return res.status(401).json({
        Id: 0,
        Message: 'Invalid or expired session token. Please sign in again.',
        Expiration: null,
      });
    }

    if (userId && String(session.user_id) !== String(userId)) {
      return res.status(403).json({
        Id: 0,
        Message: 'Session token does not match user ID.',
        Expiration: null,
      });
    }

    const user = await users.findById(session.user_id);
    if (!user) {
      return res.status(401).json({
        Id: 0,
        Message: 'User not found.',
        Expiration: null,
      });
    }

    const ban = users.getBanStatus(user);
    if (ban) {
      const expirationSec = ban.bannedUntil
        ? Math.floor(new Date(ban.bannedUntil).getTime() / 1000)
        : null;
      return res.status(403).json({
        Id: 1,
        Message: ban.reason,
        Expiration: expirationSec,
      });
    }

    res.json(token);
  } catch (err) {
    next(err);
  }
};

function buildApiRouter() {
  const router = express.Router();

  router.use(loadUser);

  router.get('/health', (req, res) => res.json({ ok: true }));

  // Public announcements endpoint compatible with Unity game client
  // and the web frontend.
  router.get('/announcements', async (req, res, next) => {
    try {
      const rows = await announcements.listAll();
      res.json(rows.map(announcements.toUnity));
    } catch (err) {
      next(err);
    }
  });

  // Powers the frontend site gate (frontend/js/gate.js) - NOT auth for the
  // API itself. Every other route in this file is reachable exactly as
  // before regardless of what this returns; it only tells the frontend
  // whether to show its own pages or a "no access" screen. No session
  // required to call it - an anonymous caller is simply reported as not
  // authorized, same as a logged-in one missing the role.
  router.get('/access', async (req, res, next) => {
    try {
      const enabled = siteGate.configured();
      const authorized = enabled ? await siteGate.isAuthorized(req.user && req.user.discord_id) : true;
      res.json({
        enabled,
        loggedIn: Boolean(req.user),
        authorized,
        discordInvite: config.siteGateDiscordInvite || null,
      });
    } catch (err) {
      next(err);
    }
  });

  // Step 1: the client (web or game) asks where to send the user. Both flows
  // share this endpoint - the state it returns is also the key a game client
  // polls on below.
  router.get('/login', async (req, res, next) => {
    try {
      if (!config.discordClientID || !config.discordClientSecret) {
        return res.status(500).json({ error: 'Discord OAuth is not configured' });
      }
      const state = await sessions.createOAuthState();
      res.json({ url: discord.authorizeUrl(state), state });
    } catch (err) {
      next(err);
    }
  });

  // Step 2: Discord sends the browser back here with a one-time code. The
  // state check runs first for every branch (moved ahead of the error/
  // missing_code short-circuits that used to skip it) so a device_logins row
  // is only ever written for a state we actually issued and have not yet
  // consumed.
  router.get('/callback', async (req, res) => {
    const { code, state: rawState, error } = req.query;
    const state = typeof rawState === 'string' ? rawState : null;

    if (!(await sessions.consumeOAuthState(state))) {
      return res.redirect(frontendRedirect('error=invalid_state'));
    }

    if (error) {
      await deviceLogin.recordError(state, String(error));
      return res.redirect(frontendRedirect(`error=${encodeURIComponent(String(error))}`));
    }
    if (!code) {
      await deviceLogin.recordError(state, 'missing_code');
      return res.redirect(frontendRedirect('error=missing_code'));
    }

    try {
      const tokens = await discord.exchangeCode(String(code));
      const profile = await discord.fetchCurrentUser(tokens.accessToken);
      const row = await users.upsertFromDiscord(profile, tokens);
      const session = await sessions.create(row.discord_id);

      await deviceLogin.recordSuccess(state, session.token, row.discord_id);
      res.redirect(frontendRedirect(`token=${encodeURIComponent(session.token)}`));
    } catch (err) {
      console.error('OAuth callback failed:', err);
      await deviceLogin.recordError(state, 'login_failed');
      res.redirect(frontendRedirect('error=login_failed'));
    }
  });

  // Step 3 (game clients only): poll with the state from /login until the
  // browser round trip above finishes. The web frontend never calls this -
  // it reads the token out of the redirect fragment instead.
  router.get('/login/poll', async (req, res, next) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : null;
      if (!state) return res.status(400).json({ error: 'Missing state.' });

      const result = await deviceLogin.claim(state);
      if (!result) return res.json({ status: 'pending' });
      if (result.error) return res.json({ status: 'error', error: result.error });

      const user = await users.findById(result.user_id);
      res.json({ status: 'complete', token: result.token, user: users.toPublic(user) });
    } catch (err) {
      next(err);
    }
  });

  // Dev-only backdoor: mints a real session for a fake, numeric-id user with no
  // Discord round trip at all, so matchmaking (which needs two accounts at
  // once) can be exercised locally without two Discord logins. Only mounted
  // when config.devLoginEnabled - i.e. never in production - so this route is
  // a 404 rather than an auth bypass anywhere it matters.
  if (config.devLoginEnabled) {
    router.get('/dev-login', async (req, res, next) => {
      try {
        const id = typeof req.query.id === 'string' && req.query.id.trim() ? req.query.id.trim() : '1';
        // Must parse as a BigInt snowflake - discord.avatarUrl() does that for
        // any user with no avatar hash, which every dev user has.
        if (!/^[0-9]{1,19}$/.test(id)) {
          return res.status(400).json({ error: 'id must be a numeric string, e.g. ?id=1' });
        }

        const profile = { id, username: `dev_user_${id}`, global_name: `Dev User ${id}`, avatar: null };
        const row = await users.upsertFromDiscord(profile, { accessToken: null, refreshToken: null, expiresAt: null });
        const session = await sessions.create(row.discord_id);
        res.json({ token: session.token, user: users.toPublic(row) });
      } catch (err) {
        next(err);
      }
    });
  }

  router.all(['/auth/photon', '/photon/auth'], photonAuthHandler);
  router.all(['/auth/init', '/init'], authInitHandler);

  // Cached profile without refreshing
  // Also I changed /me -> /me/v2 so old clients would just say that they cant login
  // TODO: Implement real update checker (later ofc) in anticheat
  router.get('/me/v2', requireUser, (req, res) => {
    res.json({ user: users.toPublic(req.user) });
  });

  // Called on every page load; only actually checks Discord once the cached
  // profile is older than config.profileRefreshMinutes.
  router.post('/refresh', requireUser, async (req, res, next) => {
    try {
      const { user, refreshed, error } = await users.refreshProfile(req.user);
      res.json({
        user: users.toPublic(user),
        refreshed,
        refreshIntervalMinutes: config.profileRefreshMinutes,
        ...(error ? { warning: error } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      await sessions.destroy(req.token);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  const BIO_MAX_LENGTH = 280;

  // Profile settings: the bio shown on this player's public profile
  // (GET /users/:id) and their leaderboard row. `bio: null` clears it.
  router.put('/me/bio', requireUser, async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.bio !== null && typeof body.bio !== 'string') {
        return res.status(400).json({ error: '`bio` must be a string or null.' });
      }
      const bio = typeof body.bio === 'string' ? body.bio.trim() : null;
      if (bio && bio.length > BIO_MAX_LENGTH) {
        return res.status(400).json({ error: `bio must be at most ${BIO_MAX_LENGTH} characters.` });
      }
      const user = await users.updateBio(req.user.discord_id, bio || null);
      res.json({ user: users.toPublic(user) });
    } catch (err) {
      next(err);
    }
  });

  // Profile settings: the country flag shown next to this player's name on
  // their public profile and their leaderboard row, same spots as bio above.
  // `country: null` clears it. The code must be one of countries.CODES (an
  // ISO 3166-1 alpha-2 code, e.g. "JP") - anything else is rejected rather
  // than stored and left to render as nothing.
  router.put('/me/country', requireUser, async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.country !== null && typeof body.country !== 'string') {
        return res.status(400).json({ error: '`country` must be a string or null.' });
      }
      const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : null;
      if (country && !countries.isValid(country)) {
        return res.status(400).json({ error: 'Unknown country code.' });
      }
      const user = await users.updateCountry(req.user.discord_id, country || null);
      res.json({ user: users.toPublic(user) });
    } catch (err) {
      next(err);
    }
  });

  // --- Session management ----------------------------------------------------
  // Powers the "sessions" panel in profile settings - every device the caller
  // is currently logged in on, so they can spot and kick a stale or unknown
  // one without having to change their Discord password to do it.

  router.get('/sessions', requireUser, async (req, res, next) => {
    try {
      res.json({ sessions: await sessions.list(req.user.discord_id, req.token) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/sessions/:id', requireUser, async (req, res, next) => {
    try {
      const destroyed = await sessions.destroyById(req.user.discord_id, req.params.id);
      if (!destroyed) return res.status(404).json({ error: 'Session not found.' });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Leaves the caller's own current session (the one this request
  // authenticated with) alone - a "log out everywhere else" button.
  router.post('/sessions/logout-others', requireUser, async (req, res, next) => {
    try {
      const revoked = await sessions.destroyOthers(req.user.discord_id, req.token);
      res.json({ revoked });
    } catch (err) {
      next(err);
    }
  });

  // Public leaderboard - no session required. `offset` pages through the
  // ranking - e.g. limit=10&offset=10 is page 2.
  router.get('/leaderboard', async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const data = await users.leaderboard(limit, offset);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // Public profile lookup backing /user/:id - no session required.
  router.get('/users/:id', async (req, res, next) => {
    try {
      const user = await users.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const online = await presence.isOnline(user.discord_id);
      res.json({ user: users.toPublic(user, online) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/users/:id/matches', async (req, res, next) => {
    try {
      const user = await users.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found.' });

      const limit = Math.min(matches.HISTORY_SIZE, Math.max(1, parseInt(req.query.limit, 10) || matches.HISTORY_SIZE));
      const rows = await matches.listForUser(user.discord_id, limit);
      res.json({ matches: rows });
    } catch (err) {
      next(err);
    }
  });

  // Detailed view of a single match, both sides at once - what clicking a row
  // in match history opens. No session required, same as the endpoints above.
  router.get('/matches/:matchUid', async (req, res, next) => {
    try {
      const rows = await matches.getByMatchUid(req.params.matchUid);
      const detail = matches.toDetail(rows);
      if (!detail) return res.status(404).json({ error: 'Match not found.' });

      // Prefer each player's live profile (current name/avatar) when they
      // still have one; opponents who never logged in only ever have the
      // name matches.js snapshotted, plus their computed default avatar.
      const liveUsers = await Promise.all(detail.players.map((p) => users.findById(p.id)));
      detail.players = detail.players.map((p, i) => {
        const live = liveUsers[i];
        return {
          id: p.id,
          name: live ? live.display_name : p.name,
          avatarUrl: discord.avatarUrl(p.id, live ? live.avatar_hash : null),
          eloDelta: p.eloDelta,
          replayUrl: p.replayUrl,
        };
      });

      res.json({ match: detail });
    } catch (err) {
      next(err);
    }
  });

  // --- Presence --------------------------------------------------------------

  // Heartbeat: game clients call this every 30s while running. Requires a
  // session so the count below can't be inflated by anonymous pings.
  router.post('/online', requireUser, async (req, res, next) => {
    try {
      await presence.touch(req.user.discord_id);
      res.json({ online: await presence.count() });
    } catch (err) {
      next(err);
    }
  });

  // Public read for the frontend's online counter - no session required.
  router.get('/online', async (req, res, next) => {
    try {
      res.json({ online: await presence.count() });
    } catch (err) {
      next(err);
    }
  });

  // --- Matchmaking ---------------------------------------------------------
  // Queue/match state lives in redis (see src/domain/matchmaking.js). Every
  // route needs a session because the queue is keyed by the caller's discord
  // id. A postgres row (and a real elo change) only happens once a match
  // reaches "playing" and is settled one way or another - see alive() there.
  //
  // The flow a client walks:
  //   POST /matchmaking/queue   -> GET /matchmaking/poll  (until "found")
  //   POST /matchmaking/accept  -> GET /matchmaking/match (until "ready")
  //   map veto: POST /matchmaking/ban, in turn, until /matchmaking/match
  //   reports the map decided (host bans 2, then the guest bans 1)
  //   host: POST /matchmaking/room   guest: keep polling /matchmaking/match
  //   both: POST /matchmaking/alive, continuously, until /matchmaking/match
  //   reports "ended"
  // with POST /matchmaking/decline and POST /matchmaking/cancel as the exits
  // (cancelling a "playing" match forfeits it instead of a free walkout).

  // Ping readings travel on every poll as well as on the initial queue call,
  // because they decide which regions a pairing is still possible on and may
  // well have changed by the time a match forms. One reading per region,
  // comma-separated in query-string position order.
  function pingsParam(req) {
    if (typeof req.query.pings !== 'string') return undefined;
    return req.query.pings.split(',').map((v) => Number(v));
  }

  function maxPingParam(req) {
    return req.query.maxPing === undefined ? undefined : req.query.maxPing;
  }

  // Read-only wait estimate for a client deciding whether to queue at all -
  // no session needed, since it touches no ticket of its own. Maps no longer
  // factor in (see src/domain/matchmaking.js's map veto section) - there is
  // nothing left to choose before queuing.
  router.get('/matchmaking/estimate', async (req, res, next) => {
    try {
      res.json(await matchmaking.estimateWait());
    } catch (err) {
      next(err);
    }
  });

  // The full map pool a match can be played on, for a client that wants to
  // show it (e.g. ahead of the veto) - no session needed.
  router.get('/matchmaking/maps', (req, res) => {
    res.json({ maps: matchmaking.MAPS });
  });

  // 1. Start searching.
  router.post('/matchmaking/queue', requireUser, async (req, res, next) => {
    try {
      const ban = users.getBanStatus(req.user);
      if (ban) {
        const hoursText = `${ban.hoursLeft} hour${ban.hoursLeft === 1 ? '' : 's'}`;
        return res.status(400).json({
          error: `You are banned from matchmaking.\nReason: ${ban.reason}\nTime left: ${hoursText}.`,
          code: 'banned',
        });
      }

      const options = matchmaking.parseOptions(req.body);
      if (options.version != '1.0.2') {
        return res.status(400).json({ error: 'You\'re using an old version of MvLO Ranked.\nGo to itch.io and download the new build.\nDiscord: https://dsc.gg/mvlranked', code: 'version_old' });
      }

      const result = await matchmaking.enqueue(req.user, options);
      if (!result.ok) {
        const errors = {
          match_in_progress: 'You are already in a match. Accept, decline or cancel it first.',
          already_queued: 'You are already queued. Cancel first if you want to change your options.',
        };
        return res.status(409).json({ error: errors[result.code], code: result.code });
      }
      res.json(result.status);
    } catch (err) {
      next(err);
    }
  });

  // 2. Poll while searching: "searching" | "found" | "idle".
  router.get('/matchmaking/poll', requireUser, async (req, res, next) => {
    try {
      const ban = users.getBanStatus(req.user);
      if (ban) {
        await matchmaking.leave(req.user.discord_id);
        return res.json({ status: 'idle' });
      }
      res.json(await matchmaking.status(req.user.discord_id, Date.now(), pingsParam(req), maxPingParam(req)));
    } catch (err) {
      next(err);
    }
  });

  // 3. Accept the match that /matchmaking/poll reported.
  router.post('/matchmaking/accept', requireUser, async (req, res, next) => {
    try {
      const result = await matchmaking.respond(req.user.discord_id, true);
      if (!result.ok) return res.status(409).json({ error: 'No match to accept.', code: result.code });
      res.json(result.status);
    } catch (err) {
      next(err);
    }
  });

  // 4. Decline it - this also drops you out of the queue.
  router.post('/matchmaking/decline', requireUser, async (req, res, next) => {
    try {
      const result = await matchmaking.respond(req.user.discord_id, false);
      if (!result.ok) return res.status(409).json({ error: 'No match to decline.', code: result.code });
      res.json(result.status);
    } catch (err) {
      next(err);
    }
  });

  // 5. Poll after accepting: "waiting" | "ready" | "ended" | "none". Both the
  // host and the guest stay on this one; the guest reads roomCode from it.
  router.get('/matchmaking/match', requireUser, async (req, res, next) => {
    try {
      res.json(await matchmaking.matchStatus(req.user.discord_id, Date.now(), pingsParam(req), maxPingParam(req)));
    } catch (err) {
      next(err);
    }
  });

  // 6. The map veto: ban one map, if it's your turn. The host bans first,
  // twice; then the guest bans once; whatever's left is the map. Repeats on
  // /matchmaking/match's "ready" payload as `mapVeto` until `match.map` is
  // filled in - see src/domain/matchmaking.js's map veto section.
  router.post('/matchmaking/ban', requireUser, async (req, res, next) => {
    try {
      const mapId = req.body && typeof req.body.mapId === 'string' ? req.body.mapId.trim() : '';
      if (!mapId) return res.status(400).json({ error: '`mapId` is required.' });

      const result = await matchmaking.banMap(req.user.discord_id, mapId);
      if (!result.ok) {
        const status = result.code === 'not_your_turn' ? 403
          : result.code === 'unknown_map' ? 400
          : 409;
        return res.status(status).json({ error: 'Could not ban that map.', code: result.code });
      }
      res.json(result.status);
    } catch (err) {
      next(err);
    }
  });

  // 7. Host only, once the map veto above has settled: publish the Photon
  // room code for the guest to pick up.
  router.post('/matchmaking/room', requireUser, async (req, res, next) => {
    try {
      const result = await matchmaking.publishRoomCode(req.user.discord_id, req.body && req.body.roomCode);
      if (!result.ok) {
        const status = result.code === 'not_host' ? 403 : result.code === 'invalid_room_code' ? 400 : 409;
        return res.status(status).json({ error: 'Could not publish the room code.', code: result.code });
      }
      res.json(result.status);
    } catch (err) {
      next(err);
    }
  });

  // 8. Heartbeat sent throughout actual gameplay. Include `result` once your
  // own game has concluded: true if the host won, false if the other player
  // did. `replayUrl` may ride along with it - the replay itself is uploaded
  // to whatever external service the client uses; this just records where it
  // landed, same as the client would hand a CDN URL to any other endpoint.
  router.post('/matchmaking/alive', requireUser, async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.result !== undefined && typeof body.result !== 'boolean') {
        return res.status(400).json({ error: '`result` must be a boolean.' });
      }
      if (body.replayUrl !== undefined) {
        if (typeof body.replayUrl !== 'string' || !body.replayUrl.trim() || body.replayUrl.length > 2048) {
          return res.status(400).json({ error: '`replayUrl` must be a non-empty string, at most 2048 characters.' });
        }
        if (body.result === undefined) {
          return res.status(400).json({ error: '`replayUrl` may only be sent together with `result`.' });
        }
      }

      const replayUrl = typeof body.replayUrl === 'string' ? body.replayUrl.trim() : undefined;
      const result = await matchmaking.alive(req.user.discord_id, body.result, replayUrl);
      if (!result.ok) {
        return res.status(409).json({ error: 'No active match to report on.', code: result.code });
      }
      res.json(result.status);
    } catch (err) {
      next(err);
    }
  });

  // 9. Leave the queue, or walk away from a match that was already found.
  router.post('/matchmaking/cancel', requireUser, async (req, res, next) => {
    try {
      res.json(await matchmaking.leave(req.user.discord_id));
    } catch (err) {
      next(err);
    }
  });

  router.use((req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

  return router;
}

module.exports = { buildApiRouter, loadUser, requireUser, authInitHandler, photonAuthHandler };
