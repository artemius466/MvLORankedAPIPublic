// MvLO Ranked — public player profile page. The id comes from the URL path
// (/user/:id, matched by src/app.js) and everything on this page is read from
// unauthenticated API endpoints, so no login is required to look someone up.
"use strict";
(function () {
  const T = window.MvLOTiers;
  const L = window.MvLOLadderView;
  // The accent this page's ELO chip and ladder pin use.
  const ELO_COLOR = "#3a7bd8";

  const meta = document.querySelector('meta[name="mvlo-api-base"]');
  const API_BASE = ((meta && meta.content) || "").replace(/\/$/, "");

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function api(path) {
    const res = await fetch(API_BASE + path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "Request failed (" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function userIdFromUrl() {
    const m = location.pathname.match(/\/user\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  const SITE_ORIGIN = "https://mvloranked.xyz";

  const el = {};
  ["profile-card", "profile-loading", "tier-scale", "history-summary", "history-list", "auth-error", "profile-h1", "breadcrumb-current"]
    .forEach((id) => (el[id] = document.getElementById(id)));

  function renderError(message) {
    el["auth-error"].hidden = !message;
    if (message) el["auth-error"].textContent = message;
  }

  // This static file is served for every /user/:id, so the id-specific bits
  // (canonical URL, description, breadcrumb, structured data) only exist once
  // JS reads the id out of the URL / fetches the profile - see setProfileSeo()
  // and its call sites below.
  function setMetaDescription(content) {
    let tag = document.querySelector('meta[name="description"]');
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", "description");
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", content);
  }

  function setCanonical(href) {
    let tag = document.querySelector('link[rel="canonical"]');
    if (!tag) {
      tag = document.createElement("link");
      tag.setAttribute("rel", "canonical");
      document.head.appendChild(tag);
    }
    tag.setAttribute("href", href);
  }

  // og:* tags use the `property` attribute rather than `name`, so they need
  // their own lookup/creation - same reasoning as setMetaDescription() above.
  function setMetaProperty(property, content) {
    let tag = document.querySelector(`meta[property="${property}"]`);
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("property", property);
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", content);
  }

  function setMetaName(name, content) {
    let tag = document.querySelector(`meta[name="${name}"]`);
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", name);
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", content);
  }

  function setRobotsNoindex() {
    let tag = document.querySelector('meta[name="robots"]');
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", "robots");
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", "noindex,follow");
  }

  function setJsonLd(id, data) {
    let tag = document.getElementById(id);
    if (!tag) {
      tag = document.createElement("script");
      tag.type = "application/ld+json";
      tag.id = id;
      document.head.appendChild(tag);
    }
    tag.textContent = JSON.stringify(data);
  }

  // Canonical URL and breadcrumb only need the id from the URL, so they're set
  // as soon as it's known rather than waiting on the profile fetch below.
  function setProfileUrl(id) {
    const url = SITE_ORIGIN + "/user/" + encodeURIComponent(id);
    setCanonical(url);
    setMetaProperty("og:url", url);
    setJsonLd("ld-breadcrumb", {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_ORIGIN + "/" },
        { "@type": "ListItem", position: 2, name: "Player Profile", item: url },
      ],
    });
    return url;
  }

  // Name-specific SEO bits, filled in once the profile itself has loaded.
  function setProfileSeo(user, url) {
    const title = user.displayName + " — MvLO Ranked";
    const description = `${user.displayName}'s rank, ELO rating (${user.elo}) and match history on the MvLO Ranked ladder.`;
    document.title = title;
    el["profile-h1"].textContent = user.displayName;
    el["breadcrumb-current"].textContent = user.displayName.toUpperCase();
    setMetaDescription(description);
    setMetaProperty("og:title", title);
    setMetaProperty("og:description", description);
    setMetaName("twitter:title", title);
    setMetaName("twitter:description", description);
    setJsonLd("ld-breadcrumb", {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_ORIGIN + "/" },
        { "@type": "ListItem", position: 2, name: user.displayName, item: url },
      ],
    });
    setJsonLd("ld-profile", {
      "@context": "https://schema.org",
      "@type": "ProfilePage",
      url,
      mainEntity: { "@type": "Person", name: user.displayName, url },
    });
  }

  // The player's tier chip, label and colored rating.
  function trackRow(user) {
    const elo = user.elo;
    const t = T.tierFor(elo);
    return `
      <div style="display:flex;align-items:center;gap:8px;font:17px 'MarioUI';color:#4c4634;margin-top:6px">
        ${L.chipSpan(t.name, 24)}${esc(t.label)} · <span style="color:${ELO_COLOR}">${esc(elo)}</span> ELO
      </div>`;
  }

  function renderProfile(user, url) {
    el["profile-loading"].hidden = true;
    el["profile-card"].hidden = false;
    el["profile-card"].innerHTML = `
      <div style="flex:none;position:relative;width:84px;height:84px">
        <img src="${esc(user.avatarUrl)}" alt="" width="84" height="84" style="display:block;border:4px solid #17161d;background:#fff">
        ${user.online ? `<span title="Online" style="position:absolute;right:-4px;bottom:-4px;width:20px;height:20px;border-radius:50%;background:#3fbb35;border:4px solid #fdf3d7"></span>` : ""}
      </div>
      <div style="flex:1 1 220px;min-width:0">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="font:30px 'MarioUI';color:#17161d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${user.country ? `<span title="${esc(window.MvLOCountries.nameFor(user.country))}">${window.MvLOCountries.flagEmoji(user.country)}</span> ` : ""}${esc(user.displayName)}</div>
          ${user.online ? `<span style="flex:none;display:inline-flex;align-items:center;gap:5px;border:3px solid #17161d;background:#cdf2c6;padding:2px 8px;font:12px 'MarioUI';color:#17161d">
              <span style="width:8px;height:8px;border-radius:50%;background:#3fbb35"></span>ONLINE
            </span>` : ""}
          ${user.ban ? `<span style="flex:none;display:inline-flex;align-items:center;gap:5px;border:3px solid #17161d;background:#d02a1e;color:#fff;padding:2px 8px;font:12px 'MarioUI'">
              BANNED (${user.ban.hoursLeft}h left)
            </span>` : ""}
        </div>
        <div style="font:16px 'MarioUI';color:#a08f63;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">@${esc(user.username)}</div>
        ${user.bio ? `<p style="margin:8px 0 0;font:15px/1.5 'MarioUI';color:#4c4634;text-wrap:pretty">${esc(user.bio)}</p>` : ""}
        ${trackRow(user)}
      </div>`;
    setProfileSeo(user, url);
  }

  function renderHistory(matches) {
    if (!matches.length) {
      el["history-summary"].textContent = "LAST 0 · NET +0";
      el["history-list"].innerHTML = `<p style="margin:0;font:16px 'MarioUI';color:#8b7a4e">No ranked matches played yet.</p>`;
      return;
    }

    const net = matches.reduce((sum, m) => sum + m.eloDelta, 0);
    el["history-summary"].textContent = `LAST ${matches.length} · NET ${net >= 0 ? "+" + net : net}`;
    el["history-list"].innerHTML = matches
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

  document.addEventListener("click", (e) => {
    const row = e.target.closest("[data-match-uid]");
    if (row && !e.target.closest("a")) window.MvLOMatchDetail.open(row.dataset.matchUid);
  });

  async function load() {
    const id = userIdFromUrl();
    if (!id) {
      el["profile-loading"].hidden = true;
      renderError("No player id in the URL.");
      setRobotsNoindex();
      return;
    }

    const url = setProfileUrl(id);

    try {
      const [{ user }, { matches }] = await Promise.all([
        api("/api/users/" + encodeURIComponent(id)),
        api("/api/users/" + encodeURIComponent(id) + "/matches?limit=10"),
      ]);

      renderProfile(user, url);
      L.renderScale("tier-scale");
      L.renderPin("elo", user.elo, user.displayName.toUpperCase(), ELO_COLOR, 0);
      renderHistory(matches);
    } catch (err) {
      el["profile-loading"].hidden = true;
      // A dead or malformed id renders this same template with an error
      // message instead of a real 404 status (the server always returns 200
      // for /user/:id) - keep it out of the index so that soft 404 doesn't
      // get treated as real content.
      setRobotsNoindex();
      if (err.status === 404) {
        el["profile-h1"].textContent = "PLAYER NOT FOUND";
        el["breadcrumb-current"].textContent = "PLAYER NOT FOUND";
        document.title = "Player Not Found — MvLO Ranked";
      }
      renderError(err.status === 404 ? "No player with this id." : "Could not load this profile: " + err.message);
    }
  }

  load();
})();
