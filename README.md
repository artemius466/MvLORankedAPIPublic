# MvLO Ranked API

Backend and web frontend for the **MvLO (Mario vs Luigi Online) ranked ladder**. The service handles Discord authentication for the game client and website, Glicko-2 ratings, Redis-backed matchmaking, leaderboards, player profiles, match history, announcements, bans, and an optional Discord bot.

## Features

- Discord OAuth2 login plus a device-login flow for the Unity game client
- Glicko-2 ratings with rating-deviation inflation and rating decay for inactive players
- Redis-backed matchmaking: queue, accept/decline, map veto, room handoff, liveness checks and forfeits
- Public leaderboard, player profiles, match details and match history
- Announcements rendered to both web and Unity rich text
- Player bans and an admin panel
- Photon Custom Authentication for the Photon Cloud client
- Optional Discord bot with slash commands and a live online/region stats embed
- Optional Discord role-based site gate
- Static frontend served from the same origin as the API

## Stack

- Node.js 22, Express 5
- PostgreSQL 16 (via `pg` + `node-pg-migrate`)
- Redis 8 (via `redis`)
- Vanilla JavaScript frontend (no build step)
- Docker Compose for deployment

## Quick start

### Docker Compose

```bash
cp .env.example .env
# Fill in the Discord credentials, Photon token, etc. in .env
docker compose up -d --build
```

The API and frontend are then available at <http://localhost:3000>.

### Local development

Requires Node.js 22+ and Docker (for the Postgres and Redis containers).

```bash
cp .env.example .env
npm install
npm run db:start
npm run redis:start
npm run dev
```

`npm run dev` loads `.env` and watches for file changes. Database migrations run automatically on server start.

## Configuration

Configuration is entirely environment-based. See [`.env.example`](.env.example) for the full list with comments and defaults, and [`src/config.js`](src/config.js) for how each value is used.

The most important variables:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Defaults to `production`; set to `development` to enable the dev-login helper |
| `PORT` | HTTP port (default `3000`) |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord OAuth2 application credentials |
| `DISCORD_REDIRECT_URI` | OAuth callback URL |
| `FRONTEND_URL` | Where users land after login |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `CORS_ORIGINS` | Comma-separated allowed origins, or `*` |
| `ADMIN_DISCORD_IDS` | Comma-separated Discord IDs allowed into the admin panel |
| `PHOTON_TOKEN` | Shared secret for Photon Custom Authentication |
| `DISCORD_BOT_TOKEN` | Bot token; blank disables the bot |
| `DISCORD_GUILD_ID` | Guild for instant slash-command registration and the site gate |
| `DISCORD_STATS_CHANNEL_IDS` | Channels that receive the live stats embed |
| `SITE_GATE_ENABLED` / `SITE_GATE_ROLE_ID` | Restrict the website to a Discord role |

## Database and migrations

SQL migrations live in [`migrations/`](migrations) and are applied exactly once on server boot.

```bash
npm run db:start      # start the dev Postgres container
npm run db:migrate    # apply migrations manually
npm run db:migrate:down
npm run db:migrate:new -- <name>
npm run db:psql       # open a psql shell
npm run db:reset      # wipe and recreate the dev database
```

See [`docs/migrations.md`](docs/migrations.md) for details.

## API overview

All JSON routes live under `/api`; the game client handshake also has top-level aliases.

### Public

- `GET /api/health`
- `GET /api/leaderboard`
- `GET /api/users/:id`, `GET /api/users/:id/matches`
- `GET /api/matches/:matchUid`
- `GET /api/online`, `POST /api/online`
- `GET /api/announcements`, `GET /announcements`
- `GET /api/access`
- `GET /api/matchmaking/estimate`, `GET /api/matchmaking/maps`

### Authentication

- `GET /api/login`, `GET /api/callback`, `GET /api/login/poll`
- `ANY /auth/init` (alias `/api/auth/init`) — game client handshake
- `ANY /auth/photon` (alias `/api/auth/photon`) — Photon Custom Authentication

### Authenticated user

- `GET /api/me/v2`, `POST /api/refresh`, `POST /api/logout`
- `PUT /api/me/bio`, `PUT /api/me/country`
- `GET /api/sessions`, `DELETE /api/sessions/:id`, `POST /api/sessions/logout-others`

### Matchmaking

- `POST /api/matchmaking/queue`, `GET /api/matchmaking/poll`
- `POST /api/matchmaking/accept`, `/decline`, `/ban`, `/room`, `/alive`, `/cancel`
- `GET /api/matchmaking/match`

### Admin

Requires a Discord ID listed in `ADMIN_DISCORD_IDS`.

- `GET /api/admin/users`, `GET /api/admin/matches`, `GET /api/admin/announcements`
- `POST /api/admin/users/:id/ban`, `POST /api/admin/users/:id/unban`
- `POST /api/admin/matches/:matchUid/revert`
- `POST /api/admin/announcements`, `PUT /api/admin/announcements/:id`, `DELETE /api/admin/announcements/:id`

## Documentation

- [`docs/matchmaking.md`](docs/matchmaking.md) — matchmaking flow and client protocol
- [`docs/unity-matchmaking.md`](docs/unity-matchmaking.md) — Unity client integration
- [`docs/rating.md`](docs/rating.md) — Glicko-2 ratings and decay
- [`docs/photon-custom-auth.md`](docs/photon-custom-auth.md) — Photon authentication setup
- [`docs/discord-bot.md`](docs/discord-bot.md) — bot commands and stats embed
- [`docs/site-gate.md`](docs/site-gate.md) — Discord role site gate
- [`docs/stats.md`](docs/stats.md) — activity and stats collection
- [`docs/https-deployment.md`](docs/https-deployment.md) — production deployment
- [`docs/migrations.md`](docs/migrations.md) — database migrations

## Tests

The verification scripts start the app in-process and need a running Postgres and Redis:

```bash
npm run db:start
npm run redis:start
npm run db:migrate

node tests/verify-photon-auth.js
node tests/verify-bans.js
node tests/verify-announcements.js
```

## Production notes

- The app is containerised: build with `docker compose up -d --build`.
- Set `NODE_ENV=production` (the default) and use strong, unique values for `POSTGRES_PASSWORD`, `DISCORD_CLIENT_SECRET` and `PHOTON_TOKEN`.
- Terminate TLS in front of the container; see [`docs/https-deployment.md`](docs/https-deployment.md).
