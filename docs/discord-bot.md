# Discord bot

Optional module (`src/bot/`) that runs alongside the API in the same process
(started from `server.js`, right after `matchmaking.start()`). Disabled
entirely — no gateway connection, no commands registered — when
`DISCORD_BOT_TOKEN` is unset, so an existing deployment with no bot
configured keeps working unchanged.

This is a separate Discord application login from the OAuth app the API
already uses for player login (`DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`,
`src/integrations/discord.js`) — a bot needs its own bot-user token. Both can
point at the same Discord application (its bot tab has the token) or a
different one entirely.

## Inviting the bot

Invite it with both the `bot` and `applications.commands` OAuth2 scopes
(Developer Portal → OAuth2 → URL Generator), and give it, at minimum, **View
Channel**, **Send Messages** and **Embed Links** in whichever channel(s) you
list in `DISCORD_STATS_CHANNEL_IDS` — that's all the stats embed needs.
The slash commands need no channel-specific permissions beyond that same
baseline wherever they will be run. `/player` and `/match` are gated by the
Administrator check described below rather than by Discord channel
permissions; `/stats` is open to everyone.

## Config

| Env | Default | Why |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | *(unset — bot disabled)* | The bot user's login token, from the Discord Developer Portal's Bot tab. |
| `DISCORD_GUILD_ID` | *(unset — global commands)* | Registers the slash commands to this guild only, which propagates instantly. Left blank, they register globally instead, which Discord can take up to an hour to roll out everywhere. |
| `DISCORD_STATS_CHANNEL_IDS` | *(unset — stats embed disabled)* | Comma-separated channel ids to post/keep the live stats embed updated in. |
| `DISCORD_STATS_REFRESH_SECONDS` | `30` | How often the stats embed is refreshed. |

No privileged gateway intents are required (no `GuildMembers`, no
`MessageContent`) — slash command options and the invoking member's
permissions both arrive on the interaction payload itself, and the bot only
ever sends/edits messages in channels it's explicitly configured for.

## Live stats embed

For every channel id in `DISCORD_STATS_CHANNEL_IDS`, the bot posts one embed
and then keeps editing that same message every
`DISCORD_STATS_REFRESH_SECONDS` (`src/bot/statsBoard.js`) — no channel spam,
and no duplicate message after a restart, since the message id is persisted
in redis (`bot:statsMessage:<channelId>`) the same way matchmaking state is.
If the message was deleted or the bot lost access to it, the next refresh
just posts a fresh one.

Shown:

* **Online** — `GET /api/online`'s count (`src/domain/presence.js`), i.e.
  everyone who has sent a heartbeat recently, not just people in a match.
* **Region 0**–**Region 15** — one field per region (`matches.REGION_COUNT`;
  a stage's region is the leading digit of its id, e.g. `3customskymap` is
  region 3):
  * `Playing` — players currently in a `playing` match on that region's map.
  * `Queuing` — queued tickets that could still be matched onto that region,
    i.e. whose own reported ping for it is within their own `maxPing` (see
    [matchmaking.md](matchmaking.md)) — the same test the matchmaker itself
    uses to pair a ticket there, not anything the player picked explicitly.
* **Most popular regions / maps (7d avg)** — the top three of each by average
  players over the past week, from the sampled history described in
  [stats.md](stats.md). Omitted entirely until there is something to show.

The live half is computed by `matchmaking.regionStats()`, which reads the same
redis ticket and match state as the matchmaking queue itself — nothing new to
keep in sync.

## `/stats [window]`

Public, unlike the two admin commands below — nothing in it is privileged.
Ranks every region and map by average concurrent players over `Today`, `This
week` (default) or `This month`, splitting playing from queuing.

Note a queued player counts towards every region and map they would accept, so
these add up to more than the number of players online. That, and how the data
is collected, is [stats.md](stats.md).

## Admin commands

`/player` and `/match` are registered with `default_member_permissions` set
to Discord's own **Administrator** permission, so only admins see them in the
first place (a guild owner can loosen that per-command in Integrations
settings) — and the handler re-checks `interaction.memberPermissions` on
every call regardless, so that setting is enforced, not just a UI hint.
Anyone else gets an ephemeral "you need Administrator" reply. Both commands'
own replies are ephemeral too — visible only to the admin who ran them.

### `/player user:<@mention>`

Looks up that Discord user's ranked profile: elo, online status, account
creation date, and their 10 most recent matches (id, opponent, elo change,
stage, when). Replies with "has not logged into the ranked API yet" if they
have no `users` row.

### `/match id:<matchUid>`

Looks up one match by its `matchUid` (the same id `matches.matchUid` /
`MatchInfo.matchId` use elsewhere — see [matchmaking.md](matchmaking.md)):
stage, both players' elo change and replay link if they have one.

If the match hasn't already been reverted, the reply includes a **Revert
match** button. There is no separate blind "revert by id" command on
purpose — an admin has to look the match up and see it before touching its
elo. Clicking it asks for confirmation (Confirm / Cancel), and confirming:

1. Flags both of the match's `matches` rows `reverted_at`/`reverted_by`
   (`matches.markReverted()`) — the rows stay in history rather than being
   deleted, so what happened and who reverted it is still visible.
2. Subtracts each side's recorded change — rating, rating deviation and
   volatility alike — from their `users` row (`matchmaking.revertMatch()`).
   Being a pure subtraction, it composes with whatever either player has done
   since, so the revert never has to happen "in order." It leaves them where
   they would be if this match's numbers had never been added, which under
   Glicko-2 is very slightly different from replaying their history without
   it — see [rating.md](rating.md).

An already-reverted match shows who reverted it and when instead of the
button.
