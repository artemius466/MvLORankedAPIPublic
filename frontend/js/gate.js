// MvLO Ranked - site access gate.
//
// Blocks the page itself from being seen until GET /api/access says the
// caller is authorized (logged in + has the configured Discord role). This is
// independent of API auth - /api/online, /api/leaderboard, match history,
// etc. all stay public regardless. It only gates the frontend pages that
// load this script.
//
// Fully removable server-side with no frontend changes: set
// SITE_GATE_ENABLED=false (or blank out SITE_GATE_ROLE_ID) and /api/access
// starts reporting enabled:false, which just reveals the page below as if
// this script wasn't there. The inline `body{visibility:hidden}` style each
// gated page carries in <head> is what actually hides content up front;
// this script's only job is to flip it back on, or swap in the gate screen.
"use strict";
(function () {
  // If MvLOAuth.ready or the /api/access call never settles (offline, a bug,
  // a slow network), don't leave the site permanently blank.
  const FAIL_OPEN_MS = 6000;

  function reveal() {
    document.body.style.visibility = "visible";
  }

  // Same discordInvite the gate screen below links to (SITE_GATE_DISCORD_INVITE)
  // - also surfaced as a "JOIN DISCORD" link in the page's own header/nav
  // (id="nav-discord-invite") for everyone, gated or not. No-op on pages
  // that don't carry that element, and when no invite is configured.
  function populateDiscordNav(url) {
    if (!url) return;
    const nav = document.getElementById("nav-discord-invite");
    if (!nav) return;
    nav.href = url;
    nav.hidden = false;
  }

  function showGate(kind, discordInvite) {
    const heading = "ACCESS RESTRICTED";
    const body = document.createElement("div");
    body.id = "mvlo-gate";
    body.style.cssText =
      "min-height:100vh;display:grid;place-items:center;background:linear-gradient(#4a7bf0 0%,#5c94fc 40%,#8fc2ff 100%);padding:24px";
    body.innerHTML =
      '<div class="auth-gate" style="max-width:420px;background:#fdf3d7;border:5px solid #17161d;box-shadow:9px 9px 0 rgba(23,22,29,.32)">' +
      '<span class="auth-gate-icon"></span>' +
      '<h1 style="margin:0;font:28px \'MarioUI\';color:#17161d;letter-spacing:1px">' + heading + "</h1>" +
      "<p style=\"margin:0;font:16px/1.5 'MarioUI';color:#4c4634\">" +
      (kind === "login"
        ? "This site is limited to members of our Discord with the right role. Log in with Discord to continue."
        : "You're logged in, but your Discord account doesn't have access to this site. Join our Discord server and open a ticket there to request it.") +
      "</p>" +
      (kind === "login"
        ? '<button class="discord-btn" id="mvlo-gate-login">LOGIN WITH DISCORD</button>'
        : discordInvite
          ? '<a class="discord-btn" style="text-decoration:none;box-sizing:border-box" href="' + discordInvite + '" target="_blank" rel="noopener noreferrer">JOIN OUR DISCORD SERVER</a>'
          : "") +
      "</div>";

    document.body.innerHTML = "";
    document.body.appendChild(body);
    reveal();

    const loginBtn = document.getElementById("mvlo-gate-login");
    if (loginBtn) loginBtn.addEventListener("click", () => window.MvLOAuth.login());
  }

  async function boot() {
    if (!window.MvLOAuth) return reveal(); // gate.js included without auth.js - fail open rather than dark-screen the site
    await window.MvLOAuth.ready;
    const access = await window.MvLOAuth.api("/api/access");
    if (!access.enabled || access.authorized) {
      populateDiscordNav(access.discordInvite);
      return reveal();
    }
    showGate(access.loggedIn ? "denied" : "login", access.discordInvite);
  }

  const failOpenTimer = setTimeout(() => {
    console.warn("Site gate check timed out - showing the site.");
    reveal();
  }, FAIL_OPEN_MS);

  boot()
    .catch((err) => {
      console.error("Site gate check failed:", err);
      reveal();
    })
    .finally(() => clearTimeout(failOpenTimer));
})();
