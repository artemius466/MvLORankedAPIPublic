const { createApp } = require('./src/app');
const config = require('./src/config');
const db = require('./src/db/db');
const redis = require('./src/db/redis');
const sessions = require('./src/auth/sessions');
const matchmaking = require('./src/domain/matchmaking');
const ratingDecay = require('./src/domain/ratingDecay');
const activity = require('./src/domain/activity');
const deviceLogin = require('./src/auth/deviceLogin');
const discordBot = require('./src/bot/client');

const HOUR = 60 * 60 * 1000;

async function main() {
  try {
    await db.migrate();
  } catch (err) {
    console.error(`Could not migrate postgres at ${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);
    console.error('Start the dev database with ./start-psql-dev.sh, then see docs/migrations.md');
    throw err;
  }

  try {
    await redis.connect();
  } catch (err) {
    console.error(`Could not reach redis at ${config.redisUrl.replace(/:[^:@/]*@/, ':***@')}`);
    console.error('Start the dev redis instance with ./start-redis-dev.sh');
    throw err;
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Listening on http://127.0.0.1:${config.port}`);
    console.log('Serving the frontend/ folder');
    if (config.devLoginEnabled) {
      console.warn(`Dev login backdoor ENABLED (NODE_ENV=${config.env}) - GET /api/dev-login bypasses Discord entirely.`);
    }
  });

  // Expires abandoned queue tickets and unanswered matches even when nobody is
  // polling. The queue itself lives in memory only, so it starts empty here.
  matchmaking.start();

  // Charges inactive players their rating decay - once now (catching up on
  // whatever accrued while this process was down) and daily after that. A
  // no-op unless RATING_DECAY_PER_DAY is set above zero.
  ratingDecay.start();

  // Samples who is queuing/playing where, which is the only source of the
  // region and map popularity averages the Discord bot reports.
  activity.start();

  // Optional - a no-op if DISCORD_BOT_TOKEN is unset (see src/bot/client.js).
  // Failing to log in (bad token, Discord outage) shouldn't take the whole
  // API down with it.
  try {
    await discordBot.start();
  } catch (err) {
    console.error('Discord bot failed to start:', err);
  }

  const sweep = setInterval(() => {
    sessions.purgeExpired().catch((err) => console.error('Session sweep failed:', err));
    deviceLogin.purgeExpired().catch((err) => console.error('Device login sweep failed:', err));
  }, HOUR);
  sweep.unref();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      matchmaking.stop();
      ratingDecay.stop();
      activity.stop();
      discordBot.stop();
      server.close(() => Promise.allSettled([db.close(), redis.close()]).finally(() => process.exit(0)));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
