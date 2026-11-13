const path = require('path');
const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Managed providers (Neon, Supabase, RDS) terminate TLS with certs we do not
  // pin; local docker postgres speaks plaintext.
  ssl: /\bsslmode=require\b/.test(config.databaseUrl) ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected postgres client error', err);
});

// Everything the schema is made of lives in migrations/ as one .sql file per
// change - see docs/migrations.md. Nothing in this file describes the schema
// anymore; it used to hold one growing idempotent SCHEMA string that ran on
// every boot, which could only ever add things and left no record of what had
// been applied.
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/**
 * Applies every pending migration. Called once at startup (see server.js), so
 * a deployment is upgraded by restarting it - there is no separate release
 * step to forget.
 *
 * node-pg-migrate takes a postgres advisory lock for the duration, so two API
 * containers booting at the same instant cannot both run the same migration;
 * the second waits and then finds nothing left to do.
 */
async function migrate() {
  // v9 ships as ESM only, and this package is commonjs - a dynamic import is
  // the one form that works on every Node version this runs on, rather than
  // depending on require(esm) being available.
  const { runner } = await import('node-pg-migrate');

  // runner() wants a single connected Client it can hold for the whole run
  // (the advisory lock is session-scoped), not a Pool that hands out a
  // different connection per query.
  const client = await pool.connect();
  try {
    const applied = await runner({
      dbClient: client,
      dir: MIGRATIONS_DIR,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: (message) => console.log(`[migrate] ${message}`),
    });
    if (applied.length) {
      console.log(`Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`);
    }
  } finally {
    client.release();
  }
}

function query(text, params) {
  return pool.query(text, params);
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, migrate, close };
