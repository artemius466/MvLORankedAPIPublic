const assert = require('assert');
const { createApp } = require('../src/app');
const config = require('../src/config');
const db = require('../src/db/db');
const redis = require('../src/db/redis');
const users = require('../src/domain/users');
const sessions = require('../src/auth/sessions');
const matchmaking = require('../src/domain/matchmaking');

async function runTests() {
  console.log('--- Starting Bans Verification ---');
  await redis.connect();

  // 1. Schema check
  console.log('1. Verifying schema for ban columns...');
  {
    const { rows } = await db.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name IN ('banned_until', 'ban_reason', 'banned_at', 'banned_by')
    `);
    const foundColumns = rows.map((r) => r.column_name);
    assert(foundColumns.includes('banned_until'), 'Column banned_until missing');
    assert(foundColumns.includes('ban_reason'), 'Column ban_reason missing');
    assert(foundColumns.includes('banned_at'), 'Column banned_at missing');
    assert(foundColumns.includes('banned_by'), 'Column banned_by missing');
  }
  console.log('✔ Schema verification passed.');

  // 2. Domain ban / unban logic
  console.log('2. Testing domain ban / unban logic...');
  const testUserId = '888888888888888881';
  const testProfile = { id: testUserId, username: 'banned_guy', global_name: 'Banned Guy', avatar: null };
  const user = await users.upsertFromDiscord(testProfile, { accessToken: null, refreshToken: null, expiresAt: null });

  // Ensure initially clean
  await users.unbanUser(testUserId);
  assert.strictEqual(users.getBanStatus(await users.findById(testUserId)), null, 'User should not be banned initially');

  // Ban for 24 hours
  const bannedRow = await users.banUser(testUserId, {
    reason: 'Cheating / modifying memory',
    hours: 24,
    bannedBy: '123456789',
  });
  assert(bannedRow.banned_until, 'banned_until should be set');
  assert.strictEqual(bannedRow.ban_reason, 'Cheating / modifying memory');
  assert.strictEqual(bannedRow.banned_by, '123456789');

  const banStatus = users.getBanStatus(bannedRow);
  assert(banStatus, 'getBanStatus should return active ban');
  assert.strictEqual(banStatus.isBanned, true);
  assert.strictEqual(banStatus.reason, 'Cheating / modifying memory');
  assert.strictEqual(banStatus.hoursLeft, 24);

  // Check toPublic contains ban
  const publicUser = users.toPublic(bannedRow);
  assert(publicUser.ban, 'toPublic should include ban');
  assert.strictEqual(publicUser.ban.reason, 'Cheating / modifying memory');
  assert.strictEqual(publicUser.ban.hoursLeft, 24);

  // Test Leaderboard exclusion
  console.log('3. Testing leaderboard exclusion...');
  const boardWithBan = await users.leaderboard(50, 0);
  const foundInBoard = boardWithBan.players.find((p) => p.id === testUserId);
  assert.strictEqual(foundInBoard, undefined, 'Banned user must be excluded from leaderboard');

  // Unban user and verify reappearance
  await users.unbanUser(testUserId);
  const unbannedRow = await users.findById(testUserId);
  assert.strictEqual(users.getBanStatus(unbannedRow), null, 'User should not be banned after unban');
  assert.strictEqual(unbannedRow.banned_until, null);

  const boardAfterUnban = await users.leaderboard(50, 0);
  const foundAfterUnban = boardAfterUnban.players.find((p) => p.id === testUserId);
  assert(foundAfterUnban, 'Unbanned user must reappear on leaderboard');
  console.log('✔ Domain & Leaderboard tests passed.');

  // 4. HTTP API & Matchmaking rejection tests
  console.log('4. Testing HTTP Matchmaking rejection & Admin routes...');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Re-ban the test user for HTTP tests
    await users.banUser(testUserId, {
      reason: 'Toxic chat and griefing',
      hours: 12,
      bannedBy: '123456789',
    });

    const session = await sessions.create(testUserId);

    // Attempt to queue
    const queueRes = await fetch(`${baseUrl}/api/matchmaking/queue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ version: '1.0.2', pings: [50, 50, 50, 50] }),
    });

    assert.strictEqual(queueRes.status, 400, 'Queue should return 400 when banned');
    const queueData = await queueRes.json();
    assert.strictEqual(queueData.code, 'banned', 'Code should be "banned"');
    assert(queueData.error.includes('You are banned from matchmaking.'), 'Error should start with ban notice');
    assert(queueData.error.includes('Reason: Toxic chat and griefing'), 'Error should state reason');
    assert(queueData.error.includes('12 hours'), 'Error should state remaining hours');
    console.log('✔ Matchmaking queue rejection 400 format passed:', queueData.error);

    // Test /api/me/v2 and /api/refresh return ban info
    const meRes = await fetch(`${baseUrl}/api/me/v2`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.strictEqual(meRes.status, 200);
    const meData = await meRes.json();
    assert(meData.user.ban, 'me/v2 should return ban object for banned user');
    assert.strictEqual(meData.user.ban.hoursLeft, 12);

    const refreshRes = await fetch(`${baseUrl}/api/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.strictEqual(refreshRes.status, 200);
    const refreshData = await refreshRes.json();
    assert(refreshData.user.ban, 'refresh should return ban object for banned user');
    assert.strictEqual(refreshData.user.ban.reason, 'Toxic chat and griefing');

    // 5. Admin endpoints
    console.log('5. Testing admin ban / unban endpoints...');
    const adminDiscordId = '777777777777777777';
    config.adminDiscordIds = [adminDiscordId];

    const adminProfile = { id: adminDiscordId, username: 'admin_user', global_name: 'Admin', avatar: null };
    await users.upsertFromDiscord(adminProfile, { accessToken: null, refreshToken: null, expiresAt: null });
    const adminSession = await sessions.create(adminDiscordId);

    // Non-admin attempt
    const nonAdminBanRes = await fetch(`${baseUrl}/api/admin/users/${testUserId}/ban`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ hours: 48, reason: 'Test' }),
    });
    assert.strictEqual(nonAdminBanRes.status, 403, 'Non-admin should be forbidden');

    // Admin unban
    const adminUnbanRes = await fetch(`${baseUrl}/api/admin/users/${testUserId}/unban`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    assert.strictEqual(adminUnbanRes.status, 200);
    const adminUnbanData = await adminUnbanRes.json();
    assert.strictEqual(adminUnbanData.ok, true);

    const checkUnbanned = await users.findById(testUserId);
    assert.strictEqual(checkUnbanned.banned_until, null);

    // Admin ban
    const adminBanRes = await fetch(`${baseUrl}/api/admin/users/${testUserId}/ban`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.token}`,
      },
      body: JSON.stringify({ hours: 72, reason: 'Admin banned via endpoint' }),
    });
    assert.strictEqual(adminBanRes.status, 200);
    const adminBanData = await adminBanRes.json();
    assert.strictEqual(adminBanData.ok, true);

    const checkBanned = await users.findById(testUserId);
    assert(checkBanned.banned_until);
    assert.strictEqual(checkBanned.ban_reason, 'Admin banned via endpoint');
    assert.strictEqual(checkBanned.banned_by, adminDiscordId);

    console.log('✔ Admin ban/unban endpoint tests passed.');

    // Clean up
    await users.unbanUser(testUserId);
  } finally {
    server.close();
  }

  console.log('--- All Ban Tests Passed Successfully! ---');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
