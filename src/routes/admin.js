const express = require('express');
const config = require('../config');
const { loadUser } = require('./api');
const users = require('../domain/users');
const matches = require('../domain/matches');
const matchmaking = require('../domain/matchmaking');
const announcements = require('../domain/announcements');

// Everything below mounts at /api/admin, which only exists for the config's
// adminDiscordIds. Empty list means the router behaves as if the whole panel
// were missing - no route answers and the page just reports no access.
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  if (!config.adminDiscordIds.includes(String(req.user.discord_id))) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

function buildAdminRouter() {
  const router = express.Router();

  router.use(loadUser);
  router.use(requireAdmin);

  router.get('/users', requireAdmin, async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const [total, rows] = await Promise.all([
        users.countAll(q),
        users.listAll({ limit, offset, query: q }),
      ]);
      res.json({ total, users: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/users/:id/ban', requireAdmin, async (req, res, next) => {
    try {
      const id = (req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Missing user id.' });

      const target = await users.findById(id);
      if (!target) return res.status(404).json({ error: 'User not found.' });

      const body = req.body || {};
      const hours = Number(body.hours);
      if (!Number.isFinite(hours) || hours <= 0) {
        return res.status(400).json({ error: '`hours` must be a positive number.' });
      }

      const reason = typeof body.reason === 'string' ? body.reason.trim() : null;

      const updated = await users.banUser(id, {
        reason,
        hours,
        bannedBy: String(req.user.discord_id),
      });

      // Clear any active queue or match ticket
      await matchmaking.leave(id);

      res.json({ ok: true, user: updated });
    } catch (err) {
      next(err);
    }
  });

  router.post('/users/:id/unban', requireAdmin, async (req, res, next) => {
    try {
      const id = (req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Missing user id.' });

      const target = await users.findById(id);
      if (!target) return res.status(404).json({ error: 'User not found.' });

      const updated = await users.unbanUser(id);
      res.json({ ok: true, user: updated });
    } catch (err) {
      next(err);
    }
  });

  router.get('/matches', requireAdmin, async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const [total, rows] = await Promise.all([
        matches.countAll(q),
        matches.listAll({ limit, offset, query: q }),
      ]);
      res.json({ total, matches: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/matches/:matchUid/revert', requireAdmin, async (req, res, next) => {
    try {
      const matchUid = (req.params.matchUid || '').trim();
      if (!matchUid) return res.status(400).json({ error: 'Missing matchUid.' });

      const reason = req.body && req.body.reason !== undefined ? req.body.reason : null;
      if (reason !== null && typeof reason !== 'string') {
        return res.status(400).json({ error: '`reason` must be a string.' });
      }
      const trimmedReason = typeof reason === 'string' ? reason.trim().slice(0, 500) || null : null;

      const result = await matchmaking.revertMatch(matchUid, String(req.user.discord_id), trimmedReason);
      if (!result.ok) {
        const messages = {
          not_found: 'Match not found.',
          already_reverted: 'That match was already reverted.',
        };
        return res.status(result.code === 'not_found' ? 404 : 409).json({ error: messages[result.code] || 'Could not revert that match.' });
      }
      res.json({ ok: true, matchUid });
    } catch (err) {
      next(err);
    }
  });

  router.get('/announcements', requireAdmin, async (req, res, next) => {
    try {
      const rows = await announcements.listAll();
      res.json({ announcements: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/announcements', requireAdmin, async (req, res, next) => {
    try {
      const body = req.body || {};
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      const author = typeof body.author === 'string' && body.author.trim()
        ? body.author.trim()
        : (req.user.display_name || req.user.username);

      if (!title) return res.status(400).json({ error: 'Title is required.' });
      if (!content) return res.status(400).json({ error: 'Content is required.' });

      const row = await announcements.create({ title, author, content });
      res.status(201).json({ announcement: row });
    } catch (err) {
      next(err);
    }
  });

  router.put('/announcements/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid announcement id.' });

      const body = req.body || {};
      const title = typeof body.title === 'string' ? body.title.trim() : undefined;
      const content = typeof body.content === 'string' ? body.content.trim() : undefined;
      const author = typeof body.author === 'string' ? body.author.trim() : undefined;

      if (title !== undefined && !title) return res.status(400).json({ error: 'Title cannot be empty.' });
      if (content !== undefined && !content) return res.status(400).json({ error: 'Content cannot be empty.' });

      const row = await announcements.update(id, { title, author, content });
      if (!row) return res.status(404).json({ error: 'Announcement not found.' });
      res.json({ announcement: row });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/announcements/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid announcement id.' });

      const ok = await announcements.deleteById(id);
      if (!ok) return res.status(404).json({ error: 'Announcement not found.' });
      res.json({ ok: true, id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildAdminRouter, requireAdmin };