// MvLO Ranked - Discord auth client.
//
// Flow: GET /api/login returns the Discord authorize URL -> Discord bounces the
// browser to /api/callback -> the API redirects back here with the session
// token in the URL fragment -> we stash it in localStorage and use it as a
// bearer token from then on. Every page load pings POST /api/refresh, which
// re-reads the Discord profile only once the cached copy is 10 minutes old.
"use strict";
(function () {
  const TOKEN_KEY = "mvlo.token";

  // Same-origin in dev (the API serves this folder); on Vercel point the meta
  // tag at the deployed API, e.g. <meta name="mvlo-api-base" content="https://api.example.com">
  const meta = document.querySelector('meta[name="mvlo-api-base"]');
  const API_BASE = ((meta && meta.content) || "").replace(/\/$/, "");

  const state = { status: "loading", user: null, error: null, refreshIntervalMinutes: 10 };
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null; // private mode / storage disabled
    }
  }

  function setToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing we can do; the session just will not survive a reload */
    }
  }

  async function api(path, options) {
    const opts = Object.assign({ headers: {} }, options);
    const token = getToken();
    if (token) opts.headers.Authorization = "Bearer " + token;
    const res = await fetch(API_BASE + path, opts);
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "Request failed (" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // The API hands the token back in the fragment so it never lands in a server
  // log or a Referer header. Consume it and scrub the URL.
  function consumeRedirect() {
    if (!location.hash || location.hash.length < 2) return null;
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get("token");
    const error = params.get("error");
    if (!token && !error) return null;

    if (token) setToken(token);
    params.delete("token");
    params.delete("error");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + location.search + (rest ? "#" + rest : ""));
    return error;
  }

  async function login() {
    state.error = null;
    emit();
    try {
      const { url } = await api("/api/login");
      location.href = url;
    } catch (err) {
      state.error = err.message;
      emit();
    }
  }

  async function logout() {
    try {
      await api("/api/logout", { method: "POST" });
    } catch {
      /* the token is being dropped locally either way */
    }
    setToken(null);
    state.status = "anonymous";
    state.user = null;
    emit();
  }

  async function boot() {
    const redirectError = consumeRedirect();
    if (redirectError) {
      state.error = {
        invalid_state: "Login expired before it finished. Please try again.",
        missing_code: "Discord did not return an authorization code.",
        access_denied: "You cancelled the Discord login.",
        login_failed: "Something went wrong talking to Discord. Please try again."
      }[redirectError] || "Login failed: " + redirectError;
    }

    if (!getToken()) {
      state.status = "anonymous";
      emit();
      return;
    }

    try {
      const data = await api("/api/refresh", { method: "POST" });
      state.status = "authenticated";
      state.user = data.user;
      if (data.refreshIntervalMinutes) state.refreshIntervalMinutes = data.refreshIntervalMinutes;
    } catch (err) {
      if (err.status === 401) setToken(null); // expired or revoked session
      state.status = "anonymous";
      state.user = null;
      if (err.status !== 401) state.error = err.message;
    }
    emit();
  }

  window.MvLOAuth = {
    get state() {
      return state;
    },
    get isAuthenticated() {
      return state.status === "authenticated";
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    login,
    logout,
    api,
    ready: boot()
  };
})();
