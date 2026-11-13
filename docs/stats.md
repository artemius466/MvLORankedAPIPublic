# Activity stats

Which regions and maps people actually play, averaged over a day, a week or a
month. Reported through the Discord bot — `/stats`, plus a summary on the live
stats embed. There is no HTTP endpoint for it.

Implementation: [src/domain/activity.js](../src/domain/activity.js), fed by
`matchmaking.activitySnapshot()`.

## What the numbers mean

**Average concurrent players.** "Europe: 3.4" means that at any given moment
over the window, an average of 3.4 people were either playing on Europe or
waiting in a queue that would accept it. It is not a count of distinct players,
and not a count of matches played.

**A queued player counts towards every region they would go.** A player never
picks a map before queuing anymore (see **Maps** in [matchmaking.md](matchmaking.md)
— the map is decided by a post-match veto instead), so there is no such thing
as "queuing for Grassland" any more; only regions have a live queuing count.
Someone queuing counts towards every region whose ping they reported is within
their own `maxPing`, so the per-region numbers add up to well more than the
number of players online — deliberately. The question being answered is "how
many people want to play on this region", not "how are the players divided
up".

One detail falls out of that: a player counts once per region they'd accept,
no matter how many that is — wanting more options does not make any one of
them more popular.

Maps still get a `playing` count — summed across every region, "how popular is
Ghost House" rather than "how popular is Ghost House in Europe" — but their
`queuing` count is always 0 now, kept only so the per-region and per-map rows
share one shape; a map is no longer something anyone can be queuing *for*.

**`playing` and `queuing` are reported separately** as well as together, for
regions. A region with a lot of queuing and little playing means people want
it and are not getting matched there, which is worth being able to see. Maps
only ever show up in the `playing` half of that comparison now.

## How it is collected

Nothing here existed to be derived from. `matchmaking.activitySnapshot()` only
knows about right now, and the `matches` table only records games that
*finished*, which says nothing about who was around wanting to play.

So the API samples the live snapshot every `ACTIVITY_SAMPLE_SECONDS` (60) and
folds each sample into a running per-day total — see
[migrations/4_activity.sql](../migrations/4_activity.sql). It does not keep the
samples themselves. Six regions plus twelve maps is 18 rows per day regardless
of how often sampling happens, so nothing ever needs pruning, and all three
windows are one grouped scan.

Averages are `sum / samples`, with the sample count stored per row rather than
inferred from the interval. That is what makes the numbers survive a restart, a
change to `ACTIVITY_SAMPLE_SECONDS`, or a stretch where the API was simply down:
those show up as fewer samples, not as an average dragged towards zero.

Empty buckets are recorded too. A region nobody was on is a real measurement —
dropping it would compute that region's average over only the moments somebody
happened to be there, and rank a dead region alongside a busy one.

Set `ACTIVITY_SAMPLE_SECONDS=0` to stop collecting. `/stats` then reports
whatever was gathered before, and eventually nothing.

## Reading it

`/stats [window]` — `Today`, `This week` (default) or `This month` — replies
publicly with regions and maps ranked by average players. Unlike `/player` and
`/match` it is not admin-only; nothing in it is privileged.

The live stats embed (`DISCORD_STATS_CHANNEL_IDS`, see
[discord-bot.md](discord-bot.md)) additionally carries the top three regions and
maps over the past week, under the current per-region playing/queuing counts.

Both show "No activity recorded yet" until the first samples land, which is also
what a fresh deployment and a disabled sampler look like.
