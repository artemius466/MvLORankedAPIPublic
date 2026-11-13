// MvLO Ranked — profile settings modal, opened from the signed-in player's
// own card (app.js). Auth-only: everything in here rides on MvLOAuth's
// bearer token, so this script is never loaded on user.html (see the comment
// atop match-detail.js for why that page carries no auth.js of its own).
"use strict";
(function () {
  const BIO_MAX_LENGTH = 280;

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let root = null;
  let sessions = { status: "idle", rows: [], error: null };

  function ensureRoot() {
    if (root) return root;
    root = document.createElement("div");
    root.id = "profile-settings-overlay";
    root.hidden = true;
    root.style.cssText = "position:fixed;inset:0;z-index:1000;align-items:center;justify-content:center;padding:18px;background:rgba(23,22,29,.72)";
    root.innerHTML = `<div id="profile-settings-card" style="width:100%;max-width:560px;max-height:88vh;overflow:auto;background:#fdf3d7;border:5px solid #17161d;box-shadow:inset 0 0 0 4px #fff,10px 10px 0 rgba(23,22,29,.4);padding:22px"></div>`;
    root.addEventListener("click", (e) => {
      if (e.target === root) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && root && !root.hidden) close();
    });
    document.body.appendChild(root);
    return root;
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

  function sessionRow(s) {
    const lastSeen = new Date(s.lastSeenAt).toLocaleString();
    const created = new Date(s.createdAt).toLocaleDateString();
    const expires = new Date(s.expiresAt).toLocaleDateString();
    return `<div style="display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;border:4px solid #17161d;background:#fff;padding:10px 12px;box-shadow:5px 5px 0 rgba(23,22,29,.22)">
      <div style="flex:1 1 180px;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;font:15px 'MarioUI';color:#17161d">
          ${s.current ? `<span style="flex:none;font:11px 'MarioUI';color:#17161d;background:#cdf2c6;border:3px solid #17161d;padding:2px 7px">CURRENT</span>` : "SESSION"}
        </div>
        <div style="margin-top:4px;font:13px 'MarioUI';color:#8b7a4e">Last active ${esc(lastSeen)}</div>
        <div style="font:12px 'MarioUI';color:#a08f63">Signed in ${esc(created)} · expires ${esc(expires)}</div>
      </div>
      <button type="button" data-revoke-session="${esc(s.id)}" style="flex:none;cursor:pointer;font:13px 'MarioUI';padding:6px 12px;border:3px solid #17161d;background:#c9a95f;color:#fdf3d7;text-shadow:1px 1px 0 rgba(23,22,29,.55)">REVOKE</button>
    </div>`;
  }

  function renderSessions() {
    const list = document.getElementById("settings-sessions-list");
    if (!list) return;
    if (sessions.status === "loading" || sessions.status === "idle") {
      list.innerHTML = `<p style="margin:0;font:14px 'MarioUI';color:#8b7a4e">Loading sessions…</p>`;
      return;
    }
    if (sessions.status === "error") {
      list.innerHTML = `<p style="margin:0;font:14px 'MarioUI';color:#d02a1e">Could not load sessions: ${esc(sessions.error)}</p>`;
      return;
    }
    if (!sessions.rows.length) {
      list.innerHTML = `<p style="margin:0;font:14px 'MarioUI';color:#8b7a4e">No active sessions.</p>`;
      return;
    }
    list.innerHTML = sessions.rows.map(sessionRow).join("");
  }

  async function loadSessions() {
    sessions = { status: "loading", rows: [], error: null };
    renderSessions();
    try {
      const data = await window.MvLOAuth.api("/api/sessions");
      sessions = { status: "loaded", rows: data.sessions || [], error: null };
    } catch (err) {
      sessions = { status: "error", rows: [], error: err.message };
    }
    renderSessions();
  }

  function bioStatus(message, isError) {
    const el = document.getElementById("settings-bio-status");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = isError ? "#d02a1e" : "#2f8f28";
  }

  function bioCount(length) {
    const el = document.getElementById("settings-bio-count");
    if (el) el.textContent = length + " / " + BIO_MAX_LENGTH;
  }

  function countryOptions(current, query = "") {
    const needle = query.trim().toLocaleLowerCase();
    const blank = `<option value=""${current ? "" : " selected"}>No flag</option>`;
    const matches = window.MvLOCountries.OPTIONS.filter((c) =>
      !needle || c.name.toLocaleLowerCase().includes(needle) || c.code.toLocaleLowerCase().includes(needle)
    );
    // Keep the selected country available even while the search is narrowed,
    // so typing a new search never silently changes the value that will save.
    if (current && !matches.some((c) => c.code === current)) {
      const selected = window.MvLOCountries.OPTIONS.find((c) => c.code === current);
      if (selected) matches.unshift(selected);
    }
    const rest = matches.map(
      (c) => `<option value="${esc(c.code)}"${c.code === current ? " selected" : ""}>${window.MvLOCountries.flagEmoji(c.code)} ${esc(c.name)}</option>`
    ).join("");
    return blank + rest;
  }

  function filterCountries() {
    const search = document.getElementById("settings-country-search");
    const select = document.getElementById("settings-country-input");
    const count = document.getElementById("settings-country-count");
    if (!search || !select || !count) return;

    const selected = select.value;
    const needle = search.value.trim().toLocaleLowerCase();
    const matchingCount = window.MvLOCountries.OPTIONS.filter((c) =>
      !needle || c.name.toLocaleLowerCase().includes(needle) || c.code.toLocaleLowerCase().includes(needle)
    ).length;
    select.innerHTML = countryOptions(selected, search.value);
    count.textContent = needle
      ? `${matchingCount} ${matchingCount === 1 ? "country" : "countries"} found`
      : "Search by country name or code.";
  }

  function renderCard() {
    const user = window.MvLOAuth.state.user || {};
    const bio = user.bio || "";
    document.getElementById("profile-settings-card").innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px">
        <h2 style="margin:0;font:24px 'MarioUI';color:#17161d">PROFILE SETTINGS</h2>
        ${CLOSE_BTN}
      </div>

      <section style="margin-bottom:24px">
        <h3 style="margin:0 0 8px;font:18px 'MarioUI';color:#17161d;letter-spacing:.5px">BIO</h3>
        <p style="margin:0 0 8px;font:13px 'MarioUI';color:#8b7a4e">Shown on your profile page and next to your name on the leaderboard.</p>
        <textarea id="settings-bio-input" maxlength="${BIO_MAX_LENGTH}" rows="4" style="width:100%;box-sizing:border-box;resize:vertical;font:15px 'MarioUI';color:#17161d;background:#fff;border:4px solid #17161d;padding:10px;box-shadow:5px 5px 0 rgba(23,22,29,.22)">${esc(bio)}</textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:8px">
          <span id="settings-bio-count" style="font:13px 'MarioUI';color:#8b7a4e">${bio.length} / ${BIO_MAX_LENGTH}</span>
          <button type="button" data-save-bio style="cursor:pointer;font:15px 'MarioUI';letter-spacing:.5px;padding:8px 18px;border:4px solid #17161d;background:#3a9c34;color:#fff;text-shadow:1px 1px 0 rgba(23,22,29,.55);box-shadow:0 5px 0 rgba(23,22,29,.45)">SAVE BIO</button>
        </div>
        <p id="settings-bio-status" style="margin:8px 0 0;font:13px 'MarioUI'"></p>
      </section>

      <section style="margin-bottom:24px">
        <h3 style="margin:0 0 8px;font:18px 'MarioUI';color:#17161d;letter-spacing:.5px">COUNTRY</h3>
        <p style="margin:0 0 8px;font:13px 'MarioUI';color:#8b7a4e">Shown as a flag next to your name, same spots as your bio.</p>
        <label for="settings-country-search" style="display:block;margin:0 0 5px;font:13px 'MarioUI';color:#17161d">SEARCH COUNTRIES</label>
        <input id="settings-country-search" type="search" autocomplete="off" placeholder="Type a country name or code…" style="width:100%;box-sizing:border-box;margin:0 0 7px;font:15px 'MarioUI';color:#17161d;background:#fff;border:4px solid #17161d;padding:9px;box-shadow:5px 5px 0 rgba(23,22,29,.22)">
        <p id="settings-country-count" aria-live="polite" style="margin:0 0 8px;font:12px 'MarioUI';color:#8b7a4e">Search by country name or code.</p>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
          <select id="settings-country-input" style="flex:1 1 200px;min-width:0;font:15px 'MarioUI';color:#17161d;background:#fff;border:4px solid #17161d;padding:9px;box-shadow:5px 5px 0 rgba(23,22,29,.22)">
            ${countryOptions(user.country)}
          </select>
          <button type="button" data-save-country style="cursor:pointer;font:15px 'MarioUI';letter-spacing:.5px;padding:8px 18px;border:4px solid #17161d;background:#3a9c34;color:#fff;text-shadow:1px 1px 0 rgba(23,22,29,.55);box-shadow:0 5px 0 rgba(23,22,29,.45)">SAVE COUNTRY</button>
        </div>
        <p id="settings-country-status" style="margin:8px 0 0;font:13px 'MarioUI'"></p>
      </section>

      <section>
        <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h3 style="margin:0;font:18px 'MarioUI';color:#17161d;letter-spacing:.5px">SESSIONS</h3>
          <button type="button" data-logout-others style="cursor:pointer;font:13px 'MarioUI';letter-spacing:.5px;padding:6px 12px;border:3px solid #17161d;background:#d02a1e;color:#fff;text-shadow:1px 1px 0 rgba(23,22,29,.55)">LOG OUT OTHER SESSIONS</button>
        </div>
        <div id="settings-sessions-list" style="display:flex;flex-direction:column;gap:8px"></div>
      </section>`;

    bindEvents();
    renderSessions();
  }

  async function saveBio() {
    const input = document.getElementById("settings-bio-input");
    const btn = document.querySelector("[data-save-bio]");
    const bio = input.value.trim();
    btn.disabled = true;
    btn.textContent = "SAVING…";
    bioStatus("", false);
    try {
      const data = await window.MvLOAuth.api("/api/me/bio", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bio: bio || null }),
      });
      // Keep MvLOAuth's cached user in sync so the rest of the page (and the
      // next render of this modal) reflects the saved bio without a reload.
      if (window.MvLOAuth.state.user) window.MvLOAuth.state.user.bio = data.user.bio;
      bioStatus("Saved.", false);
    } catch (err) {
      bioStatus(err.message || "Could not save bio.", true);
    }
    btn.disabled = false;
    btn.textContent = "SAVE BIO";
  }

  async function saveCountry() {
    const select = document.getElementById("settings-country-input");
    const btn = document.querySelector("[data-save-country]");
    const country = select.value || null;
    const status = document.getElementById("settings-country-status");
    btn.disabled = true;
    btn.textContent = "SAVING…";
    status.textContent = "";
    try {
      const data = await window.MvLOAuth.api("/api/me/country", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country }),
      });
      if (window.MvLOAuth.state.user) window.MvLOAuth.state.user.country = data.user.country;
      status.style.color = "#2f8f28";
      status.textContent = "Saved.";
    } catch (err) {
      status.style.color = "#d02a1e";
      status.textContent = err.message || "Could not save country.";
    }
    btn.disabled = false;
    btn.textContent = "SAVE COUNTRY";
  }

  async function revokeSession(id, isCurrent) {
    if (!confirm(isCurrent ? "Log out this device now?" : "Revoke this session?")) return;
    try {
      await window.MvLOAuth.api("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" });
      if (isCurrent) {
        close();
        window.MvLOAuth.logout();
        return;
      }
      sessions = { ...sessions, rows: sessions.rows.filter((s) => s.id !== id) };
      renderSessions();
    } catch (err) {
      alert("Could not revoke session: " + err.message);
    }
  }

  async function logoutOthers() {
    if (!confirm("Log out every other session? This device stays signed in.")) return;
    const btn = document.querySelector("[data-logout-others]");
    btn.disabled = true;
    try {
      await window.MvLOAuth.api("/api/sessions/logout-others", { method: "POST" });
      sessions = { ...sessions, rows: sessions.rows.filter((s) => s.current) };
      renderSessions();
    } catch (err) {
      alert("Could not log out other sessions: " + err.message);
    }
    btn.disabled = false;
  }

  function bindEvents() {
    const card = document.getElementById("profile-settings-card");
    card.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", close));

    const input = document.getElementById("settings-bio-input");
    input.addEventListener("input", () => bioCount(input.value.length));

    document.querySelector("[data-save-bio]").addEventListener("click", saveBio);
    document.querySelector("[data-save-country]").addEventListener("click", saveCountry);
    document.querySelector("[data-logout-others]").addEventListener("click", logoutOthers);

    document.getElementById("settings-country-search").addEventListener("input", filterCountries);

    card.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-revoke-session]");
      if (!btn) return;
      const id = btn.dataset.revokeSession;
      const row = sessions.rows.find((s) => s.id === id);
      revokeSession(id, Boolean(row && row.current));
    });
  }

  function open() {
    if (!window.MvLOAuth.isAuthenticated) return;
    ensureRoot();
    show();
    renderCard();
    loadSessions();
  }

  window.MvLOProfileSettings = { open, close };
})();
