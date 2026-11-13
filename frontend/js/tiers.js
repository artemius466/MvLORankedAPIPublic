// MvLO Ranked — the rank ladder. Single source of truth for both the player
// card on the main page and the tier map, so the two can never disagree.
//
// Each band is [minimum elo, name] and is split into 3 equal divisions. The top
// band has no successor, so it gets a nominal span and its last division is
// open ended.
"use strict";
(function () {
  const BANDS = [[0, "Mini"], [350, "Mushroom"], [650, "Shell"], [950, "Fireflower"], [1200, "Star"]];
  const TOP_BAND_SPAN = 300;
  const DIVISIONS = 3;
  const FLOOR = BANDS[0][0];

  const ICON = {
    Mini: "assets/ranks/mini.png",
    Mushroom: "assets/ranks/mushroom.png",
    Shell: "assets/ranks/shell.png",
    Fireflower: "assets/ranks/fireflower.png",
    Star: "assets/ranks/star.png",
  };
  const COLOR = { Mini: "#1b4fd8", Mushroom: "#d02a1e", Shell: "#3fbb35", Fireflower: "#f2a600", Star: "#f2c200" };

  function iconUrl(name) {
    return ICON[name] || ICON.Mini;
  }

  function tierFor(elo) {
    let idx = 0;
    for (let i = 0; i < BANDS.length; i++) if (elo >= BANDS[i][0]) idx = i;
    const name = BANDS[idx][1], lo = BANDS[idx][0];
    const hi = BANDS[idx + 1] ? BANDS[idx + 1][0] : lo + TOP_BAND_SPAN;
    const frac = Math.max(0, Math.min(0.999, (elo - lo) / (hi - lo)));
    const div = Math.floor(frac * DIVISIONS) + 1;
    const pct = Math.round(((frac * DIVISIONS) % 1) * 100);
    const next = div < DIVISIONS
      ? name + " " + (div + 1)
      : BANDS[idx + 1] ? BANDS[idx + 1][1] + " 1" : "the top of the ladder";
    return { label: name + " " + div, name, div, pct, next };
  }

  // Derives the elo range of every tier and division from the same numbers
  // tierFor() branches on, rather than restating them.
  function ladder() {
    return BANDS.map(([lo, name], i) => {
      const next = BANDS[i + 1];
      const hi = next ? next[0] : lo + TOP_BAND_SPAN;
      const span = hi - lo;
      const divisions = [];
      for (let d = 1; d <= DIVISIONS; d++) {
        divisions.push({
          label: name + " " + d,
          division: d,
          from: Math.ceil(lo + (span * (d - 1)) / DIVISIONS),
          to: Math.ceil(lo + (span * d) / DIVISIONS) - 1,
          open: !next && d === DIVISIONS,
        });
      }
      return {
        name,
        color: COLOR[name],
        from: lo,
        to: hi - 1,
        span,
        open: !next,
        isFloor: i === 0,
        divisions,
      };
    });
  }

  function totalSpan() {
    return ladder().reduce((sum, tier) => sum + tier.span, 0);
  }

  window.MvLOTiers = { BANDS, ICON, COLOR, DIVISIONS, FLOOR, iconUrl, tierFor, ladder, totalSpan };
})();
