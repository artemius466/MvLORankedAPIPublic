// MvLO Ranked - admin panel (frontend/admin.html).
//
// Gated entirely by the API: the /api/admin/* endpoints return 403 for any
// session whose discord id is not in config.adminDiscordIds, and this page
// simply refuses to render anything except a denial screen when that happens.
// It rides the ordinary Discord session token - no separate admin login.
"use strict";
(function () {
  const PAGE_SIZE = 20;

  const tabs = { users: null, matches: null, announcements: null };
  const lists = { users: null, matches: null, announcements: null };
  const pagers = { users: null, matches: null };
  const state = {
    auth: { status: "loading", user: null, error: null },
    users: { page: 0, q: "", total: 0, rows: [], status: "idle", error: null },
    matches: { page: 0, q: "", total: 0, rows: [], status: "idle", error: null },
    announcements: { rows: [], status: "idle", error: null },
  };

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function el(id) {
    return document.getElementById(id);
  }

  function eloDeltaText(delta) {
    return delta > 0 ? "+" + delta : String(delta);
  }

  function whenText(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString();
  }

  function reveal() {
    document.body.style.visibility = "visible";
  }

  // --- Revert modal ----------------------------------------------------------

  let revertModal = null;
  function ensureRevertModal() {
    if (revertModal) return revertModal;
    revertModal = document.createElement("div");
    revertModal.hidden = true;
    revertModal.style.cssText = "position:fixed;inset:0;z-index:1000;align-items:center;justify-content:center;padding:18px;background:rgba(23,22,29,.72)";
    revertModal.addEventListener("click", (e) => {
      if (e.target === revertModal) closeRevertModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && revertModal && !revertModal.hidden) closeRevertModal();
    });
    document.body.appendChild(revertModal);
    return revertModal;
  }

  function showRevertModal(match) {
    const modal = ensureRevertModal();
    const players = (match.players || []).map((p) => `${esc(p.name || p.id)} ${eloDeltaText(p.eloDelta)}`).join(" vs ");
    modal.innerHTML = `
      <div style="width:100%;max-width:520px;background:#fdf3d7;border:5px solid #17161d;box-shadow:inset 0 0 0 4px #fff,10px 10px 0 rgba(23,22,29,.4);padding:22px">
        <h2 style="margin:0 0 4px;font:24px 'MarioUI';color:#d02a1e;letter-spacing:1px">REVERT MATCH?</h2>
        <p style="margin:0 0 12px;font:14px 'MarioUI';color:#8b7a4e">MATCH ID: ${esc(match.matchUid)}</p>
        <p style="margin:0 0 6px;font:16px 'MarioUI';color:#17161d">${players}</p>
        <p style="margin:0 0 12px;font:14px 'MarioUI';color:#8b7a4e">${esc(window.MvLOMaps ? window.MvLOMaps.displayName(match.stage) : match.stage)} · ${esc(whenText(match.playedAt))}</p>
        <p style="margin:0 0 6px;font:14px 'MarioUI';color:#4c4634">Reason (optional) — saved as the audit trail:</p>
        <textarea id="revert-reason" class="admin-input" rows="2" maxlength="500" placeholder="Why are you reverting this?" style="display:block;width:100%;box-sizing:border-box;resize:vertical"></textarea>
        <div id="revert-error" style="margin:10px 0 0;font:14px 'MarioUI';color:#d02a1e" hidden></div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:16px">
          <button class="pager-btn admin-revert-danger" id="revert-confirm" type="button">CONFIRM REVERT</button>
          <button class="pager-btn" data-close type="button">CANCEL</button>
        </div>
      </div>`;
    modal.hidden = false;
    modal.style.display = "flex";

    modal.querySelector(".pager-btn[data-close]").addEventListener("click", closeRevertModal);
    modal.querySelector("#revert-confirm").addEventListener("click", () => doRevert(match, modal));
  }

  function closeRevertModal() {
    if (!revertModal) return;
    revertModal.hidden = true;
    revertModal.style.display = "none";
  }

  async function doRevert(match, modal) {
    const reason = modal.querySelector("#revert-reason").value.trim() || null;
    const button = modal.querySelector("#revert-confirm");
    const errorBox = modal.querySelector("#revert-error");
    button.disabled = true;
    errorBox.hidden = true;
    try {
      await MvLOAuth.api("/api/admin/matches/" + encodeURIComponent(match.matchUid) + "/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      closeRevertModal();
      await loadMatches();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      button.disabled = false;
    }
  }

  // --- Announcements modal ---------------------------------------------------

  let annModal = null;
  function ensureAnnouncementModal() {
    if (annModal) return annModal;
    annModal = document.createElement("div");
    annModal.hidden = true;
    annModal.style.cssText = "position:fixed;inset:0;z-index:1000;align-items:center;justify-content:center;padding:18px;background:rgba(23,22,29,.72)";
    annModal.addEventListener("click", (e) => {
      if (e.target === annModal) closeAnnouncementModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && annModal && !annModal.hidden) closeAnnouncementModal();
    });
    document.body.appendChild(annModal);
    return annModal;
  }

  function closeAnnouncementModal() {
    if (!annModal) return;
    annModal.hidden = true;
    annModal.style.display = "none";
  }

  function showAnnouncementModal(ann) {
    const modal = ensureAnnouncementModal();
    const isEdit = Boolean(ann && ann.id);
    const title = isEdit ? ann.title : "";
    const author = isEdit ? ann.author : (state.auth.user ? state.auth.user.displayName || state.auth.user.username : "");
    const content = isEdit ? ann.content : "";

    modal.innerHTML = `
      <div style="width:100%;max-width:680px;max-height:90vh;overflow-y:auto;background:#fdf3d7;border:5px solid #17161d;box-shadow:inset 0 0 0 4px #fff,10px 10px 0 rgba(23,22,29,.4);padding:22px">
        <h2 style="margin:0 0 12px;font:26px 'MarioUI';color:#17161d;letter-spacing:1px">${isEdit ? "EDIT ANNOUNCEMENT #" + ann.id : "NEW ANNOUNCEMENT"}</h2>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="display:block;font:14px 'MarioUI';color:#4c4634;margin-bottom:4px">Title</label>
            <input id="ann-input-title" class="admin-input" style="width:100%;box-sizing:border-box" value="${esc(title)}" placeholder="Announcement Title" maxlength="200">
          </div>
          <div>
            <label style="display:block;font:14px 'MarioUI';color:#4c4634;margin-bottom:4px">Author</label>
            <input id="ann-input-author" class="admin-input" style="width:100%;box-sizing:border-box" value="${esc(author)}" placeholder="Author Name" maxlength="100">
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <label style="font:14px 'MarioUI';color:#4c4634">Content (Markdown / Unity Rich Text)</label>
              <div style="display:flex;gap:6px">
                <button type="button" class="pager-btn" id="tab-ann-write" style="padding:3px 8px;font-size:12px">WRITE</button>
                <button type="button" class="pager-btn" id="tab-ann-preview" style="padding:3px 8px;font-size:12px">PREVIEW</button>
              </div>
            </div>
            <textarea id="ann-input-content" class="admin-input" rows="8" style="width:100%;box-sizing:border-box;resize:vertical;font-family:inherit" placeholder="Write markdown announcement here...">${esc(content)}</textarea>
            <div id="ann-preview-box" style="display:none;min-height:160px;padding:12px;background:#fff;border:4px solid #17161d;box-shadow:inset 0 0 0 2px #fdf3d7;max-height:260px;overflow-y:auto"></div>
          </div>
          <div id="ann-error" style="font:14px 'MarioUI';color:#d02a1e" hidden></div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
            <button class="pager-btn" id="ann-submit" style="background:#3fbb35;color:#fff" type="button">${isEdit ? "SAVE CHANGES" : "PUBLISH ANNOUNCEMENT"}</button>
            <button class="pager-btn" data-close type="button">CANCEL</button>
          </div>
        </div>
      </div>`;

    modal.hidden = false;
    modal.style.display = "flex";

    const textarea = modal.querySelector("#ann-input-content");
    const previewBox = modal.querySelector("#ann-preview-box");
    const tabWrite = modal.querySelector("#tab-ann-write");
    const tabPreview = modal.querySelector("#tab-ann-preview");
    const errBox = modal.querySelector("#ann-error");
    const submitBtn = modal.querySelector("#ann-submit");

    tabWrite.style.filter = "brightness(1.15)";
    tabWrite.addEventListener("click", () => {
      tabWrite.style.filter = "brightness(1.15)";
      tabPreview.style.filter = "";
      textarea.style.display = "block";
      previewBox.style.display = "none";
    });

    tabPreview.addEventListener("click", () => {
      tabPreview.style.filter = "brightness(1.15)";
      tabWrite.style.filter = "";
      textarea.style.display = "none";
      previewBox.style.display = "block";
      const raw = textarea.value.trim();
      previewBox.innerHTML = raw
        ? (window.MvLOMarkdown ? window.MvLOMarkdown.render(raw) : esc(raw))
        : `<p style="color:#8b7a4e;font-style:italic">Nothing to preview.</p>`;
    });

    modal.querySelector(".pager-btn[data-close]").addEventListener("click", closeAnnouncementModal);

    submitBtn.addEventListener("click", async () => {
      const newTitle = modal.querySelector("#ann-input-title").value.trim();
      const newAuthor = modal.querySelector("#ann-input-author").value.trim();
      const newContent = textarea.value.trim();

      if (!newTitle) {
        errBox.textContent = "Title is required.";
        errBox.hidden = false;
        return;
      }
      if (!newContent) {
        errBox.textContent = "Content is required.";
        errBox.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      errBox.hidden = true;

      try {
        if (isEdit) {
          await MvLOAuth.api("/api/admin/announcements/" + ann.id, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: newTitle, author: newAuthor, content: newContent }),
          });
        } else {
          await MvLOAuth.api("/api/admin/announcements", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: newTitle, author: newAuthor, content: newContent }),
          });
        }
        closeAnnouncementModal();
        await loadAnnouncements();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  let delAnnModal = null;
  function ensureDeleteAnnouncementModal() {
    if (delAnnModal) return delAnnModal;
    delAnnModal = document.createElement("div");
    delAnnModal.hidden = true;
    delAnnModal.style.cssText = "position:fixed;inset:0;z-index:1000;align-items:center;justify-content:center;padding:18px;background:rgba(23,22,29,.72)";
    delAnnModal.addEventListener("click", (e) => {
      if (e.target === delAnnModal) closeDeleteAnnouncementModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && delAnnModal && !delAnnModal.hidden) closeDeleteAnnouncementModal();
    });
    document.body.appendChild(delAnnModal);
    return delAnnModal;
  }

  function closeDeleteAnnouncementModal() {
    if (!delAnnModal) return;
    delAnnModal.hidden = true;
    delAnnModal.style.display = "none";
  }

  function showDeleteAnnouncementModal(ann) {
    const modal = ensureDeleteAnnouncementModal();
    modal.innerHTML = `
      <div style="width:100%;max-width:500px;background:#fdf3d7;border:5px solid #17161d;box-shadow:inset 0 0 0 4px #fff,10px 10px 0 rgba(23,22,29,.4);padding:22px">
        <h2 style="margin:0 0 8px;font:24px 'MarioUI';color:#d02a1e;letter-spacing:1px">DELETE ANNOUNCEMENT?</h2>
        <p style="margin:0 0 8px;font:16px 'MarioUI';color:#17161d">#${ann.id} — ${esc(ann.title)}</p>
        <p style="margin:0 0 16px;font:14px 'MarioUI';color:#8b7a4e">By ${esc(ann.author)} · ${esc(whenText(ann.created_at))}</p>
        <p style="margin:0 0 16px;font:14px 'MarioUI';color:#4c4634">Are you sure you want to delete this announcement? This action cannot be undone.</p>
        <div id="del-ann-error" style="margin-bottom:12px;font:14px 'MarioUI';color:#d02a1e" hidden></div>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          <button class="pager-btn admin-revert-danger" id="del-ann-confirm" type="button">DELETE</button>
          <button class="pager-btn" data-close type="button">CANCEL</button>
        </div>
      </div>`;

    modal.hidden = false;
    modal.style.display = "flex";

    modal.querySelector(".pager-btn[data-close]").addEventListener("click", closeDeleteAnnouncementModal);
    const confirmBtn = modal.querySelector("#del-ann-confirm");
    const errBox = modal.querySelector("#del-ann-error");

    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      errBox.hidden = true;
      try {
        await MvLOAuth.api("/api/admin/announcements/" + ann.id, { method: "DELETE" });
        closeDeleteAnnouncementModal();
        await loadAnnouncements();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        confirmBtn.disabled = false;
      }
    });
  }

  // --- Ban modal -------------------------------------------------------------

  let banModal = null;
  function ensureBanModal() {
    if (banModal) return banModal;
    banModal = document.createElement("div");
    banModal.hidden = true;
    banModal.style.cssText = "position:fixed;inset:0;z-index:1000;align-items:center;justify-content:center;padding:18px;background:rgba(23,22,29,.72)";
    banModal.addEventListener("click", (e) => {
      if (e.target === banModal) closeBanModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && banModal && !banModal.hidden) closeBanModal();
    });
    document.body.appendChild(banModal);
    return banModal;
  }

  function closeBanModal() {
    if (!banModal) return;
    banModal.hidden = true;
    banModal.style.display = "none";
  }

  function showBanModal(user) {
    const modal = ensureBanModal();
    modal.innerHTML = `
      <div style="width:100%;max-width:520px;background:#fdf3d7;border:5px solid #17161d;box-shadow:inset 0 0 0 4px #fff,10px 10px 0 rgba(23,22,29,.4);padding:22px">
        <h2 style="margin:0 0 4px;font:24px 'MarioUI';color:#d02a1e;letter-spacing:1px">BAN USER</h2>
        <p style="margin:0 0 6px;font:18px 'MarioUI';color:#17161d">${esc(user.display_name)} (@${esc(user.username)})</p>
        <p style="margin:0 0 14px;font:13px 'MarioUI';color:#8b7a4e">DISCORD ID: ${esc(user.discord_id)}</p>

        <div style="margin-bottom:12px">
          <label style="display:block;font:14px 'MarioUI';color:#4c4634;margin-bottom:4px">Duration (Hours)</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
            <button type="button" class="pager-btn ban-preset" data-hours="1" style="padding:4px 8px;font-size:12px">1 hour</button>
            <button type="button" class="pager-btn ban-preset" data-hours="12" style="padding:4px 8px;font-size:12px">12 hours</button>
            <button type="button" class="pager-btn ban-preset" data-hours="24" style="padding:4px 8px;font-size:12px">24h (1d)</button>
            <button type="button" class="pager-btn ban-preset" data-hours="72" style="padding:4px 8px;font-size:12px">3 days</button>
            <button type="button" class="pager-btn ban-preset" data-hours="168" style="padding:4px 8px;font-size:12px">1 week</button>
            <button type="button" class="pager-btn ban-preset" data-hours="720" style="padding:4px 8px;font-size:12px">30 days</button>
          </div>
          <input id="ban-hours" class="admin-input" type="number" min="1" max="87600" value="24" style="width:100%;box-sizing:border-box">
        </div>

        <div style="margin-bottom:14px">
          <label style="display:block;font:14px 'MarioUI';color:#4c4634;margin-bottom:4px">Reason (shown to user)</label>
          <textarea id="ban-reason" class="admin-input" rows="2" maxlength="500" placeholder="Reason for ban" style="display:block;width:100%;box-sizing:border-box;resize:vertical"></textarea>
        </div>

        <div id="ban-error" style="margin:10px 0;font:14px 'MarioUI';color:#d02a1e" hidden></div>

        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:16px">
          <button class="pager-btn admin-revert-danger" id="ban-confirm" type="button">CONFIRM BAN</button>
          <button class="pager-btn" data-close type="button">CANCEL</button>
        </div>
      </div>`;

    modal.hidden = false;
    modal.style.display = "flex";

    const hoursInput = modal.querySelector("#ban-hours");
    modal.querySelectorAll(".ban-preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        hoursInput.value = btn.dataset.hours;
      });
    });

    modal.querySelector(".pager-btn[data-close]").addEventListener("click", closeBanModal);

    const confirmBtn = modal.querySelector("#ban-confirm");
    const errorBox = modal.querySelector("#ban-error");
    confirmBtn.addEventListener("click", async () => {
      const hours = parseInt(hoursInput.value, 10);
      const reason = modal.querySelector("#ban-reason").value.trim();

      if (!Number.isFinite(hours) || hours <= 0) {
        errorBox.textContent = "Please enter a valid number of hours.";
        errorBox.hidden = false;
        return;
      }

      confirmBtn.disabled = true;
      errorBox.hidden = true;

      try {
        await MvLOAuth.api("/api/admin/users/" + encodeURIComponent(user.discord_id) + "/ban", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hours, reason }),
        });
        closeBanModal();
        await loadUsers();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        confirmBtn.disabled = false;
      }
    });
  }

  // --- Unban modal -----------------------------------------------------------

  let unbanModal = null;
  function ensureUnbanModal() {
    if (unbanModal) return unbanModal;
    unbanModal = document.createElement("div");
    unbanModal.hidden = true;
    unbanModal.style.cssText = "position:fixed;inset:0;z-index:1000;align-items:center;justify-content:center;padding:18px;background:rgba(23,22,29,.72)";
    unbanModal.addEventListener("click", (e) => {
      if (e.target === unbanModal) closeUnbanModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && unbanModal && !unbanModal.hidden) closeUnbanModal();
    });
    document.body.appendChild(unbanModal);
    return unbanModal;
  }

  function closeUnbanModal() {
    if (!unbanModal) return;
    unbanModal.hidden = true;
    unbanModal.style.display = "none";
  }

  function showUnbanModal(user) {
    const modal = ensureUnbanModal();
    modal.innerHTML = `
      <div style="width:100%;max-width:500px;background:#fdf3d7;border:5px solid #17161d;box-shadow:inset 0 0 0 4px #fff,10px 10px 0 rgba(23,22,29,.4);padding:22px">
        <h2 style="margin:0 0 8px;font:24px 'MarioUI';color:#3a7bd8;letter-spacing:1px">UNBAN USER?</h2>
        <p style="margin:0 0 8px;font:18px 'MarioUI';color:#17161d">${esc(user.display_name)} (@${esc(user.username)})</p>
        <p style="margin:0 0 12px;font:14px 'MarioUI';color:#8b7a4e">DISCORD ID: ${esc(user.discord_id)}</p>
        ${user.ban_reason ? `<p style="margin:0 0 12px;font:14px 'MarioUI';color:#d02a1e">Reason: ${esc(user.ban_reason)}</p>` : ""}
        <p style="margin:0 0 16px;font:14px 'MarioUI';color:#4c4634">Are you sure you want to lift the ban on this user? They will be allowed to queue again and will reappear on the leaderboard.</p>
        <div id="unban-error" style="margin-bottom:12px;font:14px 'MarioUI';color:#d02a1e" hidden></div>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          <button class="pager-btn" id="unban-confirm" style="background:#3fbb35;color:#fff" type="button">CONFIRM UNBAN</button>
          <button class="pager-btn" data-close type="button">CANCEL</button>
        </div>
      </div>`;

    modal.hidden = false;
    modal.style.display = "flex";

    modal.querySelector(".pager-btn[data-close]").addEventListener("click", closeUnbanModal);
    const confirmBtn = modal.querySelector("#unban-confirm");
    const errBox = modal.querySelector("#unban-error");

    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      errBox.hidden = true;
      try {
        await MvLOAuth.api("/api/admin/users/" + encodeURIComponent(user.discord_id) + "/unban", {
          method: "POST",
        });
        closeUnbanModal();
        await loadUsers();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        confirmBtn.disabled = false;
      }
    });
  }

  // --- Rows -----------------------------------------------------------------

  function userRow(u) {
    const isBanned = u.banned_until && new Date(u.banned_until).getTime() > Date.now();
    let banBadge = "";
    let banActionBtn = "";
    if (isBanned) {
      const hoursLeft = Math.ceil((new Date(u.banned_until).getTime() - Date.now()) / (1000 * 60 * 60));
      banBadge = `<div style="margin-top:4px"><span style="font:12px 'MarioUI';color:#fff;background:#d02a1e;border:2px solid #17161d;padding:2px 6px">BANNED (${hoursLeft}h left)${u.ban_reason ? ": " + esc(u.ban_reason) : ""}</span></div>`;
      banActionBtn = `<button class="pager-btn admin-user-unban" type="button" style="padding:4px 10px;font-size:13px">UNBAN</button>`;
    } else {
      banActionBtn = `<button class="pager-btn admin-revert-danger admin-user-ban" type="button" style="padding:4px 10px;font-size:13px">BAN</button>`;
    }

    return `
      <div class="admin-row" data-user-id="${esc(u.discord_id)}" style="display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:10px 14px;border:4px solid #17161d;background:#fff;box-shadow:5px 5px 0 rgba(23,22,29,.22)">
        <img src="${esc(u.avatar_url)}" alt="" width="40" height="40" style="flex:none;border:3px solid #17161d;background:#fff">
        <div style="flex:1 1 200px;min-width:0">
          <div style="font:18px 'MarioUI';color:#17161d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(u.display_name)}</div>
          <div style="font:13px 'MarioUI';color:#8b7a4e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">@${esc(u.username)} · ${esc(u.discord_id)}</div>
          ${banBadge}
        </div>
        <div style="text-align:right">
          <div style="font:24px 'MarioUI';color:#3a7bd8">${esc(Math.round(u.elo))} ELO</div>
          <div style="font:13px 'MarioUI';color:#8b7a4e">${u.matches_played} matches</div>
        </div>
        <div style="font:13px 'MarioUI';color:#8b7a4e;min-width:140px;text-align:right">
          Last match: ${esc(whenText(u.last_match_at))}<br>
          Joined: ${esc(new Date(u.created_at).toLocaleDateString())}
        </div>
        <div style="min-width:90px;text-align:right">
          ${banActionBtn}
        </div>
      </div>`;
  }

  function matchRow(m) {
    const players = (m.players || []).map((p) => {
      const deltaClass = p.eloDelta > 0 ? "color:#2f8f28" : "color:#d02a1e";
      return `<div style="font:15px 'MarioUI';color:#17161d">
        ${esc(p.name || p.id)} <span style="${deltaClass};font-weight:700">${eloDeltaText(p.eloDelta)}</span>
      </div>`;
    }).join("");

    const reverted = m.revertedAt
      ? `<span style="font:13px 'MarioUI';color:#fff;background:#d02a1e;border:3px solid #17161d;padding:3px 8px">REVERTED${m.revertReason ? ": " + esc(m.revertReason) : ""}</span>`
      : `<button class="pager-btn admin-revert-danger" type="button">REVERT</button>`;

    const stageName = window.MvLOMaps ? window.MvLOMaps.displayName(m.stage) : m.stage;
    return `
      <div class="admin-row" data-match-uid="${esc(m.matchUid)}" style="display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:10px 14px;border:4px solid #17161d;background:#fff;box-shadow:5px 5px 0 rgba(23,22,29,.22)">
        <div style="flex:1 1 260px;min-width:0">
          <div style="font:12px 'MarioUI';color:#a08f63">${esc(m.matchUid)}</div>
          <div style="display:flex;flex-direction:column;gap:2px;margin-top:4px">${players}</div>
        </div>
        <div style="font:14px 'MarioUI';color:#4c4634;min-width:110px">${esc(stageName)}</div>
        <div style="font:13px 'MarioUI';color:#8b7a4e;min-width:150px;text-align:right">${esc(whenText(m.playedAt))}</div>
        <div style="min-width:110px;text-align:right">${reverted}</div>
      </div>`;
  }

  function pager(name, section) {
    const total = section.total;
    const page = section.page;
    const pages = Math.ceil(total / PAGE_SIZE);
    const rangeFrom = total ? page * PAGE_SIZE + 1 : 0;
    const rangeTo = Math.min(total, (page + 1) * PAGE_SIZE);
    const nav = total
      ? `${rangeFrom}–${rangeTo} of ${total}${pages > 1 ? ` · page ${page + 1}/${pages}` : ""}`
      : "Nothing found";
    pagers[name].innerHTML = `
      <span style="font:14px 'MarioUI';color:#8b7a4e">${esc(nav)}</span>
      <button class="pager-btn" data-page="${page - 1}" ${page === 0 ? "disabled" : ""}>◄</button>
      <button class="pager-btn" data-page="${page + 1}" ${page + 1 >= pages || !total ? "disabled" : ""}>►</button>`;
    pagers[name].querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        section.page = Number(btn.dataset.page);
        if (name === "users") loadUsers();
        else loadMatches();
      });
    });
  }

  async function loadUsers() {
    const s = state.users;
    s.status = "loading";
    lists.users.innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">LOADING USERS…</p>`;
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(s.page * PAGE_SIZE) });
      if (s.q) params.set("q", s.q);
      const data = await MvLOAuth.api("/api/admin/users?" + params.toString());
      s.total = data.total;
      s.rows = data.users;
      s.status = "ready";
    } catch (err) {
      s.status = "error";
      s.error = err.message;
    }
    await renderUsers();
  }

  async function loadMatches() {
    const s = state.matches;
    s.status = "loading";
    lists.matches.innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">LOADING MATCHES…</p>`;
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(s.page * PAGE_SIZE) });
      if (s.q) params.set("q", s.q);
      const data = await MvLOAuth.api("/api/admin/matches?" + params.toString());
      s.total = data.total;
      s.rows = data.matches;
      s.status = "ready";
    } catch (err) {
      s.status = "error";
      s.error = err.message;
    }
    await renderMatches();
  }

  async function renderUsers() {
    const s = state.users;
    if (s.status === "error") {
      lists.users.innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#d02a1e">Could not load users: ${esc(s.error)}</p>`;
      pagers.users.innerHTML = "";
      return;
    }
    lists.users.innerHTML = s.rows.length ? s.rows.map(userRow).join("") : `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">No users.</p>`;
    lists.users.querySelectorAll(".admin-user-ban").forEach((btn) => {
      const row = btn.closest(".admin-row");
      const id = row ? row.dataset.userId : null;
      const user = s.rows.find((u) => u.discord_id === id);
      if (user) btn.addEventListener("click", () => showBanModal(user));
    });
    lists.users.querySelectorAll(".admin-user-unban").forEach((btn) => {
      const row = btn.closest(".admin-row");
      const id = row ? row.dataset.userId : null;
      const user = s.rows.find((u) => u.discord_id === id);
      if (user) btn.addEventListener("click", () => showUnbanModal(user));
    });
    pager("users", s);
  }

  async function renderMatches() {
    const s = state.matches;
    if (s.status === "error") {
      lists.matches.innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#d02a1e">Could not load matches: ${esc(s.error)}</p>`;
      pagers.matches.innerHTML = "";
      return;
    }
    lists.matches.innerHTML = s.rows.length ? s.rows.map(matchRow).join("") : `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">No matches.</p>`;
    lists.matches.querySelectorAll(".admin-revert-danger").forEach((btn) => {
      const rowEl = btn.closest(".admin-row");
      const uid = rowEl ? rowEl.dataset.matchUid : null;
      const match = s.rows.find((m) => m.matchUid === String(uid));
      if (match) btn.addEventListener("click", () => showRevertModal(match));
    });
    pager("matches", s);
  }

  function announcementRow(a) {
    const previewHtml = window.MvLOMarkdown ? window.MvLOMarkdown.render(a.content) : esc(a.content);
    return `
      <div class="admin-row" data-announcement-id="${a.id}" style="display:flex;flex-direction:column;gap:10px;padding:14px;border:4px solid #17161d;background:#fff;box-shadow:5px 5px 0 rgba(23,22,29,.22)">
        <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px">
          <div>
            <span style="font:14px 'MarioUI';color:#8b7a4e">#${a.id} · </span>
            <span style="font:22px 'MarioUI';color:#17161d">${esc(a.title)}</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
            <span style="font:13px 'MarioUI';color:#8b7a4e">By ${esc(a.author)} · ${esc(whenText(a.created_at))}</span>
            <button class="pager-btn admin-ann-edit" type="button" style="padding:4px 10px;font-size:13px">EDIT</button>
            <button class="pager-btn admin-revert-danger admin-ann-del" type="button" style="padding:4px 10px;font-size:13px">DELETE</button>
          </div>
        </div>
        <div style="padding:12px;background:#fdf3d7;border:3px solid #17161d;max-height:180px;overflow-y:auto">
          ${previewHtml}
        </div>
      </div>`;
  }

  async function loadAnnouncements() {
    const s = state.announcements;
    s.status = "loading";
    lists.announcements.innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">LOADING ANNOUNCEMENTS…</p>`;
    try {
      const data = await MvLOAuth.api("/api/admin/announcements");
      s.rows = data.announcements || [];
      s.status = "ready";
    } catch (err) {
      s.status = "error";
      s.error = err.message;
    }
    await renderAnnouncements();
  }

  async function renderAnnouncements() {
    const s = state.announcements;
    if (s.status === "error") {
      lists.announcements.innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#d02a1e">Could not load announcements: ${esc(s.error)}</p>`;
      return;
    }
    lists.announcements.innerHTML = s.rows.length
      ? s.rows.map(announcementRow).join("")
      : `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">No announcements yet. Click "+ NEW ANNOUNCEMENT" to create one!</p>`;

    lists.announcements.querySelectorAll(".admin-ann-edit").forEach((btn) => {
      const row = btn.closest(".admin-row");
      const id = Number(row ? row.dataset.announcementId : null);
      const ann = s.rows.find((a) => a.id === id);
      if (ann) btn.addEventListener("click", () => showAnnouncementModal(ann));
    });

    lists.announcements.querySelectorAll(".admin-ann-del").forEach((btn) => {
      const row = btn.closest(".admin-row");
      const id = Number(row ? row.dataset.announcementId : null);
      const ann = s.rows.find((a) => a.id === id);
      if (ann) btn.addEventListener("click", () => showDeleteAnnouncementModal(ann));
    });
  }

  function switchTab(name) {
    tabs.users.classList.toggle("active", name === "users");
    tabs.matches.classList.toggle("active", name === "matches");
    tabs.announcements.classList.toggle("active", name === "announcements");
    el("panel-users").hidden = name !== "users";
    el("panel-matches").hidden = name !== "matches";
    el("panel-announcements").hidden = name !== "announcements";
    if (name === "users" && state.users.status === "idle") loadUsers();
    if (name === "matches" && state.matches.status === "idle") loadMatches();
    if (name === "announcements" && state.announcements.status === "idle") loadAnnouncements();
  }

  function showDenied(message, needsLogin) {
    el("admin-gate").hidden = false;
    el("admin-gate-text").textContent = message;
    el("admin-login").hidden = !needsLogin;
    el("admin-panel").hidden = true;
    reveal();
  }

  async function boot() {
    await MvLOAuth.ready;
    tabs.users = document.querySelector(".admin-tab[data-tab='users']");
    tabs.matches = document.querySelector(".admin-tab[data-tab='matches']");
    tabs.announcements = document.querySelector(".admin-tab[data-tab='announcements']");
    lists.users = el("admin-users");
    lists.matches = el("admin-matches");
    lists.announcements = el("admin-announcements");
    pagers.users = el("admin-users-pager");
    pagers.matches = el("admin-matches-pager");

    tabs.users.addEventListener("click", () => switchTab("users"));
    tabs.matches.addEventListener("click", () => switchTab("matches"));
    tabs.announcements.addEventListener("click", () => switchTab("announcements"));
    el("btn-new-announcement").addEventListener("click", () => showAnnouncementModal(null));
    el("users-search").addEventListener("submit", (e) => {
      e.preventDefault();
      state.users.q = el("users-search").q.value.trim();
      state.users.page = 0;
      loadUsers();
    });
    el("matches-search").addEventListener("submit", (e) => {
      e.preventDefault();
      state.matches.q = el("matches-search").q.value.trim();
      state.matches.page = 0;
      loadMatches();
    });
    el("admin-login").addEventListener("click", () => MvLOAuth.login());

    state.auth.status = MvLOAuth.isAuthenticated ? "authenticated" : "anonymous";
    state.auth.user = MvLOAuth.state.user;

    if (!state.auth.user) {
      return showDenied("Only authorized accounts may open the admin panel. Log in with Discord to try again.", true);
    }

    try {
      // A single cheap admin-only call decides whether the whole panel may
      // render - 403 means the session's owner is not on the admin list.
      await MvLOAuth.api("/api/admin/users?limit=1");
    } catch (err) {
      if (err.status === 401) return showDenied("Your session expired. Log in again to continue.", true);
      return showDenied("Only authorized accounts may open the admin panel.", false);
    }

    el("admin-gate").hidden = true;
    el("admin-panel").hidden = false;
    reveal();
    switchTab("users");
  }

  boot().catch((err) => {
    console.error("Admin panel boot failed:", err);
    showDenied(err.message || "The admin panel could not be loaded.");
  });
})();