// MvLO Ranked — main page. The leaderboard, player card and match history are
// all real and come from the API (leaderboard via a plain one-shot fetch, not
// a live-updating tick).
"use strict";
(function () {
  // The ladder itself lives in js/tiers.js, shared with the tier map page.
  const { tierFor, iconUrl, COLOR: TIER_COLOR } = window.MvLOTiers;
  const TAB_DEFS = ["board", "announcements", "rules", "history"];
  // The accent every ELO counter on this page uses.
  const ELO_COLOR = "#3a7bd8";
  const BOARD_PAGE_SIZE = 10;

  function chipSpan(name, size) {
    return `<span style="flex:none;width:${size}px;height:${size}px;background:url('${iconUrl(name)}') center/contain no-repeat"></span>`;
  }

  // Section divider dropped into the leaderboard list wherever the tier
  // changes going down the (paginated) ranking - see renderBoard().
  function tierHeader(t) {
    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 14px;border:4px solid #17161d;background:${TIER_COLOR[t.name]};box-shadow:5px 5px 0 rgba(23,22,29,.22)">
      ${chipSpan(t.name, 24)}<span style="font:17px 'MarioUI';color:#fff;text-shadow:2px 2px 0 #17161d;letter-spacing:1px">${esc(t.name.toUpperCase())}</span>
    </div>`;
  }

  // The player's tier chip, label and colored rating, with its own mini
  // progress bar underneath.
  function trackRow(elo) {
    const t = tierFor(elo);
    return `
      <div style="margin-top:8px">
        <div style="display:flex;align-items:center;gap:7px;font:15px 'MarioUI';color:#4c4634">
          ${chipSpan(t.name, 20)}${esc(t.label)} · <span style="color:${ELO_COLOR}">${esc(elo)}</span> ELO
        </div>
        <div style="margin-top:4px;height:10px;background:#3b3524;border:3px solid #17161d;padding:1px">
          <div style="height:100%;width:${t.pct}%;background:${ELO_COLOR};transition:width .4s steps(6,end)"></div>
        </div>
      </div>`;
  }

  const state = {
    tab: "board",
    board: { status: "idle", page: 0, players: [], total: 0, error: null },
    announcements: { status: "idle", items: [], error: null },
    auth: { status: "loading", user: null, error: null },
    history: { status: "idle", matches: [], error: null, forUserId: null },
    online: { status: "idle", count: 0 }
  };

  // Kept well under the server's PRESENCE_TTL_SECONDS (default 90s) so the
  // number on screen never looks stale for long.
  const ONLINE_POLL_MS = 20000;

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const el = {};
  function cacheEls() {
    [
      "user-card", "auth-error",
      "history-gate", "history-content",
      "panel-board", "panel-announcements", "panel-rules", "panel-history",
      "board-list", "board-summary", "board-pager",
      "announcements-summary", "announcements-list",
      "history-summary", "history-list",
      "online-badge"
    ].forEach((id) => (el[id] = document.getElementById(id)));
  }

  const CARD_LABEL = `<span style="font:14px 'MarioUI';color:#8b7a4e;letter-spacing:1.5px">YOUR CARD</span>`;

  let banWarningShown = false;
  function showBanWarningModal(ban) {
    if (banWarningShown) return;
    banWarningShown = true;

    const modal = document.createElement("div");
    modal.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(23,22,29,.78)";
    modal.innerHTML = `
      <div style="width:100%;max-width:520px;background:#fdf3d7;border:5px solid #17161d;box-shadow:inset 0 0 0 4px #fff,10px 10px 0 rgba(23,22,29,.45);padding:24px;position:relative">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <span style="font-size:28px">⚠️</span>
          <h2 style="margin:0;font:26px 'MarioUI';color:#d02a1e;letter-spacing:1px">ACCOUNT BANNED</h2>
        </div>
        <p style="margin:0 0 12px;font:16px/1.5 'MarioUI';color:#17161d">
          You are currently banned from ranked matchmaking.
        </p>
        <div style="padding:12px 14px;background:#ffe9a8;border:4px solid #17161d;margin-bottom:14px;box-shadow:4px 4px 0 rgba(23,22,29,.2)">
          <div style="font:14px 'MarioUI';color:#8b7a4e;margin-bottom:4px">REASON</div>
          <div style="font:16px 'MarioUI';color:#17161d">${esc(ban.reason || "Violation of rules")}</div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;font:15px 'MarioUI';color:#4c4634">
          <span>TIME REMAINING:</span>
          <span style="font-size:18px;color:#d02a1e;font-weight:700">${ban.hoursLeft} hour${ban.hoursLeft === 1 ? "" : "s"} left</span>
        </div>
        <div style="display:flex;justify-content:flex-end">
          <button class="pager-btn admin-revert-danger" data-ban-dismiss style="padding:8px 20px;font-size:16px" type="button">I UNDERSTAND</button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    modal.querySelector("[data-ban-dismiss]").addEventListener("click", () => {
      modal.remove();
    });
  }

  // Rank is derived here, on the client, straight from the ELO the API returns.
  let userCardKey = null;
  function renderUserCard() {
    const { status, user } = state.auth;
    const banKey = user && user.ban ? (user.ban.hoursLeft + "|" + user.ban.reason) : "";
    const key = status + "|" + (user ? [user.id, user.displayName, user.username, user.avatarUrl, user.elo, banKey].join("|") : "");
    if (key === userCardKey) return;
    userCardKey = key;

    if (status === "loading") {
      el["user-card"].innerHTML = `<div style="margin-bottom:10px">${CARD_LABEL}</div>
        <div style="display:flex;align-items:center;gap:10px;font:16px 'MarioUI';color:#8b7a4e">
          <span style="width:20px;height:20px;background:url('assets/loading.png') 0 0/188px 20px;animation:spin8 .64s steps(8,end) infinite"></span>CHECKING SESSION
        </div>`;
      return;
    }

    if (status !== "authenticated" || !user) {
      el["user-card"].innerHTML = `<div style="margin-bottom:10px">${CARD_LABEL}</div>
        <p style="margin:0 0 14px;font:15px/1.5 'MarioUI';color:#4c4634">Log in with Discord to queue up, earn ELO and hold a rank.</p>
        <button class="discord-btn" data-login>LOGIN WITH DISCORD</button>`;
      return;
    }

    el["user-card"].innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">
        ${CARD_LABEL}
        <span style="display:flex;gap:6px">
          <button class="logout-btn" data-settings>SETTINGS</button>
          <button class="logout-btn" data-logout>LOG OUT</button>
        </span>
      </div>
      <a href="/user/${encodeURIComponent(user.id)}" style="display:block;color:inherit;text-decoration:none">
        <div style="display:flex;align-items:center;gap:12px">
          <img src="${esc(user.avatarUrl)}" alt="" width="56" height="56" style="flex:none;display:block;border:4px solid #17161d;background:#fff">
          <div style="line-height:1.3;min-width:0;flex:1 1 auto">
            <div style="font:21px 'MarioUI';color:#17161d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(user.displayName)}</div>
            <div style="font:14px 'MarioUI';color:#a08f63;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">@${esc(user.username)}</div>
          </div>
        </div>
        ${user.ban ? `<div style="margin-top:8px;padding:6px 10px;background:#d02a1e;border:3px solid #17161d;color:#fff;font:14px 'MarioUI';text-align:center;box-shadow:3px 3px 0 rgba(23,22,29,.35)">
          ⚠️ BANNED (${user.ban.hoursLeft}h left)
          <div style="font-size:12px;opacity:.9;margin-top:2px">${esc(user.ban.reason)}</div>
        </div>` : ""}
        ${trackRow(user.elo)}
      </a>`;
  }

  function renderGates() {
    const locked = state.auth.status !== "authenticated";
    el["history-gate"].hidden = !locked;
    el["history-content"].hidden = locked;
  }

  function renderAuthError() {
    const message = state.auth.error;
    el["auth-error"].hidden = !message;
    if (message) el["auth-error"].textContent = message;
  }

  function renderTabs() {
    for (const id of TAB_DEFS) {
      const btn = document.getElementById("tab-" + id);
      btn.classList.toggle("active", state.tab === id);
    }
  }

  // Public read of GET /api/online - reflects however many game clients have
  // sent a heartbeat within the server's presence TTL.
  async function loadOnline() {
    try {
      const data = await window.MvLOAuth.api("/api/online");
      state.online = { status: "loaded", count: data.online || 0 };
    } catch {
      state.online = { status: "error", count: state.online.count };
    }
    renderOnline();
  }

  function renderOnline() {
    const { status, count } = state.online;
    if (status === "idle") {
      el["online-badge"].innerHTML = "";
      return;
    }
    el["online-badge"].innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:${status === "error" ? "#8b7a4e" : "#3fbb35"}"></span>
      <span style="font:14px 'MarioUI';color:#fff;letter-spacing:.5px">${count} ONLINE</span>`;
  }

  function renderPanels() {
    el["panel-board"].hidden = state.tab !== "board";
    el["panel-announcements"].hidden = state.tab !== "announcements";
    el["panel-rules"].hidden = state.tab !== "rules";
    el["panel-history"].hidden = state.tab !== "history";
  }

  async function loadAnnouncements() {
    state.announcements = { status: "loading", items: [], error: null };
    render();
    try {
      const data = await window.MvLOAuth.api("/api/announcements");
      state.announcements = { status: "loaded", items: Array.isArray(data) ? data : [], error: null };
    } catch (err) {
      state.announcements = { status: "error", items: [], error: err.message };
    }
    render();
  }

  function renderAnnouncements() {
    const a = state.announcements;
    if (a.status === "loading" || a.status === "idle") {
      el["announcements-summary"].textContent = "";
      el["announcements-list"].innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">Loading announcements…</p>`;
      return;
    }
    if (a.status === "error") {
      el["announcements-summary"].textContent = "";
      el["announcements-list"].innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#d02a1e">Could not load announcements: ${esc(a.error)}</p>`;
      return;
    }
    if (!a.items.length) {
      el["announcements-summary"].textContent = "0 POSTS";
      el["announcements-list"].innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">No announcements yet.</p>`;
      return;
    }

    el["announcements-summary"].textContent = `${a.items.length} POST${a.items.length === 1 ? "" : "S"}`;
    el["announcements-list"].innerHTML = a.items
      .map((item) => {
        const dateStr = item.created
          ? new Date(item.created * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
          : "";
        const rawContent = item.content || item.text || "";
        const renderedBody = window.MvLOMarkdown ? window.MvLOMarkdown.render(rawContent) : esc(rawContent);
        return `
          <article style="border:4px solid #17161d;background:#fff;box-shadow:6px 6px 0 rgba(23,22,29,.25);padding:20px">
            <header style="border-bottom:3px dashed #17161d;padding-bottom:12px;margin-bottom:14px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px">
              <h3 style="margin:0;font:clamp(20px,3vw,26px) 'MarioUI';color:#17161d;letter-spacing:1px">${esc(item.title)}</h3>
              <div style="font:14px 'MarioUI';color:#8b7a4e">
                By <strong style="color:#17161d">${esc(item.author)}</strong> · <span>${esc(dateStr)}</span>
              </div>
            </header>
            <div class="announcement-content" style="word-break:break-word">
              ${renderedBody}
            </div>
          </article>`;
      })
      .join("");
  }

  // `page` is 0-based and turned into the API's offset here; the previous
  // total is kept around through the loading state so the pager's "OF N"
  // doesn't flash to 1 while a page turn is in flight.
  async function loadBoard() {
    const { page, total } = state.board;
    state.board = { status: "loading", page, players: [], total, error: null };
    render();
    try {
      const offset = page * BOARD_PAGE_SIZE;
      const data = await window.MvLOAuth.api(
        "/api/leaderboard?limit=" + BOARD_PAGE_SIZE + "&offset=" + offset
      );
      state.board = { status: "loaded", page, players: data.players || [], total: data.total || 0, error: null };
    } catch (err) {
      state.board = { status: "error", page, players: [], total: 0, error: err.message };
    }
    render();
  }

  function renderBoard() {
    const b = state.board;

    if (b.status === "loading" || b.status === "idle") {
      el["board-summary"].textContent = "";
      el["board-list"].innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">Loading leaderboard…</p>`;
      return;
    }
    if (b.status === "error") {
      el["board-summary"].textContent = "";
      el["board-list"].innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#d02a1e">Could not load the leaderboard: ${esc(b.error)}</p>`;
      return;
    }
    if (!b.players.length) {
      el["board-summary"].textContent = b.page > 0 ? "NO PLAYERS ON THIS PAGE." : "NO RANKED PLAYERS YET.";
      el["board-list"].innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">No ranked players yet.</p>`;
      return;
    }

    const firstRank = b.page * BOARD_PAGE_SIZE + 1;
    const lastRank = firstRank + b.players.length - 1;
    el["board-summary"].textContent = `SHOWING ${firstRank}–${lastRank} OF ${b.total} RANKED PLAYER${b.total === 1 ? "" : "S"}.`;
    el["board-list"].innerHTML = b.players
      .map((p, i) => {
        const rank = firstRank + i;
        const elo = p.elo;
        const t = tierFor(elo);
        // The leaderboard is sorted by rating, so tiers arrive in contiguous
        // runs - a header marks each boundary. i === 0 always gets one too
        // (prevTier is null), so a page opened mid-tier still says which one
        // it's showing rather than relying on whatever the previous page had.
        const prevTier = i === 0 ? null : tierFor(b.players[i - 1].elo).name;
        const header = t.name !== prevTier ? tierHeader(t) : "";
        const rankBg = rank === 1 ? "#f2c200" : rank <= 3 ? "#3a7bd8" : "#8b7a4e";
        return header + `<a class="board-row" href="/user/${encodeURIComponent(p.id)}">
          <div style="flex:none;width:42px;height:42px;background:${rankBg};border:4px solid #17161d;display:grid;place-items:center;font:20px 'MarioUI';color:#fff;text-shadow:2px 2px 0 #17161d">${rank}</div>
          <div style="flex:none;position:relative;width:42px;height:42px">
            <img src="${esc(p.avatarUrl)}" alt="" width="42" height="42" style="display:block;border:4px solid #17161d;background:#fff">
            ${p.online ? `<span title="Online" style="position:absolute;right:-3px;bottom:-3px;width:12px;height:12px;border-radius:50%;background:#3fbb35;border:3px solid #fdf3d7"></span>` : ""}
          </div>
          <div style="flex:1 1 120px;min-width:0">
            <div style="font:21px 'MarioUI';color:#17161d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.country ? `<span title="${esc(window.MvLOCountries.nameFor(p.country))}">${window.MvLOCountries.flagEmoji(p.country)}</span> ` : ""}${esc(p.displayName)}</div>
            <div style="font:14px 'MarioUI';color:#8b7a4e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">@${esc(p.username)}</div>
            ${p.bio ? `<div style="font:13px 'MarioUI';color:#a08f63;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.bio)}</div>` : ""}
          </div>
          <div style="flex:none;display:inline-flex;align-items:center;gap:8px;border:4px solid #17161d;background:#fff;padding:2px 10px 2px 3px">
            <span style="width:26px;height:26px;background:url('${iconUrl(t.name)}') center/contain no-repeat"></span>
            <span style="font:16px 'MarioUI';color:#17161d;white-space:nowrap">${t.label}</span>
          </div>
          <div style="flex:none;margin-left:auto;min-width:96px;text-align:right">
            <div style="font:22px 'MarioUI';color:${ELO_COLOR}">${elo}</div>
          </div>
        </a>`;
      })
      .join("");
  }

  // Prev/Next pager for the leaderboard - total (and hence page count) comes
  // from the API response, not a client-side guess, since only the server
  // knows how many ranked players exist.
  function renderBoardPager() {
    const b = state.board;
    if (b.status !== "loaded" && b.status !== "loading") {
      el["board-pager"].innerHTML = "";
      return;
    }
    const totalPages = Math.max(1, Math.ceil(b.total / BOARD_PAGE_SIZE));
    const page = b.page + 1;
    const busy = b.status === "loading";
    el["board-pager"].innerHTML = `
      <button type="button" class="pager-btn" data-board-page="prev" ${busy || page <= 1 ? "disabled" : ""}>◄ PREV</button>
      <span style="font:15px 'MarioUI';color:#8b7a4e">PAGE ${page} OF ${totalPages}</span>
      <button type="button" class="pager-btn" data-board-page="next" ${busy || page >= totalPages ? "disabled" : ""}>NEXT ►</button>`;
  }

  // Fetches the signed-in player's own history from the public matches
  // endpoint. The endpoint itself accepts any user id, but the frontend only
  // ever asks for the logged-in player's own id.
  async function loadHistory(userId) {
    state.history = { status: "loading", matches: [], error: null, forUserId: userId };
    render();
    try {
      const data = await window.MvLOAuth.api("/api/users/" + encodeURIComponent(userId) + "/matches");
      if (state.history.forUserId !== userId) return; // superseded by a newer request
      state.history = { status: "loaded", matches: data.matches || [], error: null, forUserId: userId };
    } catch (err) {
      if (state.history.forUserId !== userId) return;
      state.history = { status: "error", matches: [], error: err.message, forUserId: userId };
    }
    render();
  }

  function renderHistory() {
    const h = state.history;

    if (h.status === "loading" || h.status === "idle") {
      el["history-summary"].textContent = "";
      el["history-list"].innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">Loading match history…</p>`;
      return;
    }
    if (h.status === "error") {
      el["history-summary"].textContent = "";
      el["history-list"].innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#d02a1e">Could not load match history: ${esc(h.error)}</p>`;
      return;
    }
    if (!h.matches.length) {
      el["history-summary"].textContent = "LAST 0 · NET +0";
      el["history-list"].innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">No ranked matches played yet.</p>`;
      return;
    }

    const net = h.matches.reduce((sum, m) => sum + m.eloDelta, 0);
    el["history-summary"].textContent = `LAST ${h.matches.length} · NET ${net >= 0 ? "+" + net : net}`;
    el["history-list"].innerHTML = h.matches
      .map((m) => {
        const win = m.eloDelta > 0;
        const deltaText = win ? "+" + m.eloDelta : String(m.eloDelta);
        const when = new Date(m.playedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        const clickable = Boolean(m.matchUid);
        return `<div ${clickable ? `data-match-uid="${esc(m.matchUid)}"` : ""} style="display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;border:4px solid #17161d;background:#fff;padding:10px 14px;box-shadow:5px 5px 0 rgba(23,22,29,.22)${clickable ? ";cursor:pointer" : ""}">
          <div style="flex:none;width:44px;height:40px;background:${win ? "#3fbb35" : "#d02a1e"};border:4px solid #17161d;display:grid;place-items:center;font:20px 'MarioUI';color:#fff;text-shadow:2px 2px 0 #17161d">${win ? "W" : "L"}</div>
          <div style="flex:1 1 130px;min-width:0">
            <div style="font:19px 'MarioUI';color:#17161d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.opponentName)}</div>
            <div style="display:flex;align-items:center;gap:6px;font:14px 'MarioUI';color:#8b7a4e">
              ${esc(window.MvLOMaps.displayName(m.stage))}
            </div>
          </div>
          <div style="flex:none;margin-left:auto;font:15px 'MarioUI';color:#a08f63">${when}</div>
          <div style="flex:none;min-width:60px;text-align:right;font:20px 'MarioUI';color:${win ? "#2f8f28" : "#d02a1e"}">${deltaText}</div>
          ${m.replayUrl ? `<a href="${esc(m.replayUrl)}" style="flex:none;font:14px 'MarioUI';color:#1b4fd8" download>REPLAY</a>` : ""}
        </div>`;
      })
      .join("");
  }

  function render() {
    renderUserCard();
    renderAuthError();
    renderGates();
    renderTabs();
    renderPanels();
    renderOnline();
    if (state.tab === "board") {
      renderBoard();
      renderBoardPager();
    }
    if (state.tab === "announcements") renderAnnouncements();
    if (state.tab === "history" && state.auth.status === "authenticated") renderHistory();
  }

  function bindEvents() {
    for (const id of TAB_DEFS) {
      document.getElementById("tab-" + id).addEventListener("click", () => {
        state.tab = id;
        if (id === "announcements" && state.announcements.status === "idle") {
          loadAnnouncements();
        }
        render();
      });
    }
    // The login/logout buttons and history rows all live inside re-rendered
    // markup, so delegate.
    document.addEventListener("click", (e) => {
      const login = e.target.closest("[data-login]");
      if (login) {
        login.disabled = true;
        login.textContent = "OPENING DISCORD";
        window.MvLOAuth.login();
        return;
      }
      if (e.target.closest("[data-logout]")) return void window.MvLOAuth.logout();
      if (e.target.closest("[data-settings]")) return void window.MvLOProfileSettings.open();

      const pageBtn = e.target.closest("[data-board-page]");
      if (pageBtn) {
        if (pageBtn.disabled) return;
        const page = state.board.page + (pageBtn.dataset.boardPage === "prev" ? -1 : 1);
        state.board = { ...state.board, page };
        loadBoard();
        return;
      }

      // The REPLAY link inside a row should just download, not also open the
      // detail modal underneath it.
      const row = e.target.closest("[data-match-uid]");
      if (row && !e.target.closest("a")) window.MvLOMatchDetail.open(row.dataset.matchUid);
    });

    window.MvLOAuth.subscribe((auth) => {
      state.auth = { status: auth.status, user: auth.user, error: auth.error };
      if (auth.status === "authenticated" && auth.user && auth.user.ban) {
        showBanWarningModal(auth.user.ban);
      }
      if (auth.status === "authenticated" && auth.user && state.history.forUserId !== auth.user.id) {
        loadHistory(auth.user.id);
      } else if (auth.status !== "authenticated") {
        state.history = { status: "idle", matches: [], error: null, forUserId: null };
      }
      render();
    });
  }

  cacheEls();
  bindEvents();
  render();
  loadBoard();
  loadAnnouncements();
  loadOnline();
  setInterval(loadOnline, ONLINE_POLL_MS);
})();
