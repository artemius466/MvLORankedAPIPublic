# Deployment

## How it fits together

- The `api` container publishes port 3000 directly on the host (see
  `docker-compose.yml`'s `ports: ["3000:3000"]`) - no reverse proxy sits in
  front of it, and this stack does not terminate TLS.
- No app code changes are needed either way: auth is bearer-token only (see
  `src/auth/sessions.js`), there's no session cookie whose `secure` flag or
  `trust proxy` setting would need adjusting behind a proxy.

## 1. Point the app at the public address

`DISCORD_REDIRECT_URI` and `FRONTEND_URL` in `.env` are read by
`src/config.js` and must match the address clients actually reach, e.g.:

```
DISCORD_REDIRECT_URI=http://your-server-ip:3000/api/callback
FRONTEND_URL=http://your-server-ip:3000/
```

## 2. Update the Discord app's redirect URI

Discord rejects the OAuth callback unless the redirect URI it receives
exactly matches one registered on the app. In the
[Discord Developer Portal](https://discord.com/developers/applications) ->
your app -> OAuth2 -> Redirects, add the URI from step 1.

## 3. Bring the stack up

```bash
docker compose up -d --build
```

## Verifying

- `curl -I http://your-server-ip:3000/api/health` -> `200`.
- Log in through the frontend and confirm the Discord OAuth round trip
  completes end to end - this is what actually exercises the redirect URI,
  not just the health check.

## Adding HTTPS later

This stack doesn't terminate TLS itself. To put it behind a reverse proxy
(Caddy, nginx, etc.) again: don't publish port 3000 to the host, join the
`api` service to whatever network the proxy runs on, and point the proxy at
`api:3000`.
