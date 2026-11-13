const { createClient } = require('redis');
const config = require('../config');

// node-redis retries forever by default, on the very first connection
// attempt as much as on a later drop - with no cap, a redis that is simply
// not running would leave connect() (below) hanging instead of ever
// rejecting. Capping it makes a truly-down redis fail in ~7s while still
// giving a momentary blip (or the dev container still warming up) room to
// resolve itself. The count resets on every successful connection, so this
// budget is per outage, not a lifetime total - a later disconnect gets the
// same ~7s of patience before the client gives up again.
const MAX_CONNECT_RETRIES = 7;

const client = createClient({
  url: config.redisUrl,
  socket: {
    reconnectStrategy(retries, cause) {
      if (retries > MAX_CONNECT_RETRIES) {
        return new Error(`redis unreachable after ${MAX_CONNECT_RETRIES} retries: ${cause.message}`);
      }
      // Same backoff node-redis uses by default: (2^retries)*50ms, capped at 2s.
      return Math.min(2 ** retries * 50, 2000);
    },
  },
});

client.on('error', (err) => {
  console.error('Unexpected redis client error', err);
});

// connect() is idempotent so every caller can just await it instead of
// threading a "did we already connect" flag through the app.
let connected = null;
function connect() {
  if (!connected) connected = client.connect();
  return connected;
}

async function close() {
  if (!connected) return;
  await client.close();
  connected = null;
}

module.exports = { client, connect, close };
