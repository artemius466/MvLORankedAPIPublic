const db = require('../db/db');
const { markdownToUnityRichText } = require('./richText');

/**
 * Maps a database row to the Unity-compatible JSON response shape.
 */
function toUnity(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title,
    author: row.author,
    created: Math.floor(new Date(row.created_at).getTime() / 1000),
    text: markdownToUnityRichText(row.content),
    content: row.content,
  };
}

async function listAll() {
  const result = await db.query(
    'SELECT id, title, author, content, created_at, updated_at FROM announcements ORDER BY id DESC'
  );
  return result.rows;
}

async function findById(id) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) return null;
  const result = await db.query(
    'SELECT id, title, author, content, created_at, updated_at FROM announcements WHERE id = $1',
    [numId]
  );
  return result.rows[0] || null;
}

async function create({ title, author, content }) {
  const result = await db.query(
    `INSERT INTO announcements (title, author, content)
     VALUES ($1, $2, $3)
     RETURNING id, title, author, content, created_at, updated_at`,
    [title, author, content]
  );
  return result.rows[0];
}

async function update(id, { title, author, content }) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) return null;
  const result = await db.query(
    `UPDATE announcements
     SET title = COALESCE($1, title),
         author = COALESCE($2, author),
         content = COALESCE($3, content),
         updated_at = now()
     WHERE id = $4
     RETURNING id, title, author, content, created_at, updated_at`,
    [title, author, content, numId]
  );
  return result.rows[0] || null;
}

async function deleteById(id) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) return false;
  const result = await db.query(
    'DELETE FROM announcements WHERE id = $1 RETURNING id',
    [numId]
  );
  return result.rowCount > 0;
}

module.exports = {
  toUnity,
  listAll,
  findById,
  create,
  update,
  deleteById,
};
