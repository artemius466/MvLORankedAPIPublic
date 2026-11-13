const assert = require('assert');
const config = require('../src/config');
const { createApp } = require('../src/app');
const db = require('../src/db/db');
const redis = require('../src/db/redis');
const users = require('../src/domain/users');
const sessions = require('../src/auth/sessions');

async function runTests() {
  console.log('--- Starting Photon & NSMB Authentication Verification ---');
  await redis.connect();

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const testUserId = '999999999999999991';
    const testProfile = {
      id: testUserId,
      username: 'photon_player',
      global_name: 'Photon Champion',
      avatar: null,
    };
    await users.upsertFromDiscord(testProfile, { accessToken: null, refreshToken: null, expiresAt: null });
    await users.unbanUser(testUserId);

    const session = await sessions.create(testUserId);
    const validToken = session.token;

    // =========================================================================
    // SECTION A: NSMB Game Client Handshake (GET /auth/init & /api/auth/init)
    // =========================================================================
    console.log('A1. Testing /auth/init with valid user & token...');
    {
      const res = await fetch(`${baseUrl}/auth/init?userid=${testUserId}&token=${encodeURIComponent(validToken)}&args=0`);
      assert.strictEqual(res.status, 200, 'Valid handshake should return HTTP 200');
      const text = await res.text();
      // Emulate Unity string quote stripping:
      let result = text.trim();
      while (result.startsWith('"')) result = result.slice(1);
      while (result.endsWith('"')) result = result.slice(0, -1);
      assert.strictEqual(result, validToken, 'Stripped result must match valid session token');
    }
    {
      // Also test /api/auth/init
      const res = await fetch(`${baseUrl}/api/auth/init?userid=${testUserId}&token=${encodeURIComponent(validToken)}&args=0`);
      assert.strictEqual(res.status, 200);
      let result = (await res.text()).trim();
      while (result.startsWith('"')) result = result.slice(1);
      while (result.endsWith('"')) result = result.slice(0, -1);
      assert.strictEqual(result, validToken);
    }
    console.log('✔ Valid /auth/init handshake passed.');

    console.log('A2. Testing /auth/init with mismatched userid...');
    {
      const res = await fetch(`${baseUrl}/auth/init?userid=123456789&token=${encodeURIComponent(validToken)}`);
      assert.strictEqual(res.status, 403, 'Mismatched user ID should return HTTP 403');
      const banMsg = await res.json();
      assert(banMsg.Message.includes('Session token does not match user ID'));
    }
    console.log('✔ Mismatched userid rejected.');

    console.log('A3. Testing /auth/init with banned user (BanMessage format)...');
    await users.banUser(testUserId, {
      reason: 'Caught hacking in ranked lobby',
      hours: 72,
      bannedBy: '123456789',
    });
    {
      const res = await fetch(`${baseUrl}/auth/init?userid=${testUserId}&token=${encodeURIComponent(validToken)}&args=0`);
      assert.strictEqual(res.status, 403, 'Banned user must receive HTTP 403');
      const banMsg = await res.json();
      assert.strictEqual(typeof banMsg.Id, 'number', 'BanMessage.Id must be a number');
      assert.strictEqual(banMsg.Message, 'Caught hacking in ranked lobby', 'BanMessage.Message must match reason');
      assert.strictEqual(typeof banMsg.Expiration, 'number', 'BanMessage.Expiration must be a Unix timestamp in seconds');
      // Expiration should be roughly 72 hours from now
      const nowSec = Math.floor(Date.now() / 1000);
      const diffHours = Math.round((banMsg.Expiration - nowSec) / 3600);
      assert.strictEqual(diffHours, 72, 'Expiration should be ~72 hours in the future');
      console.log(`  BanMessage received: Id=${banMsg.Id}, Message="${banMsg.Message}", Expiration=${banMsg.Expiration}`);
    }
    console.log('✔ Banned player received proper BanMessage on /auth/init.');

    // Unban for subsequent tests
    await users.unbanUser(testUserId);

    // =========================================================================
    // SECTION B: Photon Custom Authentication (/api/auth/photon & /auth/photon)
    // =========================================================================

    if (!config.photonToken) {
      config.photonToken = 'test-photon-token';
    }
    const testPhotonToken = config.photonToken;

    // 1. Missing photonToken checks (ResultCode 3)
    console.log('B1. Testing missing photonToken validation (ResultCode 3)...');
    {
      const res = await fetch(`${baseUrl}/api/auth/photon`);
      assert.strictEqual(res.status, 200, 'Should return HTTP 200');
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 3, 'Missing photonToken should return ResultCode 3');
      assert(data.Message.includes('Missing photonToken parameter'), 'Message should indicate missing photonToken');
    }
    {
      const res = await fetch(`${baseUrl}/auth/photon`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 3);
      assert(data.Message.includes('Missing photonToken parameter'));
    }
    {
      const res = await fetch(`${baseUrl}/api/auth/photon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 3, 'Empty POST body should return ResultCode 3');
      assert(data.Message.includes('Missing photonToken parameter'));
    }
    {
      const res = await fetch(`${baseUrl}/api/auth/photon?data=${encodeURIComponent(validToken)}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 3, 'Providing session token without photonToken should return ResultCode 3');
      assert(data.Message.includes('Missing photonToken parameter'));
    }
    console.log('✔ Missing photonToken validation passed.');

    // 2. Invalid photonToken checks (ResultCode 2)
    console.log('B2. Testing invalid photonToken validation (ResultCode 2)...');
    {
      const res = await fetch(`${baseUrl}/api/auth/photon?photonToken=completely_bogus_token_12345`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 2, 'Invalid photonToken should return ResultCode 2');
      assert(data.Message.includes('Invalid photonToken'), 'Message should indicate invalid photonToken');
    }
    {
      const res = await fetch(`${baseUrl}/api/auth/photon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photonToken: 'bogus_photon_token', data: validToken }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 2, 'Invalid photonToken in POST should return ResultCode 2');
      assert(data.Message.includes('Invalid photonToken'));
    }
    console.log('✔ Invalid photonToken validation passed.');

    // 3. Missing session token checks when photonToken is valid (ResultCode 3)
    console.log('B3. Testing missing session token validation with valid photonToken (ResultCode 3)...');
    {
      const res = await fetch(`${baseUrl}/api/auth/photon?photonToken=${testPhotonToken}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 3, 'Missing session token should return ResultCode 3');
      assert(data.Message.includes('Missing session token'), 'Message should indicate missing session token');
    }
    {
      const res = await fetch(`${baseUrl}/api/auth/photon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photonToken: testPhotonToken }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 3);
      assert(data.Message.includes('Missing session token'));
    }
    console.log('✔ Missing session token validation passed.');

    // 4. Invalid / Expired session token checks with valid photonToken (ResultCode 2)
    console.log('B4. Testing invalid session token validation with valid photonToken (ResultCode 2)...');
    {
      const res = await fetch(`${baseUrl}/api/auth/photon?photonToken=${testPhotonToken}&token=completely_bogus_session_12345`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 2, 'Invalid session token should return ResultCode 2');
      assert(data.Message.includes('Invalid or expired session token'), 'Message should indicate invalid/expired token');
    }
    {
      const res = await fetch(`${baseUrl}/api/auth/photon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photonToken: testPhotonToken, token: 'bogus_token_xyz' }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 2);
    }
    console.log('✔ Invalid session token validation passed.');

    // 5. Valid active player authentication (ResultCode 1)
    console.log('B5. Testing valid player authentication with photonToken (ResultCode 1)...');
    // 5a. GET with Photon "data" and "photonToken" query params
    {
      const res = await fetch(`${baseUrl}/api/auth/photon?photonToken=${testPhotonToken}&data=${encodeURIComponent(validToken)}&userId=${testUserId}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 1, 'Valid user with ?photonToken= and ?data= should return ResultCode 1');
      assert.strictEqual(data.UserId, testUserId, 'UserId must match discord snowflake');
      assert.strictEqual(data.Nickname, 'Photon Champion', 'Nickname should match displayName');
      assert(data.Data, 'Data object must be present');
      assert.strictEqual(data.Data.username, 'photon_player');
      assert.strictEqual(data.Data.displayName, 'Photon Champion');
      assert.strictEqual(typeof data.Data.elo, 'number');
    }
    // 5b. GET with ?photonToken=...&token=...
    {
      const res = await fetch(`${baseUrl}/api/auth/photon?photonToken=${testPhotonToken}&token=${encodeURIComponent(validToken)}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 1);
      assert.strictEqual(data.UserId, testUserId);
    }
    // 5c. POST with JSON body containing photonToken and data
    {
      const res = await fetch(`${baseUrl}/api/auth/photon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photonToken: testPhotonToken, data: validToken, userId: testUserId }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 1);
      assert.strictEqual(data.UserId, testUserId);
    }
    // 5d. POST with urlencoded form data containing photonToken and data
    {
      const res = await fetch(`${baseUrl}/api/auth/photon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `photonToken=${encodeURIComponent(testPhotonToken)}&data=${encodeURIComponent(validToken)}&userId=${testUserId}`,
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 1);
      assert.strictEqual(data.UserId, testUserId);
    }
    // 5e. Top-level /auth/photon with photonToken
    {
      const res = await fetch(`${baseUrl}/auth/photon?photonToken=${testPhotonToken}&data=${encodeURIComponent(validToken)}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 1);
    }
    // 5f. Alias endpoint /api/photon/auth with photonToken
    {
      const res = await fetch(`${baseUrl}/api/photon/auth?photonToken=${testPhotonToken}&token=${encodeURIComponent(validToken)}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 1);
      assert.strictEqual(data.UserId, testUserId);
    }
    // 5g. Headers: x-photon-token header + Bearer token
    {
      const res = await fetch(`${baseUrl}/api/auth/photon`, {
        headers: {
          'x-photon-token': testPhotonToken,
          Authorization: `Bearer ${validToken}`,
        },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 1);
      assert.strictEqual(data.UserId, testUserId);
    }
    console.log('✔ Valid player authentication passed across all transport formats (including Photon "data" param and photonToken).');

    // 6. Banned player rejection in Photon Custom Auth (ResultCode 2)
    console.log('B6. Testing banned player rejection in Photon custom auth (ResultCode 2)...');
    await users.banUser(testUserId, {
      reason: 'Use of illegal speedhack',
      hours: 48,
      bannedBy: '123456789',
    });

    {
      const res = await fetch(`${baseUrl}/api/auth/photon?photonToken=${testPhotonToken}&data=${encodeURIComponent(validToken)}`);
      assert.strictEqual(res.status, 200, 'Photon expects HTTP 200 with rejection JSON');
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 2, 'Banned player must receive ResultCode 2');
      assert(!data.UserId, 'Banned response must not contain UserId');
      assert(data.Message.includes('You are banned from playing.'), 'Message should state banned');
      assert(data.Message.includes('Use of illegal speedhack'), 'Message should include ban reason');
      assert(data.Message.includes('48 hours'), 'Message should include time left');
      console.log(`  Received ban rejection message:\n  "${data.Message.replace(/\n/g, '\n  ')}"`);
    }
    console.log('✔ Banned player rejection passed in Photon custom auth.');

    // 7. Unban player and verify recovery
    console.log('B7. Testing unban restoration with photonToken...');
    await users.unbanUser(testUserId);
    {
      const res = await fetch(`${baseUrl}/api/auth/photon?photonToken=${testPhotonToken}&data=${encodeURIComponent(validToken)}`);
      const data = await res.json();
      assert.strictEqual(data.ResultCode, 1, 'Unbanned player should successfully authenticate');
      assert.strictEqual(data.UserId, testUserId);
    }
    console.log('✔ Unban restoration passed.');

    console.log('--- All Photon & NSMB Authentication Tests Passed! ---');
  } finally {
    server.close();
    await Promise.allSettled([db.close(), redis.close()]);
  }
}

runTests().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
