# Site gate

Optional lock on the frontend pages (`frontend/index.html`, `tiers.html`,
`user.html`) so only members of your Discord server with a specific role can
load the site at all. This is **not** API auth — every API route stays
exactly as reachable as before, including the public ones
(`GET /api/online`, `GET /api/leaderboard`, match history, profiles, etc.).
Only the frontend pages themselves are gated.

It piggybacks on the login flow the site already has
(`src/integrations/discord.js`, `frontend/js/auth.js`) and the bot
(`src/bot/`) — no new Discord app, no new scopes, just a role check made with
the bot's own token.

## How it works

1. Each gated page's `<head>` carries `<style>body{visibility:hidden}</style>`
   and loads `frontend/js/gate.js` right after `js/auth.js`.
2. `gate.js` waits for login state, then calls `GET /api/access`.
3. That route (`src/routes/api.js`) checks whether the caller is logged in
   and, if so, asks the bot (`src/bot/client.js`'s `hasRole`) whether their
   Discord guild member has `SITE_GATE_ROLE_ID`.
4. `gate.js` either reveals the page, or replaces it with a screen prompting
   Discord login (not logged in) or linking `SITE_GATE_DISCORD_INVITE` (logged
   in, missing the role).

If the check errors out or takes longer than 6 seconds, `gate.js` fails open
and shows the page — a broken gate should not take the whole site down.

`SITE_GATE_DISCORD_INVITE` also shows up as a permanent "JOIN DISCORD" link in
each page's header (`id="nav-discord-invite"` in `index.html`/`tiers.html`/
`user.html`, populated by that same `gate.js`) — visible to everyone who
reaches the real site, gated or not, not just people who got turned away.

## Config

| Env | Default | Why |
| --- | --- | --- |
| `SITE_GATE_ENABLED` | `true` | Master switch. Set to `false` to disable regardless of the rest. |
| `SITE_GATE_ROLE_ID` | *(unset — gate disabled)* | The role id required in `DISCORD_GUILD_ID`. Blank disables the gate even if `SITE_GATE_ENABLED=true`, same convention as `DISCORD_STATS_CHANNEL_IDS`. |
| `SITE_GATE_DISCORD_INVITE` | *(unset — no link shown)* | A `discord.gg` invite shown as a button on the "you don't have access" screen, so someone missing the role can join and ask for it (e.g. via a ticket channel once inside). |

The gate also needs `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` (see
[discord-bot.md](discord-bot.md)) — without a running bot there is nothing to
check roles with, so `src/domain/siteGate.js` treats the gate as off rather
than locking everyone out.

## Turning it off later

No code changes needed either way:

* Quick disable: set `SITE_GATE_ENABLED=false` (or blank `SITE_GATE_ROLE_ID`)
  and restart. `GET /api/access` starts reporting `enabled: false`, and
  `gate.js` just reveals the page.
* Full removal: delete `frontend/js/gate.js`, the `<style>` tag,
  `<script src="js/gate.js">` line and `#nav-discord-invite` link from each
  gated page, the `.discord-link` rules in `frontend/css/style.css`, the
  `GET /access` route in `src/routes/api.js`, `src/domain/siteGate.js`,
  `hasRole` in `src/bot/client.js`, and the `SITE_GATE_*` block in
  `src/config.js`.
