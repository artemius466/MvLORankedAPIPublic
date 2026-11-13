const path = require('path');
const express = require('express');
const config = require('./config');
const { buildApiRouter, authInitHandler, photonAuthHandler } = require('./routes/api');
const { buildAdminRouter } = require('./routes/admin');
const announcements = require('./domain/announcements');

// In prod the frontend is hosted on Vercel, i.e. a different origin than this
// API, so /api has to answer preflights itself. Auth rides on a bearer token,
// never a cookie, so credentialed CORS is deliberately not enabled.
function cors(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    const allowed = config.corsOrigins.includes('*') || config.corsOrigins.includes(origin);
    if (allowed) {
      res.set('Access-Control-Allow-Origin', config.corsOrigins.includes('*') ? '*' : origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Max-Age', '86400');
    }
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // Ordered before the main api router because that one ends in a catch-all
  // 404 - mounted after, /api/admin/* would be swallowed as "Unknown API
  // endpoint.".
  // Top-level aliases for game client handshake (/auth/init) and Photon custom auth (/auth/photon)
  app.all(['/auth/init', '/init'], cors, authInitHandler);
  app.all(['/auth/photon', '/photon/auth'], cors, photonAuthHandler);

  app.use('/api/admin', cors, buildAdminRouter());
  app.use('/api', cors, buildApiRouter());
  app.get('/announcements', cors, async (req, res, next) => {
    try {
      const rows = await announcements.listAll();
      res.json(rows.map(announcements.toUnity));
    } catch (err) {
      next(err);
    }
  });

  const frontendDir = path.join(__dirname, '..', 'frontend');

  // Player profiles are served for any :id, so they cannot be resolved as a
  // literal static file the way index.html or tiers.html are.
  app.get('/user/:id', (req, res) => {
    res.sendFile(path.join(frontendDir, 'user.html'));
  });

  // Always serve the frontend from the same origin, in dev and in prod alike.
  app.use(express.static(frontendDir, { extensions: ['html'] }));

  // Anything past this point matched no API route, no static file and no
  // /user/:id - a real 404, styled like the rest of the site instead of
  // Express's default plain-text error.
  app.use((req, res) => {
    res.status(404).sendFile(path.join(frontendDir, '404.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    // Body-parser (malformed JSON, oversized body) throws client errors with a
    // 4xx status attached - surface those instead of flattening everything to 500.
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    const message = status === 413
      ? 'Payload too large.'
      : status < 500 ? 'Malformed request.' : 'Internal server error.';
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
