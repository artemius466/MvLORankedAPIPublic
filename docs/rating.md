# Ratings

Ranked ratings are **Glicko-2**. The implementation is
[src/domain/glicko.js](../src/domain/glicko.js) — pure math, no database, so it
can be checked against Glickman's published worked example directly.

Each player carries one rating shared across every ranked match (matchmaking
no longer divides players by gamemode at all — see
[matchmaking.md](matchmaking.md) and `migrations/10_unify-elo.sql` /
`migrations/11_drop-match-gamemode.sql`), and that rating is really three
numbers plus a timestamp:

| | what it is |
| --- | --- |
| `rating` | The number the API calls `elo`. Same scale as the flat elo it replaced; starting value is now 750. |
| `rd` | Rating deviation — how sure we are of `rating`. High for someone new, shrinks as they play, grows back while they don't. |
| `vol` | Volatility — how erratic their results have been. Controls how fast `rd` is allowed to grow. |
| `ratedAt` | When their last rated match landed, or null if never. |

**Only `rating` is ever exposed.** The API reports it under all the names it
always used — `elo`, `eloDelta` — rounded to a whole number. `rd` and `vol`
are how a rating is arrived at, not something a player acts on, and no
endpoint returns them.

## Why not flat elo

The old system moved both players by 20 points, adjusted by a multiplier this
project computed itself from how far apart the two ratings were. Two problems:

* **Everyone moved at the same speed.** A brand-new player needed dozens of
  matches to climb to where they actually belonged, while a settled player got
  dragged around by a single fluke result.
* **The multiplier was invented.** Paying the underdog more is exactly what a
  proper rating system does natively, so hand-rolling it on top meant guessing
  at something well-understood.

Glicko-2 fixes both by tracking *confidence* alongside the rating. An uncertain
player moves fast; a well-established one moves slowly. Beating someone whose
rating is trusted counts for more than beating someone nobody has measured.

The practical shape of it, for a new player against a settled field:

| match | rating moves by |
| --- | --- |
| 1st | ~85 |
| 10th | ~25 |
| 30th onwards | ~15 |

So placement takes a handful of games instead of dozens, and then the ladder
settles down to roughly where the flat ±20 used to sit.

**Rating changes are not zero-sum.** The two sides of a match are updated
independently, and a settled rating moves less than an unsettled one. A newcomer
beating a veteran can gain 100 while the veteran loses 10 — that is correct, not
a bug: the result says a great deal about the newcomer and very little about the
veteran.

## One match, one rating period

Glickman's paper assumes a rating period holds many games and updates everyone
once at the end of it. This system rates each match as it settles, because a
ladder people watch live cannot wait for a nightly batch.

That has one consequence worth knowing: the paper's default starting `rd` of
350 assumes the smoothing a full period of games provides. Applied one match at
a time it makes a new player's *first* result move them ~175 points — most of a
tier band, off a single game. `GLICKO_DEFAULT_RD` is therefore 200 here, which
gives the curve in the table above. The settled end of that curve is the same
either way; only placement changes.

## Configuration

All optional — the defaults are what the table above describes.

| Setting | Default | What it does |
| --- | --- | --- |
| `GLICKO_TAU` | 0.5 | Constrains how fast volatility changes. Glickman suggests 0.3–1.2: smaller damps upsets, larger lets a genuinely improving player climb faster at the cost of noisier ratings. |
| `GLICKO_DEFAULT_RD` | 200 | Starting rating deviation, and the ceiling it is clamped back to. Raise for snappier placement, lower for a calmer ladder. |
| `GLICKO_DEFAULT_VOLATILITY` | 0.06 | Starting volatility. |
| `GLICKO_RATING_PERIOD_DAYS` | 7 | How much idleness inflates `rd` by one step — see below. |

## Inactivity

Two separate things happen to someone who stops playing, and they are worth not
confusing.

**Their `rd` grows.** This is Glicko-2's own behaviour and is not a penalty: we
have not decided they got worse, only that we are less sure where they stand,
so their next result moves them further than it otherwise would. It is charged
lazily, at the moment they next play, one step per `GLICKO_RATING_PERIOD_DAYS`
elapsed, and clamped at `GLICKO_DEFAULT_RD` — past that point we simply know
nothing, and letting it grow without bound would make a comeback match swing
wildly on one game.

**Their rating falls.** That is a deliberate ladder policy rather than anything
the math asks for — see Rating decay below.

## Rating decay

After `RATING_DECAY_IDLE_DAYS` (30) without a rated match, the rating starts
falling by `RATING_DECAY_PER_DAY` (4) points for every further idle day —
about 28 a week. A position on the ladder is a claim about how you play now,
and someone who stopped playing months ago has stopped backing it.

| Setting | Default | What it does |
| --- | --- | --- |
| `RATING_DECAY_IDLE_DAYS` | 30 | Grace period before decay starts. |
| `RATING_DECAY_PER_DAY` | 4 | Points lost per further idle day. **Set to 0 to disable decay entirely.** |
| `RATING_DECAY_SWEEP_HOURS` | 24 | How often the sweep runs. |

Details worth knowing:

* **There is no floor.** It goes below the starting rating and keeps going. A
  floor would let an abandoned account sit on a rung forever, which is the
  thing decay exists to prevent.
* **It is continuous, not stepped.** Points accrue per day rather than in
  weekly lumps, so there is no cliff to watch for.
* **The cadence does not change the total.** Decay is billed from how much
  idleness has not been charged yet, so a sweep missed because the process was
  down is charged in full by the next one, and running the sweep twice in a row
  charges nothing the second time. The API also sweeps once at startup.
* **Playing again stops it immediately**, with no back-charge for the idle
  time that had not yet been billed.
* **Every charge is recorded** in the `rating_decay` table — who, how many
  points, their rating afterwards, and how long they had been idle. Decay that
  happens silently produces support questions nobody can answer six weeks
  later.

## Reverting a match

The Discord bot's `/match` → Revert (see [discord-bot.md](discord-bot.md))
subtracts each side's recorded change — rating, `rd` and `vol` alike — using the
before/after values stored on the `matches` row.

This is an approximation, and was under flat elo too. It leaves each player
where they would be if this match's numbers had never been added, which is not
the same as where replaying their whole history without this match would put
them, because `rd` and `vol` fed into how far *later* matches moved them. The
difference is small and the alternative — recomputing every subsequent match —
is not worth it for an action this rare. Matches settled before Glicko-2 landed
have no `rd`/`vol` recorded and revert the rating alone, which is exactly what
they contributed.
