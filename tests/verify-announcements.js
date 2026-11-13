const assert = require('assert');
const { markdownToUnityRichText } = require('../src/domain/richText');
const announcements = require('../src/domain/announcements');
const { createApp } = require('../src/app');
const config = require('../src/config');
const db = require('../src/db/db');
const users = require('../src/domain/users');
const sessions = require('../src/auth/sessions');

async function runTests() {
  console.log('--- Starting Announcements Verification ---');

  // 1. Rich Text Translation Unit Tests
  console.log('1. Testing markdownToUnityRichText...');
  {
    const md = '# Heading 1\n## Heading 2\n### Heading 3\n#### Heading 4';
    const unity = markdownToUnityRichText(md);
    assert(unity.includes('<size=24><b>Heading 1</b></size>'), 'Heading 1 failed');
    assert(unity.includes('<size=20><b>Heading 2</b></size>'), 'Heading 2 failed');
    assert(unity.includes('<size=16><b>Heading 3</b></size>'), 'Heading 3 failed');
    assert(unity.includes('<size=14><b>Heading 4</b></size>'), 'Heading 4 failed');
  }

  {
    const md = 'Here is **bold**, *italic*, and ***both*** with ~~strike~~.';
    const unity = markdownToUnityRichText(md);
    assert(unity.includes('<b>bold</b>'), 'Bold failed');
    assert(unity.includes('<i>italic</i>'), 'Italic failed');
    assert(unity.includes('<b><i>both</i></b>'), 'Both failed');
    assert(unity.includes('<s>strike</s>'), 'Strike failed');
  }

  {
    const md = 'Check out [Mario vs Luigi](https://mvloranked.xyz) for info.';
    const unity = markdownToUnityRichText(md);
    assert(unity.includes('<color=#5c94fc><u>Mario vs Luigi</u></color> (https://mvloranked.xyz)'), 'Link failed: ' + unity);
  }

  {
    const md = '- item 1\n- item 2\n- item 3';
    const unity = markdownToUnityRichText(md);
    assert.strictEqual(unity, '- item 1\r\n- item 2\r\n- item 3', 'List line endings failed');
  }

  {
    // Test that existing Unity tags pass through untouched
    const sample = '<size=20><u><i>It\'s been a while, hasn\'t it?</i></u></size>\n\nSecond paragraph';
    const unity = markdownToUnityRichText(sample);
    assert(unity.startsWith('<size=20><u><i>It\'s been a while, hasn\'t it?</i></u></size>\r\n\r\nSecond paragraph'), 'Unity tag preservation failed');
  }

  console.log('✔ markdownToUnityRichText tests passed.');

  // 2. Announcements DB & Domain Tests
  console.log('2. Testing domain & DB CRUD...');
  let createdAnn;
  {
    createdAnn = await announcements.create({
      title: 'Welcome to Mario vs Luigi Online v2.0.0.0!',
      author: 'ipodtouch0218',
      content: '## It\'s been a while!\n\nCheck out **MvLO** at [Website](https://mvloranked.xyz).\n- Mod 1\n- Mod 2',
    });
    assert(createdAnn.id > 0, 'Created announcement missing ID');
    assert.strictEqual(createdAnn.title, 'Welcome to Mario vs Luigi Online v2.0.0.0!');

    const unityShape = announcements.toUnity(createdAnn);
    assert.strictEqual(typeof unityShape.id, 'number');
    assert.strictEqual(typeof unityShape.created, 'number');
    assert.strictEqual(typeof unityShape.title, 'string');
    assert.strictEqual(typeof unityShape.author, 'string');
    assert.strictEqual(typeof unityShape.text, 'string');
    assert(unityShape.text.includes('<size=20><b>It\'s been a while!</b></size>'));
    assert(unityShape.text.includes('<b>MvLO</b>'));
    assert(unityShape.text.includes('\r\n'));

    // Test findById
    const fetched = await announcements.findById(createdAnn.id);
    assert.strictEqual(fetched.id, createdAnn.id);

    // Test update
    const updated = await announcements.update(createdAnn.id, {
      title: 'Updated Title',
    });
    assert.strictEqual(updated.title, 'Updated Title');
  }
  console.log('✔ DB CRUD tests passed.');

  // 3. HTTP Server & Admin Gating Tests
  console.log('3. Testing HTTP endpoints and admin gating...');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 3a. Public endpoint /api/announcements
    const resApi = await fetch(`${baseUrl}/api/announcements`);
    assert.strictEqual(resApi.status, 200);
    const dataApi = await resApi.json();
    assert(Array.isArray(dataApi), 'Response is not an array');
    assert(dataApi.length > 0, 'No announcements returned');
    const first = dataApi[0];
    assert.strictEqual(typeof first.id, 'number');
    assert.strictEqual(typeof first.title, 'string');
    assert.strictEqual(typeof first.author, 'string');
    assert.strictEqual(typeof first.created, 'number');
    assert.strictEqual(typeof first.text, 'string');

    // 3b. Public endpoint /announcements
    const resRoot = await fetch(`${baseUrl}/announcements`);
    assert.strictEqual(resRoot.status, 200);
    const dataRoot = await resRoot.json();
    assert(Array.isArray(dataRoot), '/announcements response is not an array');
    assert.strictEqual(dataRoot.length, dataApi.length);

    // 3c. Admin gating without auth
    const resAdminNoAuth = await fetch(`${baseUrl}/api/admin/announcements`);
    assert.strictEqual(resAdminNoAuth.status, 401, 'Should return 401 when not authenticated');

    const resAdminPostNoAuth = await fetch(`${baseUrl}/api/admin/announcements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T', content: 'C' }),
    });
    assert.strictEqual(resAdminPostNoAuth.status, 401, 'Should return 401 when not authenticated');

    // 3d. Admin gating with non-admin user
    // Create a regular user and session
    const regularProfile = { id: '999999999999999998', username: 'regular_user', global_name: 'Regular', avatar: null };
    const regUser = await users.upsertFromDiscord(regularProfile, { accessToken: null, refreshToken: null, expiresAt: null });
    const regSession = await sessions.create(regUser.discord_id);

    const resAdminNonAdmin = await fetch(`${baseUrl}/api/admin/announcements`, {
      headers: { Authorization: `Bearer ${regSession.token}` },
    });
    assert.strictEqual(resAdminNonAdmin.status, 403, 'Should return 403 when user is not in adminDiscordIds');

    // 3e. Admin gating with authorized admin user
    // Ensure our test admin id is in config.adminDiscordIds
    const adminDiscordId = '999999999999999999';
    if (!config.adminDiscordIds.includes(adminDiscordId)) {
      config.adminDiscordIds.push(adminDiscordId);
    }
    const adminProfile = { id: adminDiscordId, username: 'admin_user', global_name: 'Admin Boss', avatar: null };
    const adminUser = await users.upsertFromDiscord(adminProfile, { accessToken: null, refreshToken: null, expiresAt: null });
    const adminSession = await sessions.create(adminUser.discord_id);

    // Admin GET /api/admin/announcements
    const resAdminGet = await fetch(`${baseUrl}/api/admin/announcements`, {
      headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    assert.strictEqual(resAdminGet.status, 200, 'Admin should be able to get announcements');
    const adminAnnList = await resAdminGet.json();
    assert(Array.isArray(adminAnnList.announcements), 'Admin announcements list missing');

    // Admin POST /api/admin/announcements
    const resAdminPost = await fetch(`${baseUrl}/api/admin/announcements`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSession.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Admin Created Announcement',
        content: '# Testing Markdown\n\nAdmin post content.',
      }),
    });
    assert.strictEqual(resAdminPost.status, 201, 'Admin should be able to create announcement');
    const createdData = await resAdminPost.json();
    assert.strictEqual(createdData.announcement.title, 'Admin Created Announcement');
    assert.strictEqual(createdData.announcement.author, 'Admin Boss'); // defaulted to display_name!

    const newId = createdData.announcement.id;

    // Admin PUT /api/admin/announcements/:id
    const resAdminPut = await fetch(`${baseUrl}/api/admin/announcements/${newId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminSession.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Admin Updated Announcement',
      }),
    });
    assert.strictEqual(resAdminPut.status, 200);
    const updatedData = await resAdminPut.json();
    assert.strictEqual(updatedData.announcement.title, 'Admin Updated Announcement');

    // Admin DELETE /api/admin/announcements/:id
    const resAdminDel = await fetch(`${baseUrl}/api/admin/announcements/${newId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    assert.strictEqual(resAdminDel.status, 200);

    // Cleanup the first test announcement
    await announcements.deleteById(createdAnn.id);

    console.log('✔ All HTTP endpoint and admin gating tests passed.');
  } finally {
    server.close();
  }

  console.log('All tests finished successfully!');
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
