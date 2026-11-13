# Database migrations

The schema is a directory of `.sql` files in `migrations/`, one per change,
applied in filename order and tracked in a `pgmigrations` table so each one
runs exactly once. [node-pg-migrate](https://salsita.github.io/node-pg-migrate)
does the applying.

**Migrations run automatically on startup.** `server.js` calls
`db.migrate()` (see [src/db/db.js](../src/db/db.js)) before it opens the port,
so a deployment is upgraded by restarting it - there is no separate release
step to forget, and the API never serves traffic against a schema it has not
finished migrating. If a migration fails, the process exits instead of
starting.

This replaced a single idempotent `SCHEMA` string that re-ran on every boot.
That worked, but it could only ever *add* things - there was no way to drop a
column, rename one, backfill a value or delete a row, and no record of what a
given database had actually had done to it.

## Adding a change

```bash
npm run db:migrate:new -- describe-the-change
```

That writes `migrations/<n>_describe-the-change.sql`, numbered one past the
highest existing file, with the two markers already in it. Fill them in:

```sql
-- Up Migration
ALTER TABLE users ADD COLUMN IF NOT EXISTS favourite_map TEXT;

-- Down Migration
ALTER TABLE users DROP COLUMN IF EXISTS favourite_map;
```

Anything postgres accepts is fair game, `INSERT`/`UPDATE`/`DELETE` included -
a data fix (drop these three rows, add these two) is as much a migration as a
schema change, and belongs in a file here for exactly the same reason.

The next `npm run dev` (or a restart in production) applies it. To apply
without restarting:

```bash
npm run db:migrate
```

## Rolling back

```bash
npm run db:migrate:down
```

Reverses the most recent migration only, and only if it has a
`-- Down Migration` section. Nothing rolls back automatically - a bad
migration that already ran needs either this or a new forward migration that
undoes it. Prefer the forward one on anything already deployed.

Writing the down section is not optional busywork: it is what makes a
migration testable (`db:migrate:down` then `db:migrate` should round-trip
cleanly) and what lets a failed release be backed out at all. A genuinely
irreversible migration - one that drops data it cannot reconstruct - should say
so in a comment rather than shipping an empty down section that silently
pretends to work.

## The baseline

`migrations/1_baseline.sql` is the old `SCHEMA` string verbatim. Every
statement in it is `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`,
so a database created by the pre-migrations code applies it as a no-op and
just records it - existing deployments adopt migrations by restarting, with no
dump and restore. A fresh database gets the same schema built from nothing.

Do not edit it, or any other already-applied file: node-pg-migrate matches on
filename, so an edited migration is never re-run on a database that already
has it, and the two databases silently drift. Add a new file instead. Renaming
one is the same mistake wearing a hat - the new name looks like a migration
that has never run.

Files are ordered by their numeric prefix, compared as a number rather than as
text, so `2_` runs before `10_` and there is no zero-padding to keep in sync.
`db:migrate:new` continues the sequence for you.

## Docker

The image copies `migrations/` in (see the [Dockerfile](../Dockerfile)) - a
container without it cannot boot. Two API containers starting at once are safe:
node-pg-migrate holds a postgres advisory lock for the run, so the second one
waits and then finds nothing to do.
