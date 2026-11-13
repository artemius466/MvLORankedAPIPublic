# Matchmaking

Eleven endpoints under `/api/matchmaking`. Queue tickets, pending/ready/playing
matches and match outcomes all live in **redis** (`src/domain/matchmaking.js`,
storage helpers at the top of that file, connection in `src/db/redis.js`).
See [Storage](#storage) below for exactly what lives under which key and how
concurrent requests are kept from corrupting each other.

A match only reaches postgres — a real elo change on both `users` rows plus a
`matches` history row for each side — once it reaches **playing** and settles
with a legitimate result (agreement, a disconnect forfeit, or one side simply
never uploading a replay while the other did — see
[Replays](#replays)). Everything before that (search, accept, the map veto,
room-code handoff) stays entirely in redis, same as before playing existed.

Every endpoint needs a session (`Authorization: Bearer <token>`) because the
queue is keyed by the caller's Discord id, **except `GET
/matchmaking/estimate` and `GET /matchmaking/maps`** — neither touches a
ticket of its own, so neither needs login. Every other endpoint without one
gets `401`.

## The flow

```
POST /matchmaking/queue          enters the queue (no map choice anymore)
   |
GET  /matchmaking/poll           every ~2s:  searching -> found
   |
POST /matchmaking/accept         or /matchmaking/decline
   |
GET  /matchmaking/match          every ~2s:  waiting -> ready -> playing -> ended
   |
   +-- ready, map not yet decided: the map veto -
   |     host bans first (POST /matchmaking/ban x2), then the guest
   |     (POST /matchmaking/ban x1) - see Maps below. Both sides keep
   |     polling /matchmaking/match to watch `mapVeto` update.
   |
   +-- ready, map decided (match.map != null):
   +-- isHost: true  ->  create the Photon room, POST /matchmaking/room
   +-- isHost: false ->  keep polling /matchmaking/match until roomCode arrives
   |
   +-- once you have a room code: POST /matchmaking/alive, continuously,
       for as long as the game is running, adding `result` once it concludes
```

`POST /matchmaking/cancel` is the exit at any point — though cancelling a
`playing` match forfeits it rather than a free walkout (see Playing & results
below).

## Rules

**Elo band.** A player is matched inside ±120 elo for their first minute in
queue. Every further whole minute of waiting widens the band by another 100
(120 → 220 → 320 …) up to a 1120 cap, after which they will pair with anyone.

Two players may pair as soon as the *wider* of their two bands covers the gap
between them, so a player who has waited long enough to expand actually gets
pulled a match instead of waiting for someone else to expand just as far.

**Elo stakes.** Ratings are [Glicko-2](rating.md), which already pays out more
for beating someone stronger and less for beating someone weaker. Each side is
shown its own `eloStake` once both sides have accepted, describing how this
particular match is tilted:

```json
{ "winMultiplier": 1.4, "lossMultiplier": 0.71, "favoured": true }
```

The lower-rated player wins more and loses less; the higher-rated one carries
the matching risk. Both multipliers are `1` when the match is even.

These are **not** a multiple of any fixed number of points — there is no such
number under Glicko-2. They are relative to this match's own average swing, so
the pair always averages 1, and they describe the asymmetry alone. How *big*
the match is in absolute terms depends mostly on how well established the two
ratings are: a new player's first match moves them several times further than a
veteran's hundredth, with no asymmetry involved at all. See [rating.md](rating.md).

The client can show "win big / lose little" the moment the match turns
`ready` — not on the accept prompt itself, which carries no `eloStake` at all
(see **Blind accept** below).

**Blind accept.** The accept prompt says nothing about who is on the other
side. While the match is `pending`, `MatchInfo` carries only the match itself
— region, `expiresInSeconds` — and drops `opponent`, `eloStake`,
`eloDifference` and `outsideBaseRange` entirely, so neither player can pick
their answer based on the opponent's name or rating. All four appear together
the moment both sides have accepted and the match is locked in, i.e. from
`ready` onwards.

The elo-derived three are held back for the same reason `opponent` is, not out
of caution: `eloDifference` *is* the opponent's rating once you know your own,
and `eloStake`'s multipliers invert back to the same number. `region` is not
held back — it says nothing about who the opponent is. `map` is a different
case again: it isn't withheld so much as not *decided* yet — see **Maps**
below, it doesn't exist until after `ready`.

**Maps.** Nobody picks a map before queuing anymore. Once a match is `ready`,
the two sides run a CS2-style exclusion (veto) over the same four-map pool
every match starts from:

1. The host excludes two maps, one `POST /matchmaking/ban` call each.
2. The guest excludes one more map.
3. Whichever map is left is the one played — no random draw needed with the
   pool at exactly four maps (host bans 2 + guest bans 1 + 1 left = 4). If the
   map pool ever grows past four, the same three bans still happen and
   whatever survives them is chosen at random, same rule the map draw used
   before this feature existed.

Turns are strict: only the player whose turn it is may call
`/matchmaking/ban`, and only with a map that hasn't been banned yet (`403
not_your_turn` / `409 map_already_banned` otherwise — see endpoint 6 below).
Both sides watch it happen live via `mapVeto` on the `/matchmaking/match`
poll (see **MatchInfo** in Shapes) — there's no dedicated poll for it, the
same poll that carries `roomCode` carries this too. The moment the pool is
down to one, `mapVeto` disappears and `MatchInfo.map` is filled in instead.
The host cannot publish a room code (`POST /matchmaking/room`) until the map
is decided — `409 map_not_decided` otherwise — so the veto always finishes
before the Photon room does.

**Regions.** A player never picks a region directly — send a ping reading for
*every* region on `/matchmaking/queue` and every poll after it (`pings`,
positional by region index), plus the worst ping you're willing to accept
(`maxPing`). A region is usable for a pairing only if *both* sides' own
reading for it is within their own `maxPing`; among whichever regions clear
that bar for both players, the one minimizing the *worse* of the two players'
pings there is picked (ties go to the lower combined ping, then to the lowest
region index, so it never matters which side's request happens to compute it).

For example: player A wants under 100ms and reads 60ms on Europe, 90ms on US
East; player B wants under 150ms and reads 200ms on Europe, 120ms on US East.
Europe is out — it's over B's 150ms limit even though it's great for A; US
East clears both limits, so that's what the match uses. A pairing with no
region that clears both limits simply cannot happen — unlike before this
feature existed, there is no equivalent "no shared map" failure anymore, since
every pair is compatible on maps by construction (see **Maps** above). The
chosen region is reported on `MatchInfo.region` from `pending` on — see
**Blind accept** above.

**Host.** Decided the instant the match forms — before either side has even
answered the accept prompt, though not revealed until `ready` (see **Blind
accept** above). Picked uniformly at random between the two players and fixed
for the life of the match; ping already did its one job picking the region
and has nothing left to say about which side hosts it. The same host/guest
split runs the map veto above once the match is `ready`.

**Playing & results.** `ready` is the room-code handoff, preceded by the map
veto above; the match only becomes `playing` once **both** players have
called `/matchmaking/alive` against it — a room code has to exist first (which
itself needs the map decided first — see **Maps** above), and one side
confirming alone just leaves it `ready` until the other does too. From there:

* **Keep sending `/matchmaking/alive`, from both sides, for the whole game.**
  Go quiet for `MM_ALIVE_STALE_SECONDS` and the match ends in a forfeit — a
  real, elo-affecting loss for you, a win for whoever kept sending it. A
  player who never sends it at all is judged against the moment the match
  became `playing`, so silently never showing up still eventually forfeits.
  Calling `/matchmaking/cancel` while `playing` is treated exactly the same
  way (`forfeited` / `opponent_forfeited`) — it is not a free walkout the way
  cancelling before a game starts is.
* **Report the result independently.** Once your own game has concluded,
  include `result` on an `/matchmaking/alive` call: `true` if the host won,
  `false` if the other player did. Each side's report is private until both
  are in — the API never tells you what the *other* side reported before you
  submit your own, only whether they have submitted at all, so a dishonest
  client cannot just copy whatever its opponent said.
* **Agreement settles the match with elo**; both ratings are updated by
  [Glicko-2](rating.md), matching the `eloStake` shown from `ready` onwards
  (see Elo stakes above) exactly — nothing about it was advisory. Note the two
  sides' changes are **not** equal and opposite: a settled rating moves less
  than an unsettled one, so a newcomer beating a veteran can gain far more than
  the veteran loses. A disconnect forfeit settles the same way.
* **Disagreement settles it with nothing.** If the two reports do not match,
  someone is lying — the match ends for both with no elo change and no
  history entry, same as if it had never happened.
* **A match cannot run forever.** `MM_MATCH_MAX_SECONDS` after it became
  `playing` — not refreshed by anything, including both sides still actively
  sending `/alive` — it is force-ended with no elo and no history if nobody
  has settled it by then.
* **A missing replay overrides everything above.** If exactly one side ever
  attached a `replayUrl` to an `/alive` call, that side wins
  (`opponent_no_replay` / `no_replay`) no matter what self-reports, a
  disconnect, a cancel, a dispute or the hard cap would otherwise have
  decided — proof beats an unverifiable claim. Both sides supplying one, or
  neither, changes nothing; the outcome above stands as described. See
  [Replays](#replays).

## Timings

| Setting | Default | Env |
| --- | --- | --- |
| Base elo band | ±120 | `MM_BASE_ELO_RANGE` |
| Expansion per interval | +100 | `MM_ELO_EXPANSION_STEP` |
| Expansion interval | 60s | `MM_EXPANSION_INTERVAL_SECONDS` |
| Max band | 1120 (0 = uncapped) | `MM_MAX_ELO_RANGE` |
| Accept window | 20s | `MM_ACCEPT_SECONDS` |
| Ticket goes stale after | 15s without a poll | `MM_TICKET_STALE_SECONDS` |
| Ready match TTL | 120s | `MM_READY_TTL_SECONDS` |
| Outcome readable for | 60s | `MM_OUTCOME_TTL_SECONDS` |
| `/alive` goes stale after | 20s without one | `MM_ALIVE_STALE_SECONDS` |
| Max time `playing` (non-refreshable) | 1800s (30 min) | `MM_MATCH_MAX_SECONDS` |

`MM_ELO_BASE_CHANGE` used to be here, setting the flat points a win or loss was
worth. Glicko-2 has no such constant — how far a result moves you falls out of
both players' rating deviations — so it configures nothing and has been
removed. The knobs that shape rating movement now live in [rating.md](rating.md).

**Poll at least every 2 seconds.** A ticket that goes 15s without a poll is
swept out of the queue. The one exception is the accept window: while a match is
waiting on a decision, the 20s accept deadline governs instead, so a player
staring at the accept prompt is never cut short by the stale sweep. Once
`playing`, it is `/alive` specifically that must not go quiet for 20s, per
Playing & results above — the generic queue staleness sweep is turned off for
that state.

---

## Shapes

Objects reused across more than one endpoint, documented once here and
referenced by name below.

### MapInfo

```json
{ "id": "ghost_house", "name": "Ghost House" }
```

| Field | Type | Why |
| --- | --- | --- |
| `id` | string | What you send back in `POST /matchmaking/ban`'s `mapId`. Stable, url-safe. |
| `name` | string | Human label — the only field this object exists to add over a bare id. |

### RegionInfo

```json
{ "id": 1, "name": "🇺🇸 USA, East" }
```

| Field | Type | Why |
| --- | --- | --- |
| `id` | integer | Which position in `queue.pings`/`queue.maxPing` this region is — send your reading for it at that index. Never chosen by the client; see **Regions** in Rules. |
| `name` | string | Human label for display. |

### PlayerInfo (the `opponent` object)

Only present on a match that both sides have already accepted — see **Blind
accept** in Rules.

```json
{
  "id": "216743...",
  "username": "luigi",
  "displayName": "Luigi",
  "avatarUrl": "https://cdn.discordapp.com/avatars/...",
  "elo": 1080,
  "ping": 35
}
```

| Field | Type | Why |
| --- | --- | --- |
| `id` | string | Discord id. Links to `GET /users/:id` and `/users/:id/matches` if you want a fuller profile. |
| `username` | string | Discord username. |
| `displayName` | string | Discord global display name (falls back to `username` if unset). What to actually show in the UI. |
| `avatarUrl` | string | Pre-built CDN URL (uploaded avatar, or the correct numbered default) — the client never has to compute the default-avatar index itself. |
| `elo` | integer | Opponent's rating right now, for the pre-game screen. |
| `ping` | integer (ms) | Opponent's reported ping *for the region this match is on* (`MatchInfo.region`) — not their best or most recent overall, since the region is already fixed by the time this appears. |

### EloStake

```json
{ "winMultiplier": 1.4, "lossMultiplier": 0.71, "favoured": true }
```

| Field | Type | Why |
| --- | --- | --- |
| `winMultiplier` | number | Elo gained on a win, relative to this match's average swing. |
| `lossMultiplier` | number | Elo lost on a loss, relative to the same. |
| `favoured` | boolean | `true` when *you* are the underdog getting the boosted multipliers, so the client can pick "underdog" vs "favourite" copy without comparing elo itself. |

The two always average `1`, so they say how the match is tilted and nothing
about its absolute size — see **Elo stakes** in Rules. Both are exactly `1` on
an even match, which is nothing to show; `outsideBaseRange` on `MatchInfo` is
the flag for whether it is worth showing at all.

Like `opponent`, this object only appears once both sides have accepted — see
**Blind accept** in Rules.

### QueueInfo (`status: "searching"`)

```json
{
  "pings": [60, 90],
  "maxPing": 100,
  "elo": 1000,
  "waitedSeconds": 75,
  "eloRange": 220,
  "nextExpansionInSeconds": 45
}
```

| Field | Type | Why |
| --- | --- | --- |
| `pings` | integer[] (ms) | Your latest reported ping per region, positional by `RegionInfo.id` (from the `pings` query param, most recent wins). |
| `maxPing` | integer (ms) | The worst ping you said you'd accept (from `maxPing`, most recent wins) — together with `pings`, decides which regions you can still be matched onto. See **Regions** in Rules. |
| `elo` | integer | Your current rating — the center of `eloRange`. |
| `waitedSeconds` | integer | How long you've been in queue. Drives a "widening search…" hint. |
| `eloRange` | integer | The elo band you're matchable within *right now* (grows over time — see Rules). |
| `nextExpansionInSeconds` | integer \| null | Countdown to the next widening. `null` once `eloRange` has hit `MM_MAX_ELO_RANGE` and stopped growing. |

### MatchInfo (the `match` object — `"found"` / `"waiting"` / `"ready"`)

Two shapes, same object. While the match is still being accepted (`"found"` /
`"waiting"`) it carries the match and region, but nothing about the opponent
or the map — the map veto (see **Maps** in Rules) hasn't even started yet:

```json
{
  "matchId": "Zx9K2mQpR7Ab",
  "region": { "id": 1, "name": "🇺🇸 USA, East" },
  "expiresInSeconds": 18
}
```

Once both sides have accepted (`"ready"`, and every later state the match poll
reports) four more fields appear, though `map` — a fifth — only joins them once
the veto has actually settled on one:

```json
{
  "matchId": "Zx9K2mQpR7Ab",
  "region": { "id": 1, "name": "🇺🇸 USA, East" },
  "expiresInSeconds": 90,
  "opponent": { "...": "PlayerInfo" },
  "eloStake": { "winMultiplier": 1, "lossMultiplier": 1, "favoured": false },
  "eloDifference": 80,
  "outsideBaseRange": false,
  "map": { "id": "ghost_house", "name": "Ghost House" }
}
```

| Field | Type | Why |
| --- | --- | --- |
| `matchId` | string | Opaque id for correlating client-side logs/analytics with `lastMatch.matchId` later. Never sent back to the server by the client. |
| `region` | RegionInfo | The region this match will be played on, chosen from both sides' `pings`/`maxPing` — see **Regions** in Rules. Present from `"found"`/`"waiting"` on; use it to pick a Photon region before the room exists. |
| `map` | MapInfo | **From the moment the map veto settles on one** (see **Maps** in Rules and `MapVetoInfo` below) — always at least a poll or two after `ready` itself, never at `pending`/`waiting`. |
| `expiresInSeconds` | integer | Countdown to the next thing happening: the accept deadline while `status` is `"found"`/`"waiting"`, or how long the ready match stays claimable while `status` is `"ready"`. |
| `opponent` | PlayerInfo | **From `ready` on.** Who you're playing. |
| `eloStake` | EloStake | **From `ready` on.** See above. |
| `eloDifference` | integer | **From `ready` on.** `\|your elo − opponent elo\|`. Raw number behind `outsideBaseRange`, for a "closely matched" / "huge upset" badge. |
| `outsideBaseRange` | boolean | **From `ready` on.** `true` if this pairing only exists because someone's wait widened the band past the default ±120 — i.e. whether `eloStake` is worth showing at all. |

The four opponent-reveal fields are **absent**, not null or zero, while the
match is still pending — a client that models them as optional gets the accept
prompt right for free. See **Blind accept** in Rules for why they are
withheld. `map` is absent for a different reason (see above) and only ever
joins them after `ready`, never before.

### MapVetoInfo (`mapVeto`, only on the `"ready"` match poll)

Present alongside `MatchInfo` on the `/matchmaking/match` `"ready"` response
(see endpoint 5) for as long as `match.map` is still unset — gone, not null,
the instant the veto settles, since `match.map` has the answer at that point.

```json
{
  "turn": "host",
  "yourTurn": true,
  "remainingMaps": [
    { "id": "ghost_house", "name": "Ghost House" },
    { "id": "beach_ruins", "name": "Beach Ruins" }
  ],
  "bannedMaps": [
    { "id": "jungle", "name": "Jungle" },
    { "id": "grassland", "name": "Grassland" }
  ]
}
```

| Field | Type | Why |
| --- | --- | --- |
| `turn` | string | `"host"` or `"guest"` — whose turn it is to call `POST /matchmaking/ban` next. The host bans first, twice; then the guest, once — see **Maps** in Rules. |
| `yourTurn` | boolean | Convenience for `turn === "host" && isHost`, or `turn === "guest" && !isHost` — spares the client from comparing `turn` against its own `isHost`. |
| `remainingMaps` | MapInfo[] | Not banned yet — what `POST /matchmaking/ban`'s `mapId` may legally be right now. Shrinks by one with each ban; once it's down to one, `match.map` is filled in and this object disappears. |
| `bannedMaps` | MapInfo[] | Banned so far, oldest first. Empty on the very first `"ready"` poll. |

### LastMatchInfo (`lastMatch`, and the body of `status: "ended"`)

```json
{ "matchId": "Zx9K2mQpR7Ab", "reason": "opponent_declined", "requeued": true }
```

| Field | Type | Why |
| --- | --- | --- |
| `matchId` | string | Which match this refers to. |
| `reason` | string | Why it ended — see the table below. |
| `requeued` | boolean | `true` if the server already put you back in the queue with your original wait time intact (see Rules). `false` means you are all the way out; call `/matchmaking/queue` again to search. |

| `reason` | Meaning | Elo / history |
| --- | --- | --- |
| `declined` / `opponent_declined` | Someone pressed decline | no |
| `timeout` / `opponent_timeout` | Someone let the accept window run out | no |
| `left` / `opponent_left` | Someone cancelled or stopped polling **before** the match was `playing` | no |
| `expired` | Ready match went unclaimed for `MM_READY_TTL_SECONDS` | no |
| `won` / `lost` | Both sides independently reported the same result | **yes** |
| `disconnected` / `opponent_disconnected` | Someone went quiet on `/alive` for `MM_ALIVE_STALE_SECONDS` while `playing` | **yes** |
| `forfeited` / `opponent_forfeited` | Someone called `/matchmaking/cancel` while `playing` | **yes** |
| `both_disconnected` | Both sides went quiet on `/alive` at once — no legitimate winner | no |
| `disputed` | The two sides' reported results disagreed — someone is lying | no |
| `match_expired` | `MM_MATCH_MAX_SECONDS` ran out on a `playing` match with no result | no |
| `no_replay` / `opponent_no_replay` | Exactly one side ever attached a `replayUrl` to an `/alive` call — the other loses regardless of what the row above would otherwise say | **yes** |

The un-prefixed form means *you* caused it (or, for `won`/`lost`, is simply
your own result — there is no fault framing once a real game happened). Only
the **yes** rows above write a `matches` history row and change either
player's `elo`; every other ending leaves both untouched. **`lastMatch` is
reported exactly once** — the poll that returns it also clears it, so act on
it there and then.

`no_replay` / `opponent_no_replay` is not a separate ending so much as an
override of every row above it: it is evaluated first, and whenever it
applies it replaces whatever `reason` the match would otherwise have ended
with — including rows that normally carry no elo/history, like `disputed` or
`match_expired`. It only fires when the two sides' replay submissions are
lopsided (one has one, the other doesn't); see [Replays](#replays).

---

## Endpoints

### 1. `POST /api/matchmaking/queue`

Enters the queue. Refused if you are already queued or in a match — cancel
first. No map choice anymore — see **Maps** in Rules; the map is decided
later, by veto, once a match is `ready`.

Request body:

| Field | Type | Required | Why |
| --- | --- | --- | --- |
| `pings` | integer[] (ms) | no (default: worst case, 5000, for every region) | One reading per region, positional by `RegionInfo.id` — e.g. `[60, 90]` for a 2-region deployment. Seeds region viability immediately, in case you're matched before your first poll; a region left out defaults to the worst possible reading for it, same as `maxPing` below defaulting to no limit. |
| `maxPing` | integer (ms) | no (default: no limit, 5000) | The worst ping you'll accept, region by region — see **Regions** in Rules. Left at its default alongside a default-filled `pings`, every region is usable (5000 clears a 5000 limit); set it once you actually know your readings. |

Returns the same body as `/matchmaking/poll` — usually `{ "status": "searching", "queue": QueueInfo }`, but already `{ "status": "found", "match": MatchInfo, "response": "pending" }` if a compatible opponent was already waiting.

* `409 match_in_progress` — you already have a match; accept, decline or cancel
  it first.
* `409 already_queued` — you are already searching; cancel via
  `/matchmaking/cancel` first if you want to change your options.

### 2. `GET /api/matchmaking/poll?pings=60,90&maxPing=100`

The search poll.

| Query param | Type | Required | Why |
| --- | --- | --- | --- |
| `pings` | integer, comma-separated (ms) | no, but always send it | One reading per region, positional by `RegionInfo.id` — refreshes your ticket's readings while you search (see **Regions** in Rules). Omitting the param leaves every prior reading in place. Sending it replaces *all* of them at once — same as at queue time, a region missing from the list you send resets to worst-case, so send a full reading for every region every time you send this at all, never just the ones that changed. |
| `maxPing` | integer (ms) | no, but send it if it can change | Refreshes the worst ping you'll accept. Same "last known value sticks" behavior as `pings`. |

Response is one of:

```json
{ "status": "searching", "queue": { "...": "QueueInfo" } }
```
```json
{ "status": "found", "response": "pending", "match": { "...": "MatchInfo" } }
```
```json
{ "status": "idle" }
```

`response` is your own recorded answer for the match just found — always
`"pending"` the instant it appears, `"accepted"` if you'd already accepted it
(e.g. you kept calling this endpoint instead of switching to
`/matchmaking/match`).

`{ "status": "idle" }` means you are not in matchmaking at all — cancelled, or
swept for not polling. (Unlike before this moved to redis, a server restart no
longer does this on its own — the queue survives it. See
[Storage](#storage).)

Any of the three may also carry `lastMatch`: `LastMatchInfo`, explaining how
the previous match ended.

### 3. `POST /api/matchmaking/accept`

No body. Returns the `/matchmaking/match` payload — `waiting` if the opponent
has not answered, `ready` if they already had.

* `409 no_pending_match` — nothing to accept (it expired, or they declined
  first).

### 4. `POST /api/matchmaking/decline`

No body. Ends the match and takes you out of matchmaking:

```json
{ "status": "ended", "matchId": "Zx9K2mQpR7Ab", "reason": "declined", "requeued": false }
```

(`LastMatchInfo` plus the `status` field.) Your opponent is put back in the
queue. Neither of you can be paired with the other again for 60 seconds, so
nobody gets the same rejected match twice.

* `409 no_pending_match` — same as accept.

### 5. `GET /api/matchmaking/match?pings=60,90&maxPing=100`

The match poll, from the moment you accept. Both host and guest stay on it.

| Query param | Type | Required | Why |
| --- | --- | --- | --- |
| `pings` | integer, comma-separated (ms) | no | Same as `/matchmaking/poll`. The region is already fixed by the time a match exists, so this no longer changes anything about *this* match — it's still useful to keep sending, since `opponent.ping` on `MatchInfo` reflects whatever your ticket's reading is for the match's region. |
| `maxPing` | integer (ms) | no | Same caveat as `pings` — refreshed for next time you queue, not used by the match already in progress. |

Response is one of:

```json
{ "status": "waiting", "match": { "...": "MatchInfo" }, "accepted": true, "opponentAccepted": false }
```
```json
{
  "status": "ready",
  "match": { "...": "MatchInfo" },
  "isHost": true,
  "hostId": "216743...",
  "roomCode": null,
  "mapVeto": { "...": "MapVetoInfo" }
}
```
```json
{
  "status": "playing",
  "match": { "...": "MatchInfo" },
  "isHost": true,
  "hostId": "216743...",
  "roomCode": "MVLO-7F3K",
  "resultSubmitted": false,
  "opponentResultSubmitted": true
}
```
```json
{ "status": "ended", "matchId": "Zx9K2mQpR7Ab", "reason": "opponent_declined", "requeued": true }
```
```json
{ "status": "none" }
```

| Field | Type | Why |
| --- | --- | --- |
| `accepted` | boolean | Whether *you* have accepted yet — lets the client keep showing your own accept prompt vs. a "waiting for you" state correctly even after a refresh. |
| `opponentAccepted` | boolean | Whether the opponent has. Drives a "waiting for opponent…" spinner. |
| `isHost` | boolean | Whether *you* won the host election. Never decide this locally. |
| `hostId` | string | The elected host's id, for display even on the guest's client. |
| `roomCode` | string \| null | `null` until the host publishes one (endpoint 7) — which it cannot do until the map veto below has settled (`match.map != null`). The guest keeps polling this endpoint until it isn't. |
| `mapVeto` | MapVetoInfo | **Only while `match.map` is still unset** — see endpoint 6. Gone once it's decided. |
| `resultSubmitted` | boolean | Whether *your* `/matchmaking/alive` result has been recorded yet. |
| `opponentResultSubmitted` | boolean | Whether the opponent's has — **not** what they actually reported. See Playing & results above for why that value is withheld until you've submitted your own. |

`{ "status": "playing" }` only appears once **both** players have called
`/matchmaking/alive` at least once (see endpoint 8) — polling this endpoint
alone never triggers it, and neither does just one side confirming.
`{ "status": "none" }` means there is no match to
report — go back to `/matchmaking/poll`. The `ended` shape is `LastMatchInfo`
plus `status`, same one-shot semantics as `lastMatch` elsewhere.

### 6. `POST /api/matchmaking/ban`

The map veto (see **Maps** in Rules). Only usable once `status` is `ready`,
and only by whoever `mapVeto.turn` currently names — the host bans first,
twice; then the guest, once.

Request body:

| Field | Type | Required | Why |
| --- | --- | --- | --- |
| `mapId` | string | yes | Must be one of `mapVeto.remainingMaps`' ids — anything already banned, or never in the pool, is rejected. |

Returns the `ready` payload (see endpoint 5) with the ban applied — `mapVeto`
updated to the next turn, or gone entirely (replaced by `match.map`) if that
was the last ban needed.

* `403 not_your_turn` — it's the other player's turn (or the veto hasn't
  started/has already finished).
* `400 unknown_map` — `mapId` isn't one of the game's maps at all.
* `409 map_already_banned` — `mapId` was legal but is not in
  `mapVeto.remainingMaps` anymore.
* `409 map_already_decided` — the veto already settled on a map; nothing left
  to ban.
* `409 no_maps_left` — refused because it would ban the only map still
  standing — normally unreachable given the pool size, kept as a guard.
* `409 no_ready_match` — the match is not `ready` (or no longer exists).

### 7. `POST /api/matchmaking/room`

Host only, once `status` is `ready` **and** the map veto above has settled
(`match.map != null`).

Request body:

| Field | Type | Required | Why |
| --- | --- | --- | --- |
| `roomCode` | string | yes, ≤64 chars after trim | Opaque to the API — it only relays this to the guest. Whitespace is trimmed for you. |

Publishing also refreshes the match TTL so the guest has a full window to
read it. Returns the `ready` payload (see endpoint 5) with `roomCode` filled
in.

* `403 not_host` — you are the guest; wait for the code instead.
* `400 invalid_room_code` — empty or over 64 characters.
* `409 map_not_decided` — the map veto (endpoint 6) hasn't settled yet.
* `409 no_ready_match` — the match is not ready (or no longer exists).

### 8. `POST /api/matchmaking/alive`

The heartbeat, sent by both players for the whole time the game is running.
Requires a room code to already exist — call it once you've actually created
or joined the Photon room, not before.

Request body:

| Field | Type | Required | Why |
| --- | --- | --- | --- |
| `result` | boolean | no | Include it once *your* game has concluded. `true` = the host won, `false` = the other player did. Omit it on every call before that — a plain heartbeat with no opinion yet. |
| `replayUrl` | string, ≤2048 chars | no | Where *your* recording of the match can be downloaded from. This API does not host replays itself — upload it to your own storage/CDN first and pass the resulting URL here. Only accepted together with `result`; a bare heartbeat cannot carry one. |

```json
{ "result": true, "replayUrl": "https://replays.example.com/abc123.rec" }
```

The `playing` clock described in Playing & results above only starts once
**both** players have called this at least once against a `ready` match —
one side confirming alone just leaves it `ready` until the other does too,
same as promoting to `ready` itself needs both accepts. Every call after
that just refreshes your liveness and, once you include `result`, records
your independent report (and, if included, your `replayUrl` — see
[Replays](#replays) below for what happens to it).

Returns the same payload as `/matchmaking/match` (endpoint 5) — `playing`
while the match is still going, `ended` the instant your own report (or the
opponent's disconnect, or a dispute, or the hard cap) settles it.

* `400` — `result` present but not a boolean, or `replayUrl` present but not a
  non-empty string ≤2048 characters, or `replayUrl` sent with no `result`
  alongside it.
* `409 no_active_match` — no match, or it isn't `ready`/`playing` (e.g. you
  are still mid-accept).
* `409 room_not_ready` — the match is `ready` but the host has not published
  a room code yet; there is nothing to be "playing" against.

### Replays

This API never handles the replay file itself — `replayUrl` is opaque to it,
just a string it stores and hands back later. It is only ever *linked* from a
`matches` history row once the match actually **settles with a legitimate
result** (`won`/`lost` or a disconnect forfeit — see the `reason` table
above), same as elo only applies on those rows.

Each side's replay is independent: you can submit yours and your opponent can
submit theirs without one (or vice versa) — the detail endpoint's
`players[].replayUrl` below is `null` for whichever side never sent one.

**Submitting one is not optional in practice.** The moment a match settles,
whichever sides' replay submissions are lopsided — one player attached a
`replayUrl` to an `/alive` call, the other never did — decides the match
outright in the uploader's favour (`opponent_no_replay` for them, `no_replay`
for the other side), overriding whatever self-reports, a forfeit, a
disconnect, a dispute, or even the hard time cap would otherwise have
produced (see the `reason` table above). This is evaluated fresh every time a
match ends, so it also turns a would-be `disputed` or `match_expired` ending
— normally no elo, no history — into a real, elo-affecting result whenever
exactly one side has proof. A match never gets penalized either way for
replays if **both** sides submitted one, or **neither** did; only the
one-sided case matters. A player who never intends to record at all should
expect to lose every match they'd otherwise have won, the instant their
opponent uploads one and they don't.

### `GET /api/matches/:matchUid`

The detailed view a click on a match history row opens — both sides of one
real match at once. No session required. `matchUid` is the same id as
`MatchInfo.matchId`/`LastMatchInfo.matchId` above, and is also returned as
`matchUid` on each row of `GET /users/:id/matches` (undocumented here — see
`src/domain/matches.js` — this is the one endpoint under `/matches` rather
than `/matchmaking` that this doc covers, since it exists purely to round out
the history rows that endpoint returns).

```json
{
  "match": {
    "matchUid": "Zx9K2mQpR7Ab",
    "stage": "3customskymap",
    "playedAt": "2026-08-01T20:14:03.000Z",
    "players": [
      { "id": "216743...", "name": "Mario", "avatarUrl": "https://cdn.discordapp.com/avatars/...", "eloDelta": 14, "replayUrl": "https://replays.example.com/abc123.rec" },
      { "id": "552891...", "name": "Luigi", "avatarUrl": "https://cdn.discordapp.com/embed/avatars/3.png", "eloDelta": -10, "replayUrl": null }
    ]
  }
}
```

| Field | Type | Why |
| --- | --- | --- |
| `matchUid` | string | Same id as `MatchInfo.matchId` — round-trips back into this same endpoint. |
| `stage` | string | Raw stage id (see [Valid ids](#valid-ids)) — resolve to a display name client-side, same as `matches.stage` everywhere else it's returned. |
| `players` | Player[] (2) | Both sides, order not meaningful — match them up by `id` if you need to tell "you" from "them". |
| `players[].name` | string | Live Discord display name if that player still has an account row, otherwise the name snapshotted at match time. |
| `players[].avatarUrl` | string | Live avatar if they still have an account row, otherwise the computed default. |
| `players[].eloDelta` | integer | That side's own elo change — positive is a win. |
| `players[].replayUrl` | string \| null | Exactly whatever that side sent as `replayUrl` on `/matchmaking/alive` — this API does not host or validate the file itself, see [Replays](#replays). `null` if that side never sent one. |

* `404` — no match with this id (or one leg of it hasn't landed yet — see
  Storage's note on the two-row write not being atomic).

### 9. `POST /api/matchmaking/cancel`

No body. Leaves the queue, and abandons a match if one had already been
found — the opponent gets `opponent_left` and is requeued.

**Exception: cancelling a `playing` match is a forfeit, not a free walkout.**
The opponent gets `opponent_forfeited` and a real elo win with a history
entry; you get `forfeited` and the matching loss. This is deliberate — the
`/alive` disconnect timeout exists to catch someone quitting without saying
so, and this endpoint has to be the same instead of a fast, penalty-free way
to dodge that.

```json
{ "ok": true, "left": true }
```

| Field | Type | Why |
| --- | --- | --- |
| `ok` | boolean | Always `true` — this endpoint has no failure mode worth reporting. |
| `left` | boolean | `false` just means there was nothing to cancel; it is safe to call repeatedly, e.g. from `OnApplicationQuit`. |

### 10. `GET /api/matchmaking/estimate`

Read-only wait estimate for a client deciding whether to queue at all. No
session required. Maps no longer factor in — there is nothing left to choose
before queuing (see **Maps** in Rules), so this simply looks at the whole
queue.

There is no historical log of past match-formation times to draw an estimate
from — a match is not recorded anywhere until it reaches `playing` (see
above). Instead this looks at who is *currently* searching and averages how
long they have already been waiting, as a proxy for how long a new arrival
would wait too.

```json
{ "estimate": "Estimated time: 01:35" }
```

or, if nobody is currently searching:

```json
{ "estimate": "Currently no one is queueing" }
```

### 11. `GET /api/matchmaking/maps`

The full map pool a match can be played on — what the veto (endpoint 6) bans
down from. No session required; mainly useful for a client that wants to show
the pool somewhere before a match even exists.

```json
{ "maps": [MapInfo, ...] }
```

## Valid ids

Maps: derived from `matches.BASE_MAPS`, the same pool the ruleset page lists,
so there is one source of truth — fetch the current list from `GET
/matchmaking/maps` rather than hard-coding it, since it changes as maps are
added or retired.

Regions are not an id a client validates against — `pings`/`maxPing` are
plain numbers, positional by whatever `matches.REGION_COUNT` currently is, and
every `MatchInfo.region` names the one actually in play. There is no request
that lists regions on their own today; read them off `RegionInfo` wherever it
appears (currently only `MatchInfo.region`).

---

## Storage

Everything above is served out of **redis**, not process memory. Config is
`REDIS_URL` (`src/config.js`), dev instance via `./start-redis-dev.sh` /
`npm run redis:start` (see the repo root). Keys, all under an `mm:` prefix:

| Key | Type | Holds |
| --- | --- | --- |
| `mm:ticket:<userId>` | string (JSON) | One queued/matched player: their options, elo snapshot, per-region `pings`/`maxPing`, `queuedAt`/`lastSeenAt`/`aliveAt`, `matchId` if paired, and their `avoid` cooldown map. |
| `mm:tickets` | set | Every `userId` with a live ticket — lets a sweep enumerate tickets without scanning the whole keyspace. |
| `mm:match:<matchId>` | string (JSON) | A pending/ready/playing match: region, both player ids, state, timestamps (including `playingStartedAt`/`hardExpiresAt` once `playing`), host (decided at creation — see **Host** in Rules), room code, and the map veto (`mapPool` snapshotted at creation, `mapBans` in ban order, `map`/`stageName` once decided — see **Maps** in Rules). |
| `mm:match:<matchId>:responses` | hash | `userId -> "pending" \| "accepted"`. Kept separate from the match blob so each accept is one atomic `HSET` — see below. |
| `mm:match:<matchId>:results` | hash | `userId -> "true" \| "false"`, each side's independent self-reported winner while `playing`. Separate for the same atomicity reason as `responses`. |
| `mm:match:<matchId>:replays` | hash | `userId -> replayUrl`, for whichever side(s) sent one alongside their `result` (see `/matchmaking/alive`). Read by `finishPlaying()` right before it writes the `matches` history rows, then torn down with the rest of the match's keys either way. |
| `mm:matches` | set | Every live `matchId`, same purpose as `mm:tickets`. |
| `mm:outcome:<userId>` | string (JSON) | The one-shot `lastMatch`/`ended` payload. Has a plain redis `EX` TTL of `MM_OUTCOME_TTL_SECONDS` instead of being swept explicitly. |

Tickets and matches also carry a generous safety-net TTL on top of the
explicit sweeps described in Timings, pinned to the same `lastSeenAt`/
`expiresAt` fields those sweeps use. Under normal polling it never fires —
it exists purely so a killed server process can't strand a key in redis
forever.

**Why this instead of a naive port of the old in-memory Maps:** three races
actually matter once reads and writes can interleave (they could not before,
when this was one single-threaded event loop with no `await` mid-mutation):

1. **Both players accepting (or reporting a result) at the same moment** —
   the common case, not an edge case. `responses` and `results` each live in
   their own hash specifically so every accept/report is a single atomic
   `HSET`; neither side's answer can be lost to a read-modify-write on a
   shared object the way it could if either were just a field inside the
   match blob.
2. **Two matchmaking passes running at once** — the 1-second background
   sweep racing an in-flight poll, or (now that state is shared) two API
   processes each running their own sweep. The whole sweep-and-pair pass is
   wrapped in a short redis lock (`SET NX PX` + a compare-and-delete release
   script) so only one ever runs at a time; a caller that loses the race
   just skips that pass, which is invisible at a 2-second poll cadence.
3. **Two different endings racing for the same `playing` match** — e.g. a
   player's own agreed result landing in the same instant the disconnect
   sweep decides the match is stale. Harmless for every pre-`playing` ending
   (worst case, a wrong-but-plausible reason string), but not here: applying
   elo or writing history twice for one match would be a real bug, not a
   cosmetic one. Ending a match is therefore an atomic "does it still exist,
   if so delete it" Lua script rather than a check-then-delete in JS — only
   the caller that actually deletes it goes on to touch postgres.

**What this buys you operationally:** the queue now survives an API process
restart, and more than one API process can share a single queue by pointing
them at the same `REDIS_URL` — matchmaking is no longer pinned to a single
process the way it was.

## Not done yet

* No cross-write atomicity between an elo change and its `matches` row (or
  between the two players' own writes) — a settlement is four independent
  postgres writes plus two redis ones. A mid-settlement outage could in
  principle leave them inconsistent; nothing here retries or rolls one back.
* `replayUrl` is trusted as-is — this API stores and returns the string a
  client sends on `/matchmaking/alive`, but never fetches or validates its
  content, so nothing stops a client from sending a URL that 404s, points
  somewhere unrelated, or isn't even a replay. Actually hosting/verifying
  replays is entirely the uploading service's problem; only *whether* a
  `replayUrl` was sent at all factors into who wins (see
  [Replays](#replays)), never what it actually points to.
* Starting the match after the room code handoff — and detecting who
  actually won, beyond each client self-reporting it — is client-side and
  out of scope here.
