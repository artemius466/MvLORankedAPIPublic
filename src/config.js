function int(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// int() never actually rounded - it is "a finite number, or this fallback".
// The Glicko-2 knobs below are genuinely fractional, so they call it under a
// name that does not promise otherwise rather than through a second copy.
const num = int;

// Defaults to 'production' when unset, not 'development' - anything gated on
// devLoginEnabled below must stay off unless a deployment opts in on purpose.
const env = process.env.NODE_ENV || 'production';

module.exports = {
  port: int(process.env.PORT, 3000),
  env,
  // Unlocks GET /api/dev-login (see src/routes/api.js), which mints a real
  // session for any numeric id with no Discord round trip at all - strictly a
  // local testing aid for exercising matchmaking with two accounts at once.
  devLoginEnabled: env !== 'production',

  discordClientID: process.env.DISCORD_CLIENT_ID || '',
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET,
  discordRedirectUri: process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/api/callback',

  // --- Discord bot ----------------------------------------------------------
  // Separate from the OAuth client above - this is the bot user's own login
  // token. Blank disables the bot entirely (see src/bot/client.js), so an
  // existing deployment with no bot configured keeps working unchanged.
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  // Slash commands registered to a single guild propagate instantly; left
  // blank, they register globally instead, which Discord can take up to an
  // hour to roll out.
  discordGuildId: process.env.DISCORD_GUILD_ID || '',
  // Comma-separated channel ids the live stats embed is posted and kept
  // refreshed in. Empty disables the stats embed even if the bot itself is on.
  discordStatsChannelIds: (process.env.DISCORD_STATS_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  discordStatsRefreshSeconds: int(process.env.DISCORD_STATS_REFRESH_SECONDS, 30),

  // Where /api/callback sends the browser once the token has been issued. The
  // API always serves the frontend itself, so this points back at this server
  // unless FRONTEND_URL says otherwise.
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000/',

  databaseUrl: process.env.DATABASE_URL || 'postgres://mvlo:mvlo@127.0.0.1:5433/mvlo_ranked',
  // Matchmaking queue tickets, pending matches and outcomes all live here -
  // see src/domain/matchmaking.js. Non-default port so a system-wide redis
  // (if any) is never mistaken for the dev instance start-redis-dev.sh runs.
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6380',

  // Some deployments still put the frontend on a separate origin (e.g.
  // Vercel), so the API has to serve CORS headers for it. Comma-separated
  // list; '*' allows any origin.
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),

  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
  // Comma-separated Discord ids allowed into the admin panel (frontend/
  // admin.html, /api/admin/*). Empty means nobody - the panel and its
  // endpoints respond as if the feature does not exist.
  adminDiscordIds: (process.env.ADMIN_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // How stale a cached Discord profile may get before /api/refresh re-fetches it.
  profileRefreshMinutes: int(process.env.PROFILE_REFRESH_MINUTES, 10),
  startingElo: int(process.env.STARTING_ELO, 750),

  // Shared secret for Photon Custom Authentication (src/routes/api.js).
  // Photon Cloud provides this as the `photonToken` query or body parameter.
  photonToken: process.env.PHOTON_TOKEN || process.env.PHOTON_AUTH_TOKEN || '',

  // --- Matchmaking ---------------------------------------------------------
  // The band a player is matched within for the first minute in queue.
  mmBaseEloRange: int(process.env.MM_BASE_ELO_RANGE, 120),
  // Every further minute of waiting widens that band by this much...
  mmEloExpansionStep: int(process.env.MM_ELO_EXPANSION_STEP, 100),
  mmExpansionIntervalSeconds: int(process.env.MM_EXPANSION_INTERVAL_SECONDS, 60),
  // ...up to here, so a long queue eventually pairs with anyone. 0 = no cap.
  mmMaxEloRange: int(process.env.MM_MAX_ELO_RANGE, 1120),
  // How long both players get to accept before the match is torn down.
  mmAcceptSeconds: int(process.env.MM_ACCEPT_SECONDS, 20),
  // A client that stops polling for this long is treated as gone. Must stay
  // comfortably above the client poll interval the tutorial recommends (2s).
  mmTicketStaleSeconds: int(process.env.MM_TICKET_STALE_SECONDS, 15),
  // How long a fully accepted match stays readable after both sides are ready,
  // i.e. the window the host has to publish a Photon room code.
  mmReadyTtlSeconds: int(process.env.MM_READY_TTL_SECONDS, 120),
  // Grace period during which a resolved match can still be reported to a
  // client that has not polled since it ended.
  mmOutcomeTtlSeconds: int(process.env.MM_OUTCOME_TTL_SECONDS, 60),
  // A player who stops sending /matchmaking/alive for this long while a
  // match is "playing" forfeits it to whoever is still sending it.
  mmAliveStaleSeconds: int(process.env.MM_ALIVE_STALE_SECONDS, 20),
  // Absolute ceiling on how long a match may stay "playing", counted from
  // the moment it entered that state. Unlike every other timing above, this
  // is never refreshed - it exists purely so a stuck match cannot hold two
  // tickets hostage forever.
  mmMatchMaxSeconds: int(process.env.MM_MATCH_MAX_SECONDS, 1800),
  // MM_ELO_BASE_CHANGE used to live here: the flat number of points a win or
  // loss was worth before eloStake()'s multiplier. Glicko-2 has no such
  // constant - how far a result moves you falls out of both players' rating
  // deviations - so there is nothing left for it to configure. Setting it now
  // does nothing.

  // --- Glicko-2 -------------------------------------------------------------
  // See src/domain/glicko.js and docs/rating.md. Ratings stay on the same
  // scale (and the same starting number) they were on under flat elo - these
  // govern how fast a rating is allowed to move, not where it sits.
  //
  // tau constrains volatility change between rating periods. Glickman suggests
  // 0.3-1.2: smaller damps upsets, larger lets a genuinely improving player
  // climb faster at the cost of noisier ratings.
  glickoTau: num(process.env.GLICKO_TAU, 0.5),
  // Rating deviation for a player nobody has measured yet, and the ceiling rd
  // is clamped back to however long they stay away.
  //
  // Glickman's own default is 350. That assumes a rating period holding many
  // games; this system rates one match per period (see glicko.js), so at 350 a
  // brand-new player's very first result moves them ~175 points - most of a
  // tier band - on a single game. 200 keeps placement fast without that: first
  // match ~85, down to ~25 by the tenth, and ~15 once they are established,
  // which is where the flat +-20 this replaced used to sit. Raise it for
  // snappier placement, lower it for a calmer ladder; the settled end of the
  // curve is unaffected either way.
  glickoDefaultRd: num(process.env.GLICKO_DEFAULT_RD, 200),
  glickoDefaultVolatility: num(process.env.GLICKO_DEFAULT_VOLATILITY, 0.06),
  // How much idleness it takes to inflate a player's rd by one step. Not the
  // same thing as rating decay below - this only widens the uncertainty around
  // a rating, it never moves the rating itself.
  glickoRatingPeriodDays: num(process.env.GLICKO_RATING_PERIOD_DAYS, 7),

  // --- Rating decay ----------------------------------------------------------
  // Separate from the rd inflation above, which only widens the uncertainty
  // around an idle player's rating - this moves the rating itself. See
  // src/domain/ratingDecay.js and docs/rating.md.
  //
  // How long a player may go without a rated match before their rating starts
  // falling.
  ratingDecayIdleDays: num(process.env.RATING_DECAY_IDLE_DAYS, 30),
  // Rating lost per further idle day once past that threshold, applied
  // continuously rather than in weekly lumps so a player never watches for a
  // cliff. 4/day is ~28 a week. There is deliberately no floor: keep waiting
  // and it keeps going. Set to 0 to turn decay off entirely.
  ratingDecayPerDay: num(process.env.RATING_DECAY_PER_DAY, 4),
  // How often the sweep runs. Daily rather than hourly because the audit table
  // gets a row per decayed player per sweep, and the rate above is per-day
  // anyway - a missed sweep is charged in full by the next one, so the cadence
  // changes nothing about how much anyone loses.
  ratingDecaySweepHours: num(process.env.RATING_DECAY_SWEEP_HOURS, 24),

  // --- Activity stats --------------------------------------------------------
  // How often the live region/map breakdown is sampled into the daily totals
  // the popularity averages are built from (src/domain/activity.js). Storage
  // is a fixed ~78 rows a day whatever this is set to, so the only cost of
  // sampling more often is the write itself. 0 disables collection entirely,
  // which also leaves the Discord /stats command with nothing to report.
  activitySampleSeconds: num(process.env.ACTIVITY_SAMPLE_SECONDS, 60),

  // --- Presence -------------------------------------------------------------
  // A player counts as online until this long after their last /api/online
  // heartbeat. Game clients send that heartbeat every 30s, so this must stay
  // comfortably above 30 - 3x the interval tolerates one or two missed beats
  // without flickering someone offline and back.
  presenceTtlSeconds: int(process.env.PRESENCE_TTL_SECONDS, 90),

  // --- Site gate -------------------------------------------------------------
  // Locks the frontend pages (src/routes/api.js' GET /access, frontend/js/gate.js)
  // behind having a specific role in DISCORD_GUILD_ID above - NOT the same
  // thing as being logged in. Public API routes (e.g. GET /api/online, GET
  // /api/leaderboard) are unaffected on purpose; only the site UI is gated.
  // Two ways to turn the whole thing off without touching any code: flip this
  // to 'false', or just leave SITE_GATE_ROLE_ID blank (same convention as
  // DISCORD_STATS_CHANNEL_IDS above - blank disables the feature even if
  // enabled is left on).
  siteGateEnabled: (process.env.SITE_GATE_ENABLED || 'true') !== 'false',
  // The role id a member of DISCORD_GUILD_ID must have. Checked via the
  // Discord bot (DISCORD_BOT_TOKEN/DISCORD_GUILD_ID above), so the gate can
  // never actually turn on unless the bot is configured too.
  siteGateRoleId: process.env.SITE_GATE_ROLE_ID || '',
  // discord.gg invite shown as a button on the "you don't have access"
  // screen, so someone who isn't a member yet can join and ask for the role
  // (e.g. via a ticket channel once inside). Left blank, the screen just
  // tells people to join the Discord server without a clickable link.
  siteGateDiscordInvite: process.env.SITE_GATE_DISCORD_INVITE || '',
};
