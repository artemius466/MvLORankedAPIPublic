const config = require('../config');

/**
 * Glicko-2, per Glickman's "Example of the Glicko-2 system" (glicko.net/glicko/
 * glicko2.pdf). Pure math - no database, no redis, no clock of its own beyond
 * the `now` it is handed - so it can be checked against the paper's worked
 * example in isolation.
 *
 * A player is `{ rating, rd, vol, ratedAt }`:
 *
 *   rating   the number everything else in this project calls "elo". Same
 *            scale as before, still starting at config.startingElo.
 *   rd       rating deviation - how unsure we are of `rating`. Starts high,
 *            shrinks as they play, grows back while they don't.
 *   vol      volatility - how erratic their results have been. Feeds how much
 *            rd is allowed to grow between rating periods.
 *   ratedAt  when their last rated match landed, or null if never. Only used
 *            to work out how many rating periods of idleness to charge.
 *
 * Why this instead of the flat +-20 it replaced: the old system moved both
 * players by the same amount regardless of how well established either rating
 * was, so a newcomer took dozens of matches to reach where they belonged, and
 * a settled player was dragged around by one fluke. Glicko-2 moves an uncertain
 * player fast and a well-established one slowly, and beating someone whose
 * rating is *trusted* is worth more than beating someone nobody has measured
 * yet. matchmaking.js's eloStake() reports the difference to the client
 * instead of inventing its own multipliers.
 *
 * One match is treated as one rating period. That is not what the paper
 * assumes - it batches a period's worth of games and updates once - but
 * batching would mean a player's rating not moving until some nightly job ran,
 * which is unusable for a ladder people watch live. The cost is that two
 * results in quick succession compound slightly more than the batched
 * equivalent; with 1v1 matches minutes apart, that is noise.
 */

// The scale Glicko-2 works on internally. The paper anchors the conversion at
// 1500 because that is its own default rating; ours start at
// config.startingElo (750). That mismatch is deliberate and harmless: only
// *differences* between ratings ever enter the algorithm below, so the anchor
// cancels out and shifting it would change nothing except which numbers appear
// in intermediate variables.
const SCALE = 173.7178;
const ANCHOR = 1500;

// Convergence tolerance for the volatility solver in step 5.
const EPSILON = 0.000001;
// The solver is a bracketed root find that halves its interval every pass, so
// it converges in a couple of dozen iterations for any sane input. This only
// exists so a pathological input cannot spin forever inside a request.
const MAX_ITERATIONS = 100;

const toMu = (rating) => (rating - ANCHOR) / SCALE;
const toPhi = (rd) => rd / SCALE;
const fromMu = (mu) => mu * SCALE + ANCHOR;
const fromPhi = (phi) => phi * SCALE;

// Step 3's g(): how much weight an opponent's result carries. An opponent
// whose own rating is uncertain (high rd, so high phi) counts for less,
// because beating them says less about you.
const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

// Step 3's E(): the probability `mu` beats `muJ`, given how sure we are of the
// opponent. This is also what makes an upset worth more than an expected win -
// the update below is driven by (actual score - this).
const expected = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * Step 5: solve for the new volatility. The paper's illustration uses the
 * Illinois variant of regula falsi, and so does this - it brackets the root
 * first, then never lets the bracket collapse onto one side the way plain
 * false position can.
 */
function nextVolatility(phi, v, delta, vol) {
  const tau = config.glickoTau;
  const a = Math.log(vol * vol);
  const phiSq = phi * phi;
  const deltaSq = delta * delta;

  const f = (x) => {
    const ex = Math.exp(x);
    const denom = phiSq + v + ex;
    return (ex * (deltaSq - phiSq - v - ex)) / (2 * denom * denom) - (x - a) / (tau * tau);
  };

  let A = a;
  let B;
  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    // No closed-form bracket available: walk down in steps of tau until f
    // turns positive, which the paper guarantees it eventually does.
    let k = 1;
    while (f(a - k * tau) < 0 && k <= MAX_ITERATIONS) k += 1;
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  for (let i = 0; Math.abs(B - A) > EPSILON && i < MAX_ITERATIONS; i += 1) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      // The Illinois half-step: without it, one endpoint can stay stuck and
      // convergence degrades to linear.
      fA /= 2;
    }
    B = C;
    fB = fC;
  }

  return Math.exp(A / 2);
}

/**
 * Charges a player for however many whole rating periods have passed since
 * their last rated match: step 6 (phi* = sqrt(phi^2 + sigma^2)) applied once
 * per idle period, which telescopes into a single sqrt(phi^2 + n*sigma^2).
 *
 * This is the *uncertainty* half of inactivity handling - someone who has not
 * played in months is not assumed to have got worse, only to have become
 * harder to predict, so their next result moves them further than it otherwise
 * would. Actual rating loss for inactivity is a separate, deliberate policy
 * decision and lives in ratingDecay.js.
 *
 * rd is capped at the default: past a certain point we simply know nothing
 * about the player, and letting it grow without bound would make their first
 * match back swing wildly on a single result.
 */
function idle(player, now = Date.now()) {
  const rd = Math.min(player.rd, config.glickoDefaultRd);
  if (!player.ratedAt) return { ...player, rd };

  const periodMs = config.glickoRatingPeriodDays * 24 * 60 * 60 * 1000;
  const periods = Math.floor((now - new Date(player.ratedAt).getTime()) / periodMs);
  if (periods <= 0) return { ...player, rd };

  const phi = toPhi(rd);
  const inflated = fromPhi(Math.sqrt(phi * phi + periods * player.vol * player.vol));
  return { ...player, rd: Math.min(inflated, config.glickoDefaultRd) };
}

/**
 * The algorithm proper: steps 2-8 for one player against a batch of results.
 * `results` is `[{ opponent, score }]` with score 1 for a win, 0 for a loss
 * (0.5 would be a draw - this game has none, but the math does not care).
 *
 * Takes a batch rather than a single opponent because that is the shape the
 * paper defines it in, and it is what makes the worked example checkable
 * against this function directly. Callers with one match use rate() below.
 *
 * Neither this nor rate() inflates anyone for idleness - pass players through
 * idle() first, which rate() does.
 */
function update(player, results) {
  const mu = toMu(player.rating);
  const phi = toPhi(player.rd);

  // A player who sat out the period has nothing to be rated against; step 6
  // alone applies. Distinct from idle() above only in that this is "no games
  // this period" rather than "n periods since the last one".
  if (!results.length) {
    return {
      rating: player.rating,
      rd: Math.min(fromPhi(Math.sqrt(phi * phi + player.vol * player.vol)), config.glickoDefaultRd),
      vol: player.vol,
    };
  }

  // Steps 3 and 4, sharing one pass: v is the variance of the rating estimate
  // implied by these opponents, and `sum` drives the direction and size of the
  // move.
  let invV = 0;
  let sum = 0;
  for (const { opponent, score } of results) {
    const muJ = toMu(opponent.rating);
    const phiJ = toPhi(opponent.rd);
    const gJ = g(phiJ);
    const e = expected(mu, muJ, phiJ);
    invV += gJ * gJ * e * (1 - e);
    sum += gJ * (score - e);
  }
  const v = 1 / invV;
  const delta = v * sum;

  const vol = nextVolatility(phi, v, delta, player.vol);

  // Step 6 then 7: pre-period rd growth, then the actual update.
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + invV);
  const muPrime = mu + phiPrime * phiPrime * sum;

  return {
    rating: fromMu(muPrime),
    rd: Math.min(fromPhi(phiPrime), config.glickoDefaultRd),
    vol,
  };
}

/**
 * One match, from `self`'s side. Both players are aged through idle() first so
 * a long-absent opponent counts as the uncertain quantity they are, then rated
 * against each other's *pre-match* numbers - the two sides of a match are one
 * simultaneous update, so neither may see the other's new rating.
 *
 * Callers must therefore pass the same stored values to both sides' calls,
 * not feed one side's output into the other's input.
 */
function rate(self, opponent, score, now = Date.now()) {
  return update(idle(self, now), [{ opponent: idle(opponent, now), score }]);
}

/**
 * What this match is worth to `self` before it is played: the rating change
 * they would see for a win and for a loss. Exact rather than an estimate -
 * neither player can play anything else in between, so these are the numbers
 * that will actually land.
 *
 * Feeds matchmaking.js's eloStake(), i.e. the "win big / lose little" line on
 * the pre-game screen.
 */
function project(self, opponent, now = Date.now()) {
  const before = self.rating;
  return {
    winDelta: rate(self, opponent, 1, now).rating - before,
    lossDelta: rate(self, opponent, 0, now).rating - before,
  };
}

// Starting point for a player who has never been rated. The database columns
// default to these too (see migrations/2_glicko.sql); this is for the
// in-memory paths that need one before any row exists.
function initial(rating = config.startingElo) {
  return { rating, rd: config.glickoDefaultRd, vol: config.glickoDefaultVolatility, ratedAt: null };
}

module.exports = { idle, update, rate, project, initial };
