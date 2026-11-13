// MvLO Ranked — tier map page. The scale and tier-by-tier list are rendered by
// js/ladder-render.js (shared with the player profile page); this file only
// owns the "you are here" strip, which is specific to the signed-in viewer.
"use strict";
(function () {
  const L = window.MvLOLadderView;
  // The accent this page's ELO chip and pin use.
  const ELO_COLOR = "#3a7bd8";

  const el = {};
  ["you-are-here", "auth-error"].forEach((id) => (el[id] = document.getElementById(id)));

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // --- "you are here" strip -------------------------------------------------

  // The player's chip/label/rating plus its own mini progress bar.
  function trackHtml(user, place) {
    const elo = user.elo;
    const t = window.MvLOTiers.tierFor(elo);
    const toNext = place && !place.division.open ? place.division.to + 1 - elo : null;
    return `
      <div style="flex:1 1 220px;min-width:190px">
        <div style="display:flex;align-items:center;gap:7px;font:16px 'MarioUI';color:#4c4634">
          ${L.chipSpan(t.name, 20)}${esc(t.label)} · <span style="color:${ELO_COLOR}">${esc(elo)}</span> ELO
        </div>
        <div style="margin-top:6px;height:12px;background:#3b3524;border:3px solid #17161d;padding:1px">
          <div style="height:100%;width:${t.pct}%;background:${ELO_COLOR};transition:width .4s steps(6,end)"></div>
        </div>
        <div style="margin-top:5px;font:13px 'MarioUI';color:#8b7a4e">${
          toNext === null ? "TOP DIVISION · NO CAP ABOVE YOU" : `${t.pct}% THROUGH · ${toNext} TO ${esc(t.next.toUpperCase())}`
        }</div>
      </div>`;
  }

  function renderYouAreHere(auth, places) {
    if (auth.status === "loading") {
      el["you-are-here"].innerHTML = `
        <div class="here-card" style="justify-content:center">
          <span style="width:20px;height:20px;background:url('assets/loading.png') 0 0/188px 20px;animation:spin8 .64s steps(8,end) infinite"></span>
          <span style="font:16px 'MarioUI';color:#8b7a4e">CHECKING SESSION</span>
        </div>`;
      return;
    }

    if (auth.status !== "authenticated" || !auth.user) {
      el["you-are-here"].innerHTML = `
        <div class="here-card">
          <span style="width:38px;height:38px;flex:none;background:url('assets/qblock.png') center/contain no-repeat;animation:bob 2.4s steps(2,end) infinite"></span>
          <p style="margin:0;flex:1 1 200px;font:16px/1.5 'MarioUI';color:#4c4634">Log in with Discord to see exactly where you sit on the map.</p>
          <button class="discord-btn" data-login style="width:auto;flex:none">LOGIN WITH DISCORD</button>
        </div>`;
      return;
    }

    const user = auth.user;

    el["you-are-here"].innerHTML = `
      <div class="here-card" style="background:#fff">
        <img src="${esc(user.avatarUrl)}" alt="" width="56" height="56" style="flex:none;display:block;border:4px solid #17161d;background:#fff">
        <div style="flex:1 1 160px;min-width:150px">
          <div style="font:14px 'MarioUI';color:#8b7a4e;letter-spacing:1.5px">YOU ARE HERE</div>
          <div style="font:24px 'MarioUI';color:#17161d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(user.displayName)}</div>
        </div>
        ${trackHtml(user, places.elo)}
      </div>`;
  }

  function renderAuthError(auth) {
    el["auth-error"].hidden = !auth.error;
    if (auth.error) el["auth-error"].textContent = auth.error;
  }

  L.renderScale("tier-scale");
  L.renderList("tier-list", []);

  document.addEventListener("click", (e) => {
    const login = e.target.closest("[data-login]");
    if (login) {
      login.disabled = true;
      login.textContent = "OPENING DISCORD";
      window.MvLOAuth.login();
    }
  });

  window.MvLOAuth.subscribe((auth) => {
    const user = auth.status === "authenticated" ? auth.user : null;
    const places = { elo: user ? L.placeOf(user.elo) : null };

    renderYouAreHere(auth, places);
    L.renderPin("elo", user ? user.elo : null, "YOU", ELO_COLOR, 0);
    L.renderList("tier-list", [{ place: places.elo, label: "YOU", color: ELO_COLOR }]);
    renderAuthError(auth);
  });
})();
