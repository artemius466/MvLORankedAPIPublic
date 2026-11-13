# Unity integration — matchmaking

How to drive the API from a Unity client. This covers the API side only: no UI,
no prefabs. Plain `UnityWebRequest` + coroutines, no extra packages.

See [matchmaking.md](matchmaking.md) for the endpoint reference and the rules.

**The short version:** two polling loops. One while searching, one after a match
is found — the second one also carries the map veto (see [The map
veto](#5-the-map-veto)) and the room-code handoff, so there is still no third
loop to run. Send a fresh `pings` reading on every poll, and poll at least
every 2 seconds or the server drops you out of the queue.

## The three files

Drop these into your Unity project (namespace `NSMB.Ranked.API`):

| File | What it is |
| --- | --- |
| [`unity/RankedAPIClasses.cs`](unity/RankedAPIClasses.cs) | Every request/response DTO, plus id constants |
| [`unity/RankedAPIHelper.cs`](unity/RankedAPIHelper.cs) | Transport: auth header, JSON, timeouts, error shaping |
| [`unity/RankedAPIController.cs`](unity/RankedAPIController.cs) | One method per endpoint, all routed through the helper |

Naming standard: `<Thing>Info` / `<Thing>Profile` / `<Thing>Entry` for models
reused across responses, `<Endpoint>Response` for a response body,
`<Endpoint>Request` for a POST body.

Every controller method returns an `IEnumerator` and takes the same two
callbacks, so they all compose the same way:

```csharp
StartCoroutine(RankedAPIController.PollQueue(pings, maxPing, onOk, onError));

// onOk    : Action<TResponse>
// onError : Action<long, ApiError>   // status code + parsed { error, code }
```

`responseCode == 0` means the request never landed (no network, DNS, timeout) —
those are the ones worth retrying. A `409` is not.

Point `RankedAPIController.ApiBase` at your server; it defaults to
`http://127.0.0.1:3000/api`.

> **`JsonUtility` caveats:** it cannot deserialise a top-level JSON array, and it
> maps JSON `null` — and any field the server simply left out — to the field
> default (`0` / `null` / `false`). Nothing here needs the former; the nullable
> numerics are `QueueInfo.nextExpansionInSeconds`, which is display-only, and
> `MatchInfo.eloDifference`, which reads `0` until the opponent is revealed
> (see [The accept prompt](#the-accept-prompt)) — test `opponent != null`
> rather than trusting a `0` there. `MatchInfo.map` is the same story for a
> different reason: it's `null` until the map veto (see [The map
> veto](#5-the-map-veto)) settles on one, whether or not the opponent has been
> revealed yet. Note `MatchHistoryEntry.id` is a **string** — postgres bigints
> arrive as JSON strings, and an `int` field there would break.

---

## 0. Getting a session token

Everything except `/health`, `/login` and the match history needs
`Authorization: Bearer <token>`. The game client gets one through device login:

```csharp
IEnumerator SignIn()
{
    // 1. Ask where to send the player. This also stashes RankedSession.LoginState.
    LoginResponse login = null;
    yield return RankedAPIController.Login(res => login = res,
        (code, err) => Debug.LogError("[RANKED] /login failed: " + err?.error));
    if (login == null) yield break;

    // 2. Open it in the system browser.
    Application.OpenURL(login.url);

    // 3. Poll until the browser round trip finishes. On success this stores
    //    RankedSession.Token and RankedSession.Profile for you.
    yield return RankedAPIController.ProcessLoginFlow(
        token => Debug.Log("[RANKED] signed in"),
        reason => Debug.LogWarning("[RANKED] sign-in failed: " + reason));  // or "timeout"
}
```

Persist `RankedSession.Token` (`PlayerPrefs` is fine — it is already a bearer
credential with a 30 day TTL) and restore it on launch. `RankedAPIController.GetUserInfo()`
tells you whether it is still valid.

### Connecting to Photon with Custom Authentication

Before connecting to Photon, configure `PhotonNetwork.AuthValues` with the session token.
This authenticates the connection against `/api/auth/photon`, binds the local player's
Photon `UserId` to their verified Discord ID, and rejects banned players:

```csharp
using Photon.Pun;
using Photon.Realtime;

AuthenticationValues auth = new AuthenticationValues();
auth.AuthType = CustomAuthenticationType.Custom;
auth.AddAuthParameter("token", RankedSession.Token);
PhotonNetwork.AuthValues = auth;
PhotonNetwork.ConnectUsingSettings();
```

See [photon-custom-auth.md](photon-custom-auth.md) for full dashboard setup and handling
ban rejection callbacks in Unity via `OnCustomAuthenticationFailed`.

---

## 1. Measuring region pings

The server never picks a region up front — you never queue "for" a region the
way you queue for maps. Instead you report your own ping to *every* region,
plus the worst ping you're willing to accept (`maxPing`), and the server picks
whichever region clears both players' limits with the best combined
connection once an opponent is found. Measure the round trip to each region's
**Photon relay**, not to this API — that's the connection that actually
matters once the match starts.

```csharp
using Photon.Realtime;
using ExitGames.Client.Photon;

// Ping every region Photon knows about via its cloud ping request, in
// parallel, and cache the results. RankedRegions.All (RankedAPIClasses.cs)
// lists the regions this API itself knows about, in the same order/index its
// `pings` arrays are positional by - map your Photon region codes to that
// same order once, here, rather than at every StartSearch()/poll call.
int[] regionPings = new int[RankedRegions.All.Length];

IEnumerator MeasureAllRegionPings()
{
    // PhotonNetwork.PhotonServerSettings / RegionHandler.PingMinimumOfCluster
    // is the usual way to get every region's ping without connecting to each
    // one in turn - see Photon's own "Regions" docs for the exact API for
    // your PUN/Fusion version. Fill regionPings[] from whatever that returns,
    // clamped the same way a single ping used to be:
    //
    //   regionPings[i] = Mathf.Clamp(pingForRegion, 0, 5000);
    //
    // A region you have no reading for yet should stay at int.MaxValue (or
    // any value >= 5000) rather than 0 - clamped down to 5000 by
    // ClampPing() below, it reads as "worst case", never "instant", so it
    // can never look artificially good to the matchmaker.
    yield break;
}
```

Connect to Photon (or at least run its region ping request) *before* queueing
so real numbers exist from the first request. Re-measure periodically and send
fresh readings on **every** poll — the server keeps the most recent set, so a
connection that degrades while queueing is accounted for. Leave a region out
(or never measure it) and it is treated as the worst possible connection for
that region only — it just becomes less likely to be picked, never a reason
you can't be matched at all, as long as at least one other region works for
both players.

---

## 2. Entering the queue

No map choice anymore — `RankedMaps.All` still lists the four ids, but only
for showing them somewhere (e.g. a "current map pool" screen); nothing about
queuing takes a map anymore. See [The map veto](#5-the-map-veto) for where
maps come back in.

```csharp
using NSMB.Ranked.API;

bool searching;
bool inMatch;
bool roomRequested;
int maxPingMs = 120;   // whatever the player picked in the region/ping settings UI

public IEnumerator StartSearch()
{
    yield return RankedAPIController.StartMatchmaking(
        pings: regionPings,
        maxPing: maxPingMs,
        onOk: res =>
        {
            Apply(res);                       // usually "searching"
            StartCoroutine(SearchLoop());
        },
        onError: (code, err) =>
        {
            if (err?.code == RankedErrorCodes.MatchInProgress)   // 409
            {
                // You already have a live match — resume it instead.
                StartCoroutine(MatchLoop());
            }
            else if (err?.code == RankedErrorCodes.AlreadyQueued)   // 409
            {
                // Already searching — resume polling instead of re-queueing.
                StartCoroutine(SearchLoop());
            }
        });
}
```

Re-queueing while merely *searching* is refused (`409 already_queued`) — call
`/matchmaking/cancel` first if the player wants to change their options, then
queue again.

---

## 3. The search poll

Loop until the status stops being `searching`.

```csharp
IEnumerator SearchLoop()
{
    searching = true;
    int failures = 0;

    while (searching)
    {
        yield return RankedAPIController.PollQueue(regionPings, maxPingMs,
            res => { failures = 0; Apply(res); },
            (code, err) =>
            {
                // Transport blips happen; only give up if they persist. A
                // timed-out request costs up to 10s on its own, so two in a row
                // can already exceed the 15s stale window — the next successful
                // poll then just answers "idle", which Apply() handles.
                if (code == 0 && ++failures < 3) return;
                searching = false;
                OnSearchFailed();
            });

        yield return new WaitForSeconds(RankedAPIController.MatchmakingPollSeconds);
    }
}

void Apply(QueuePollResponse res)
{
    if (res == null) return;

    // One-shot: this poll is the only one that will ever mention it.
    if (res.lastMatch != null && !string.IsNullOrEmpty(res.lastMatch.reason))
        ReportOutcome(res.lastMatch);

    switch (res.status)
    {
        case "searching":
            // res.queue.waitedSeconds / eloRange drive a "widening search" hint.
            OnSearching(res.queue);
            break;

        case "found":
            searching = false;
            OnOpponentFound(res.match);       // show the accept prompt
            // Switch to the match poll straight away, before the player has
            // answered: it reports "waiting" with accepted:false while the
            // prompt is up, and tells you if the opponent bails meanwhile.
            StartCoroutine(MatchLoop());
            break;

        case "idle":
            // Cancelled elsewhere, or swept for not polling.
            searching = false;
            OnLeftQueue();
            break;
    }
}
```

### The accept prompt

**The prompt is blind.** While a match is still waiting on either player's
answer, `MatchInfo` describes the match and nothing else — `opponent` and
`eloStake` come through as `null`, `eloDifference` as `0`,
`outsideBaseRange` as `false`, because the API leaves all four out of the
payload until both sides have accepted. Nobody gets to decline a name or a
rating. `map` is `null` here too, but for an unrelated reason — it hasn't been
decided at all yet, since the veto (see [The map veto](#5-the-map-veto)) only
runs once the match is `ready`. Don't reference `m.map` from this prompt.

```csharp
void OnOpponentFound(MatchInfo m)
{
    Debug.Log($"Region: {m.region.name}");

    acceptDeadline = Time.time + m.expiresInSeconds;   // ~20s
}
```

`region` is filled in from the moment the match is `found`/`waiting` — it says
nothing about who the opponent is, so unlike `opponent` it is never withheld
during the blind accept prompt (see [Showing the
opponent](#showing-the-opponent) and matchmaking.md's **Blind accept**). Pick
your Photon region from it here, before the room even exists.

### Showing the opponent

The same `MatchInfo` carries the reveal from the `ready` payload onwards, so
the pre-game screen reads it off the match poll rather than the prompt:

```csharp
void OnOpponentRevealed(MatchInfo m)
{
    Debug.Log($"Opponent: {m.opponent.displayName} (@{m.opponent.username})");
    Debug.Log($"Elo: {m.opponent.elo}  (you differ by {m.eloDifference})");

    if (m.outsideBaseRange)
    {
        // Someone's wait widened the band, so the stakes are adjusted.
        Debug.Log(m.eloStake.favoured
            ? $"Underdog: win {m.eloStake.winMultiplier}x, lose only {m.eloStake.lossMultiplier}x"
            : $"Favourite: win {m.eloStake.winMultiplier}x, lose {m.eloStake.lossMultiplier}x");
    }
}
```

`ready` repeats on every poll, so call this once behind a guard the way the
room creation below is guarded — or key it off `m.opponent != null` becoming
true, which works from either poll without caring about the status string.

---

## 4. Accept / decline

```csharp
public IEnumerator Accept()
{
    yield return RankedAPIController.AcceptMatch(
        res =>
        {
            ApplyMatch(res);
            // MatchLoop is already running from the "found" branch; only start
            // it here if you resumed a match some other way.
            if (!inMatch) StartCoroutine(MatchLoop());
        },
        (code, err) => OnMatchLost(err?.code ?? "accept_failed"));   // 409 no_pending_match
}

public IEnumerator Decline()
{
    yield return RankedAPIController.DeclineMatch(
        res => OnLeftQueue(),                       // status "ended", reason "declined"
        (code, err) => OnLeftQueue());
}
```

Declining takes you out of matchmaking entirely — call `StartSearch()` again to
come back. Your opponent is requeued automatically, and neither of you can be
paired with the other for 60 seconds.

---

## 5. The map veto

Runs entirely inside the same match-poll loop from section 6 below — there is
no separate poll for it. From the moment `status` is `"ready"`, watch
`res.match.map`: `null` means the veto is still going, and `res.mapVeto` (see
`MapVetoInfo`) says whose turn it is and what's left to ban.

```csharp
bool mapShown;   // reset in MatchLoop alongside opponentShown/roomRequested

void OnMapVeto(MatchPollResponse res)
{
    var veto = res.mapVeto;
    if (veto.yourTurn)
    {
        // Any selection UI you want goes here - a picker over
        // veto.remainingMaps, or (for a quick test) just the first one:
        string pick = veto.remainingMaps[0].id;
        StartCoroutine(RankedAPIController.BanMap(pick,
            onOk: null,   // the next MatchLoop poll picks up the new mapVeto/match.map
            onError: (code, err) =>
            {
                // 403 not_your_turn - someone else's ban landed first (a
                // race between two rapid polls); just wait for the next poll.
                // 409 map_already_banned - stale remainingMaps; same fix.
                Debug.LogWarning($"[RANKED] ban failed: {err?.code}");
            }));
    }
    else
    {
        OnWaitingForOpponentBan(veto);   // "waiting for {host/guest} to ban a map…"
    }
}
```

The host bans first, twice; then the guest, once — see matchmaking.md's
**Maps** rule. `remainingMaps` shrinks by one with each ban on either side;
once it is down to one, `res.match.map` stops being `null` and `res.mapVeto`
disappears from the payload entirely (see [Section 6](#6-the-match-poll-and-host-election)
for where this plugs into `ApplyMatch`'s `"ready"` case). There is no
dedicated "veto UI closing" event to hook — just stop calling `OnMapVeto` once
`res.match.map != null` and show the decided map instead.

Only the host can call `POST /matchmaking/room` (section 7) once the map is
decided — attempting it earlier is rejected with `409 map_not_decided`, so
there's no need to gate `HostCreateRoom` on the veto yourself beyond not
calling it until `res.match.map != null`.

---

## 6. The match poll and host election

Both players poll this until it says `ready`. **The guest stays on this loop
too** — it is how the map veto above and the room code both arrive.

```csharp
IEnumerator MatchLoop()
{
    inMatch = true;
    roomRequested = false;
    opponentShown = false;
    mapShown = false;
    int failures = 0;

    while (inMatch)
    {
        yield return RankedAPIController.PollMatch(regionPings, maxPingMs,
            res => { failures = 0; ApplyMatch(res); },
            (code, err) =>
            {
                if (code == 0 && ++failures < 3) return;
                inMatch = false;
                OnMatchLost("network");
            });

        yield return new WaitForSeconds(RankedAPIController.MatchmakingPollSeconds);
    }
}

void ApplyMatch(MatchPollResponse res)
{
    if (res == null) return;

    switch (res.status)
    {
        case "waiting":
            if (res.accepted) OnWaitingForOpponent(res.opponentAccepted);
            else              OnAwaitingYourAnswer(res.match);   // prompt still counting down
            break;

        case "ready":
            // Both sides are locked in, so this is where the opponent finally
            // shows up — see "Showing the opponent" above. Guarded like the
            // room creation below, since "ready" repeats on every poll.
            if (!opponentShown)
            {
                opponentShown = true;
                OnOpponentRevealed(res.match);
            }

            if (res.match.map == null)
            {
                // The map veto (section 5) hasn't settled yet - nothing else
                // in this case can happen until it does, since the host
                // can't publish a room code without a decided map.
                OnMapVeto(res);
                break;
            }
            else if (!mapShown)
            {
                mapShown = true;
                OnMapDecided(res.match.map);   // e.g. load the right level asset
            }

            if (res.isHost)
            {
                // "ready" repeats on every poll — without this guard you would
                // create one Photon room per poll.
                if (!roomRequested)
                {
                    roomRequested = true;
                    StartCoroutine(HostCreateRoom(res.match));
                }
            }
            else if (!string.IsNullOrEmpty(res.roomCode))
            {
                inMatch = false;
                JoinPhotonRoom(res.roomCode, res.match);
                StartCoroutine(AliveLoop());   // see "8. Reporting alive" below
            }
            // else: guest, code not published yet — keep polling.
            break;

        case "ended":
            inMatch = false;
            ReportOutcome(new LastMatchInfo {
                matchId = res.matchId, reason = res.reason, requeued = res.requeued
            });
            // requeued: you are already back in the queue, so just resume the
            // search loop rather than calling StartMatchmaking again.
            if (res.requeued) StartCoroutine(SearchLoop());
            else              OnLeftQueue();
            break;

        case "none":
            inMatch = false;
            StartCoroutine(SearchLoop());
            break;
    }
}
```

`isHost` is decided server-side, uniformly at random, the instant the match
forms — ping already did its job picking the region (see `MatchInfo.region`)
and has no say in who hosts it. Both clients are told the same `hostId` —
never decide this locally, or you get two hosts or none. The same host/guest
split runs the map veto above.

### Reporting the outcome

```csharp
void ReportOutcome(LastMatchInfo last)
{
    switch (last.reason)
    {
        case RankedEndReasons.OpponentDeclined: Debug.Log("Opponent declined — searching again"); break;
        case RankedEndReasons.OpponentTimeout:  Debug.Log("Opponent did not answer in time");     break;
        case RankedEndReasons.OpponentLeft:     Debug.Log("Opponent left");                        break;
        case RankedEndReasons.Declined:         Debug.Log("You declined");                         break;
        case RankedEndReasons.Timeout:          Debug.Log("You ran out of time");                  break;
        case RankedEndReasons.Left:             Debug.Log("You left");                             break;
        case RankedEndReasons.Expired:          Debug.Log("Match expired before the room was made"); break;
    }
}
```

The un-prefixed reasons mean *you* caused it. This is delivered **once** — the
poll that returns it also clears it, so handle it there rather than expecting it
on the next tick.

---

## 7. Photon handoff

The host creates the room and publishes its name; the guest reads it and joins.
`ApplyMatch` (section 6) already only reaches this once `res.match.map != null`
— the server itself also refuses `PublishRoomCode` with `409 map_not_decided`
before that, so there's no separate check to add here.

```csharp
using Photon.Pun;
using Photon.Realtime;

IEnumerator HostCreateRoom(MatchInfo match)
{
    string roomCode = "MVLO-" + UnityEngine.Random.Range(0x1000, 0xFFFF).ToString("X4");

    PhotonNetwork.CreateRoom(roomCode, new RoomOptions {
        MaxPlayers = 2,
        IsVisible  = false,      // ranked rooms are joined by code, never listed
        IsOpen     = true
    });

    // Wait for PUN's OnCreatedRoom / OnCreateRoomFailed callback.
    createResult = null;
    while (createResult == null) yield return null;

    if (createResult == false)
    {
        // Never publish a code for a room that does not exist. Cancelling frees
        // the guest immediately instead of leaving them polling until the TTL.
        yield return RankedAPIController.CancelMatchmaking();
        inMatch = false;
        OnMatchLost("room_creation_failed");
        yield break;
    }

    yield return RankedAPIController.PublishRoomCode(roomCode,
        res =>
        {
            inMatch = false;
            OnMatchReady(match, isHost: true, roomCode: res.roomCode);
            StartCoroutine(AliveLoop());   // see "8. Reporting alive" below
            // The guest joins from here; start the match when
            // PhotonNetwork.CurrentRoom.PlayerCount hits 2.
        },
        (code, err) =>
        {
            // 403 not_host      — you lost the election; go back to polling.
            // 409 no_ready_match — the match is gone.
            Debug.LogError($"[RANKED] room publish failed: {err?.code}");
            PhotonNetwork.LeaveRoom();
            inMatch = false;
            OnMatchLost(err?.code ?? "publish_failed");
        });
}

void JoinPhotonRoom(string roomCode, MatchInfo match)
{
    PhotonNetwork.JoinRoom(roomCode);
    OnMatchReady(match, isHost: false, roomCode: roomCode);
}
```

`createResult` comes from your `MonoBehaviourPunCallbacks`:

```csharp
bool? createResult;

public override void OnCreatedRoom()                                => createResult = true;
public override void OnCreateRoomFailed(short code, string message) => createResult = false;
public override void OnJoinRoomFailed(short code, string message)   => OnMatchLost("join_failed");
```

The room code is opaque to the API — any string up to 64 characters, trimmed.
Publishing it refreshes the match TTL so the guest gets a full 120s window to
pick it up. Only the elected host may publish; the guest gets `403 not_host`.

Starting the actual match is client-side and out of scope here, but the
API's job is not done yet — see below.

---

## 8. Reporting alive - and who won

> The `ReportAlive` method and the `resultSubmitted` / `opponentResultSubmitted`
> / `playing` additions to `MatchPollResponse` are not in the three reference
> files yet — add a thin wrapper around `POST /matchmaking/alive` the same way
> the existing methods wrap their endpoints. The shape below is what it needs
> to send and expect back.

Both host and guest keep this running for the entire game, from the moment
each has a room code until the match ends. The match does not actually
become `playing` server-side until **both** sides have sent at least one of
these — expect `res.status` to still read `"ready"` for a moment after you
start this loop if the other side hasn't caught up yet.

```csharp
bool inGame;
bool? myResult;   // set by your own game-over logic: true if the host won

IEnumerator AliveLoop()
{
    inGame = true;
    int failures = 0;

    while (inGame)
    {
        bool? toSend = myResult;
        yield return RankedAPIController.ReportAlive(toSend,
            res =>
            {
                failures = 0;
                if (toSend.HasValue) myResult = null;   // sent - don't resend every tick
                ApplyAlive(res);
            },
            (code, err) =>
            {
                if (code == 0 && ++failures < 3) return;
                inGame = false;
                OnMatchLost("network");
            });

        yield return new WaitForSeconds(RankedAPIController.MatchmakingPollSeconds);
    }
}

void ApplyAlive(MatchPollResponse res)
{
    switch (res.status)
    {
        case "playing":
            // res.resultSubmitted / res.opponentResultSubmitted, if you want
            // a "waiting on your opponent" indicator.
            break;

        case "ended":
            inGame = false;
            ReportOutcome(new LastMatchInfo {
                matchId = res.matchId, reason = res.reason, requeued = res.requeued
            });
            OnLeftQueue();   // a settled match is never requeued
            break;
    }
}
```

Set `myResult = true`/`false` from wherever your own game logic detects the
winner (`true` = the host won); the next loop tick sends it. **Keep sending
this loop even after reporting your own result** — the match is not over
server-side until the *other* side has too, and going quiet still counts as
a disconnect regardless of what you already reported.

Go quiet on this endpoint for `MM_ALIVE_STALE_SECONDS` (20s by default) and
you forfeit — a real, elo-affecting loss — to whoever is still sending it.
`CancelMatchmaking` does the exact same thing while this loop is running:
there is no free walkout once a match is actually playing, only once you're
still searching or waiting on accept.

If the two sides' reports disagree, the match ends for both with no elo
change (`reason: "disputed"`). Your client cannot detect this except by
seeing that reason — the API never reveals what the *other* side reported
before you submit your own, specifically so a dishonest client cannot just
copy it.

---

## 9. Cancelling and cleanup

```csharp
public IEnumerator Cancel()
{
    searching = false;
    inMatch = false;
    yield return RankedAPIController.CancelMatchmaking();
}

void OnApplicationQuit()
{
    // Fire and forget — the coroutine will not survive the quit, but the request
    // usually makes it out. Even if it does not, the server sweeps a silent
    // ticket after 15s, so the opponent is never stuck.
    StartCoroutine(Cancel());
}
```

`CancelMatchmaking` is safe to call when there is nothing to cancel (it answers
`left: false`), so you can wire it to a back button unconditionally.

---

## The rest of the API

The same controller covers everything else, if you need it:

```csharp
RankedAPIController.Health(res => ...);                      // GET  /health
RankedAPIController.GetUserInfo(res => ...);                 // GET  /me
RankedAPIController.RefreshProfile(res => ...);              // POST /refresh
RankedAPIController.Logout(() => ...);                       // POST /logout, clears RankedSession
RankedAPIController.GetMatchHistory(userId, 50, res => ...); // GET  /users/{id}/matches
```

`RefreshProfile` is safe on every launch — it only actually calls Discord once
the cached profile has gone stale. `GetMatchHistory` is public: no session
needed, and it works for any user id.

---

## Checklist

- **Poll every ~2s** (`RankedAPIController.MatchmakingPollSeconds`). 15s of
  silence drops your ticket. The one exception is the accept window, where the
  20s accept deadline takes over so a player deciding is never cut short.
- **Send `pings` (and `maxPing` if it changed) on every poll.** It decides which
  regions you can be matched onto, and the latest set wins.
- **Send a full `pings` array whenever you send it at all** — a region missing
  from the list resets to worst-case, so don't send only the ones that changed.
- **Never decide the host locally** — it's random and server-side; use
  `isHost` / `hostId`.
- **Guard the room creation** so repeated `ready` polls make one room.
- **Handle `lastMatch` on the poll that delivers it.** It is one-shot.
- **The accept prompt is blind.** `opponent`, `eloStake`, `eloDifference` and
  `outsideBaseRange` are absent until both sides have accepted — build the
  prompt out of the region and countdown alone, and reveal the rest from
  `ready`. `map` is absent here too, but because it hasn't been decided yet at
  all, not for privacy — see the map veto below.
- **The map is picked after `ready`, not at queue time.** `POST
  /matchmaking/queue` no longer takes a `maps` field; watch `res.match.map`
  and `res.mapVeto` on the match poll instead, and only ban on your own turn
  (`mapVeto.yourTurn`).
- **Don't call `PublishRoomCode` until `match.map != null`** — the server
  rejects it early with `409 map_not_decided`, and `ApplyMatch`'s `"ready"`
  case above already returns before reaching the room-creation branch while
  the veto is still going.
- **`status: "idle"` / `"none"` is normal**, not an error — it just means you
  are not in matchmaking right now (cancelled, or swept for not polling).
- **Stop the search loop before starting the match loop** or you will run two
  polls at once. The samples above set `searching = false` first.
- **Keep sending `/matchmaking/alive` for the whole game**, from both sides,
  even after you've reported your own result. Going quiet for
  `MM_ALIVE_STALE_SECONDS` is a real, elo-affecting forfeit, and so is calling
  `CancelMatchmaking` while playing.
- **Never reveal your own result claim until you send it, and don't expect to
  see the opponent's.** The API only tells you whether they have reported,
  not what — that is what makes independent self-reporting worth anything.

## Local testing

```bash
npm run db:start && npm run dev
```

Point `RankedAPIController.ApiBase` at `http://localhost:3000/api`. Two Unity
instances need two different Discord accounts — the queue is keyed by Discord id,
and a second ticket for the same account replaces the first instead of matching
against it. For a quick check without two accounts, drive the endpoints with
`curl` using a second token and watch a single Unity client pair against it.
