import { beginLogin, clearAuthStorage, exchangeCodeForToken, getValidAccessToken } from "./auth.js";

/**
 * Dashboard logic:
 * - Shows login screen if unauthenticated
 * - Fetches Spotify endpoints and renders sections
 * - Handles expiration by requiring re-login
 */

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

function $(id) {
  return document.getElementById(id);
}

const ui = {
  errorArea: $("errorArea"),
  loginView: $("loginView"),
  appView: $("appView"),
  connectBtn: $("connectBtn"),
  logoutBtn: $("logoutBtn"),
  refreshBtn: $("refreshBtn"),
  timeRange: $("timeRange"),
  loading: $("loading"),
  userAvatar: $("userAvatar"),
  userName: $("userName"),
  topTracks: $("topTracks"),
  topArtists: $("topArtists"),
  recentTracks: $("recentTracks"),
  minutesListened: $("minutesListened"),
  genreBreakdown: $("genreBreakdown"),
};

function showError(message) {
  ui.errorArea.textContent = message;
  ui.errorArea.hidden = false;
}

function clearError() {
  ui.errorArea.textContent = "";
  ui.errorArea.hidden = true;
}

function setLoading(isLoading) {
  ui.loading.hidden = !isLoading;
  ui.refreshBtn.disabled = isLoading;
  ui.timeRange.disabled = isLoading;
}

function setAuthenticatedView(isAuthenticated) {
  ui.loginView.hidden = isAuthenticated;
  ui.appView.hidden = !isAuthenticated;
}

/**
 * Handles Spotify redirect parameters (?code=...&state=...) directly on index.html.
 * This makes the app resilient even if a separate callback.html route is mis-deployed.
 */
async function handleOAuthRedirectIfPresent() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (!code && !state && !error) return false;

  clearError();
  setLoading(true);

  try {
    if (error) {
      throw new Error(`Spotify login error: ${error}`);
    }

    if (!code || !state) {
      throw new Error("Missing OAuth parameters. Please try connecting again.");
    }

    await exchangeCodeForToken({ code, stateFromUrl: state });
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    url.searchParams.delete("error");
    window.history.replaceState({}, document.title, url.toString());
    return true;
  } catch (e) {
    clearAuthStorage();
    setAuthenticatedView(false);
    showError(e instanceof Error ? e.message : "Login failed. Please try again.");
    return true;
  } finally {
    setLoading(false);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiFetch(path, accessToken, { method = "GET", body } = {}) {
  const url = path.startsWith("http") ? path : `${SPOTIFY_API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (body) headers["Content-Type"] = "application/json";

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const retryAfterSeconds = Number(res.headers.get("Retry-After") || "1");
      await sleep(Math.min(5, Math.max(1, retryAfterSeconds)) * 1000);
      continue;
    }

    if (res.status === 204) return null;

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");
    if (!res.ok) {
      const msgFromJson =
        payload?.error?.message || payload?.error_description || payload?.error || null;
      const msgFromText = typeof payload === "string" && payload.trim() ? payload.trim() : null;
      let msg = msgFromJson || msgFromText || `Spotify API error (${res.status}).`;

      if (res.status === 403) {
        msg =
          `${msg} ` +
          `Common fixes: (1) If your Spotify app is in Development Mode, add your Spotify account under “Users and Access”. ` +
          `(2) Re-login after changing app settings.`;
      }

      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    return payload;
  }

  throw new Error("Spotify API is rate limiting requests. Please try again.");
}

function renderRankedList(container, items, { title, subtitle }) {
  container.innerHTML = "";
  for (let i = 0; i < items.length; i++) {
    const li = document.createElement("li");

    const index = document.createElement("div");
    index.className = "list__index";
    index.textContent = String(i + 1);

    const main = document.createElement("div");
    main.className = "list__main";

    const t = document.createElement("div");
    t.className = "list__title";
    t.textContent = title(items[i]);

    const s = document.createElement("div");
    s.className = "list__subtitle";
    s.textContent = subtitle(items[i]);

    main.appendChild(t);
    main.appendChild(s);

    li.appendChild(index);
    li.appendChild(main);
    container.appendChild(li);
  }
}

function renderGenres(container, counts) {
  container.innerHTML = "";
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No genres found for your top artists.";
    container.appendChild(empty);
    return;
  }

  for (const [genre, count] of entries) {
    const chip = document.createElement("div");
    chip.className = "chip";

    const name = document.createElement("div");
    name.className = "chip__name";
    name.textContent = genre;

    const n = document.createElement("div");
    n.className = "chip__count";
    n.textContent = String(count);

    chip.appendChild(name);
    chip.appendChild(n);
    container.appendChild(chip);
  }
}

function minutesFromTracks(recentItems) {
  const totalMs = recentItems.reduce((sum, item) => sum + (item?.track?.duration_ms ?? 0), 0);
  return Math.max(0, Math.round(totalMs / 1000 / 60));
}

async function loadProfile(accessToken) {
  const me = await apiFetch("/me", accessToken);

  ui.userName.textContent = me?.display_name || "Spotify User";

  const image = me?.images?.[0]?.url;
  if (image) {
    ui.userAvatar.src = image;
    ui.userAvatar.hidden = false;
  } else {
    ui.userAvatar.removeAttribute("src");
    ui.userAvatar.hidden = true;
  }
}

async function loadTopTracks(accessToken, timeRange) {
  const data = await apiFetch(`/me/top/tracks?time_range=${encodeURIComponent(timeRange)}&limit=10`, accessToken);
  const items = data?.items ?? [];
  renderRankedList(ui.topTracks, items, {
    title: (t) => t?.name ?? "—",
    subtitle: (t) => (t?.artists ?? []).map((a) => a.name).filter(Boolean).join(", ") || "—",
  });
}

async function loadTopArtists(accessToken, timeRange) {
  const data = await apiFetch(`/me/top/artists?time_range=${encodeURIComponent(timeRange)}&limit=10`, accessToken);
  const items = data?.items ?? [];
  renderRankedList(ui.topArtists, items, {
    title: (a) => a?.name ?? "—",
    subtitle: (a) => (a?.followers?.total ? `${a.followers.total.toLocaleString()} followers` : "—"),
  });
  return items;
}

async function loadRecentlyPlayed(accessToken) {
  const data = await apiFetch("/me/player/recently-played?limit=10", accessToken);
  const items = data?.items ?? [];

  renderRankedList(ui.recentTracks, items, {
    title: (i) => i?.track?.name ?? "—",
    subtitle: (i) => (i?.track?.artists ?? []).map((a) => a.name).filter(Boolean).join(", ") || "—",
  });

  ui.minutesListened.textContent = `${minutesFromTracks(items)} min`;
}

async function loadGenresViaArtistEndpoint(accessToken, topArtists) {
  const ids = (topArtists ?? []).map((a) => a?.id).filter(Boolean);
  const uniqueIds = [...new Set(ids)].slice(0, 10);

  const artistDetails = await Promise.all(
    uniqueIds.map((id) => apiFetch(`/artists/${encodeURIComponent(id)}`, accessToken))
  );

  const counts = new Map();
  for (const a of artistDetails) {
    const genres = a?.genres ?? [];
    for (const g of genres) {
      const key = String(g).trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  renderGenres(ui.genreBreakdown, counts);
}

async function requireAuthOrShowLogin({ reason } = {}) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    setAuthenticatedView(false);
    setLoading(false);
    if (reason) showError(reason);
    return null;
  }
  setAuthenticatedView(true);
  return accessToken;
}

async function loadDashboardAll() {
  clearError();
  setLoading(true);

  const accessToken = await requireAuthOrShowLogin({
    reason: "Your session expired. Please connect Spotify again.",
  });
  if (!accessToken) return;

  try {
    await loadProfile(accessToken);

    const timeRange = ui.timeRange.value;
    const [topArtists] = await Promise.all([
      loadTopArtists(accessToken, timeRange),
      loadTopTracks(accessToken, timeRange),
      loadRecentlyPlayed(accessToken),
    ]);

    await loadGenresViaArtistEndpoint(accessToken, topArtists);
  } catch (e) {
    const status = e?.status;
    if (status === 401) {
      clearAuthStorage();
      setAuthenticatedView(false);
      showError("Session expired. Please connect Spotify again.");
      return;
    }
    showError(e instanceof Error ? e.message : "Something went wrong.");
  } finally {
    setLoading(false);
  }
}

async function refreshTimeRangeOnly() {
  clearError();
  setLoading(true);

  const accessToken = await requireAuthOrShowLogin({
    reason: "Your session expired. Please connect Spotify again.",
  });
  if (!accessToken) return;

  try {
    const timeRange = ui.timeRange.value;
    const [topArtists] = await Promise.all([
      loadTopArtists(accessToken, timeRange),
      loadTopTracks(accessToken, timeRange),
    ]);
    await loadGenresViaArtistEndpoint(accessToken, topArtists);
  } catch (e) {
    const status = e?.status;
    if (status === 401) {
      clearAuthStorage();
      setAuthenticatedView(false);
      showError("Session expired. Please connect Spotify again.");
      return;
    }
    showError(e instanceof Error ? e.message : "Something went wrong.");
  } finally {
    setLoading(false);
  }
}

function wireEvents() {
  ui.connectBtn.addEventListener("click", async () => {
    clearError();
    ui.connectBtn.disabled = true;
    try {
      await beginLogin();
    } catch (e) {
      ui.connectBtn.disabled = false;
      showError(e instanceof Error ? e.message : "Unable to start Spotify login.");
    }
  });

  ui.logoutBtn.addEventListener("click", () => {
    clearAuthStorage();
    setAuthenticatedView(false);
    showError("Logged out.");
  });

  ui.refreshBtn.addEventListener("click", () => {
    loadDashboardAll();
  });

  ui.timeRange.addEventListener("change", () => {
    refreshTimeRangeOnly();
  });
}

async function boot() {
  wireEvents();

  const handled = await handleOAuthRedirectIfPresent();
  if (handled) {
    const accessTokenAfterLogin = await getValidAccessToken();
    setAuthenticatedView(Boolean(accessTokenAfterLogin));
    if (accessTokenAfterLogin) loadDashboardAll();
    return;
  }

  const accessToken = await getValidAccessToken();
  setAuthenticatedView(Boolean(accessToken));
  if (accessToken) {
    loadDashboardAll();
  }
}

boot();
