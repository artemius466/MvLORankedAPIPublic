// MvLO Ranked — shared "match details" modal, opened by clicking a match
// history row on either the main site (app.js) or a profile page (user.js).
// Self-contained (own fetch, own API_BASE) rather than reusing MvLOAuth.api -
// user.html never loads auth.js, and the endpoint this hits needs no session
// anyway, same as GET /api/users/:id/matches.
"use strict";
(function () {
  const meta = document.querySelector('meta[name="mvlo-api-base"]');
  const API_BASE = ((meta && meta.content) || "").replace(/\/$/, "");

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let root = null;
  function ensureRoot() {
    if (root) return root;
    root = document.createElement("div");
    root.id = "match-detail-overlay";
    root.hidden = true;
    // display is set explicitly by show()/close() below rather than baked in
    // here - an inline `display` would out-specificity the `[hidden]` UA
    // rule and the overlay would never actually disappear.
    root.style.cssText = "position:fixed;inset:0;z-index:1000;align-items:center;justify-content:center;padding:18px;background:rgba(23,22,29,.72)";
    root.innerHTML = `<div id="match-detail-card" style="width:100%;max-width:560px;max-height:88vh;overflow:auto;background:#fdf3d7;border:5px solid #17161d;box-shadow:inset 0 0 0 4px #fff,10px 10px 0 rgba(23,22,29,.4);padding:22px"></div>`;
    root.addEventListener("click", (e) => {
      if (e.target === root) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && root && !root.hidden) close();
    });
    document.body.appendChild(root);
    return root;
  }

  function bindClose() {
    root.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", close));
  }

  function show() {
    root.hidden = false;
    root.style.display = "flex";
  }

  function close() {
    if (!root) return;
    root.hidden = true;
    root.style.display = "none";
  }

  const CLOSE_BTN = `<button data-close type="button" style="all:unset;cursor:pointer;font:22px 'MarioUI';color:#17161d;line-height:1;padding:2px 6px">&times;</button>`;

  function playerCard(p, label) {
    const win = p.eloDelta > 0;
    const deltaText = win ? "+" + p.eloDelta : String(p.eloDelta);
    // The avatar+name link stops short of wrapping the whole card since the
    // REPLAY link below is also an <a> - nested anchors are invalid HTML and
    // browsers close the outer one early, which would break this click too.
    return `<div style="flex:1 1 200px;min-width:0;border:4px solid #17161d;background:#fff;box-shadow:6px 6px 0 rgba(23,22,29,.22);padding:14px;text-align:center">
      <div style="font:13px 'MarioUI';color:#8b7a4e;letter-spacing:1px;margin-bottom:8px">${label}</div>
      <a href="/user/${encodeURIComponent(p.id)}" style="display:block;color:inherit;text-decoration:none">
        <img src="${esc(p.avatarUrl)}" alt="" width="64" height="64" style="display:block;margin:0 auto 8px;border:4px solid #17161d;background:#fff">
        <div style="font:19px 'MarioUI';color:#17161d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name || "Unknown player")}</div>
      </a>
      <div style="margin-top:6px;font:24px 'MarioUI';color:${win ? "#2f8f28" : "#d02a1e"}">${deltaText}</div>
      ${p.replayUrl
        ? `<a href="${esc(p.replayUrl)}" download style="display:inline-block;margin-top:10px;font:14px 'MarioUI';color:#1b4fd8;border:3px solid #17161d;background:#dbe8ff;padding:5px 12px">DOWNLOAD REPLAY</a>`
        : `<div style="margin-top:10px;font:13px 'MarioUI';color:#a08f63">No replay uploaded</div>`}
    </div>`;
  }

  function renderLoading() {
    ensureRoot();
    show();
    document.getElementById("match-detail-card").innerHTML = `
      <div style="display:flex;justify-content:flex-end">${CLOSE_BTN}</div>
      <p style="margin:0;display:flex;align-items:center;gap:10px;font:16px 'MarioUI';color:#8b7a4e">
        <span style="width:20px;height:20px;background:url('assets/loading.png') 0 0/188px 20px;animation:spin8 .64s steps(8,end) infinite"></span>LOADING MATCH
      </p>`;
    bindClose();
  }

  function renderError(message) {
    document.getElementById("match-detail-card").innerHTML = `
      <div style="display:flex;justify-content:flex-end">${CLOSE_BTN}</div>
      <p style="margin:0;font:16px 'MarioUI';color:#d02a1e">Could not load this match: ${esc(message)}</p>`;
    bindClose();
  }

  function renderMatch(m) {
    const when = new Date(m.playedAt).toLocaleString();
    const stageName = window.MvLOMaps ? window.MvLOMaps.displayName(m.stage) : m.stage;
    const [a, b] = m.players || [];
    document.getElementById("match-detail-card").innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px">
        <div>
          <h2 style="margin:0;font:24px 'MarioUI';color:#17161d">MATCH DETAILS</h2>
          <p style="margin:6px 0 0;font:14px 'MarioUI';color:#8b7a4e">${esc(stageName)} · ${esc(when)}</p>
          <p style="margin:4px 0 0;font:12px 'MarioUI';color:#a08f63">MATCH ID: ${esc(m.matchUid)}</p>
        </div>
        ${CLOSE_BTN}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px">
        ${a ? playerCard(a, "PLAYER") : ""}
        ${b ? playerCard(b, "OPPONENT") : ""}
      </div>`;
    bindClose();
  }

  async function open(matchUid) {
    if (!matchUid) return;
    renderLoading();
    try {
      const res = await fetch(API_BASE + "/api/matches/" + encodeURIComponent(matchUid));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
      renderMatch(data.match);
    } catch (err) {
      renderError(err.message);
    }
  }

  window.MvLOMatchDetail = { open, close };
})();
