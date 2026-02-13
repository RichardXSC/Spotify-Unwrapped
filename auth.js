/**
 * Spotify OAuth (Authorization Code Flow + PKCE) for a fully static web app.
 *
 * Notes:
 * - No client secret is used anywhere.
 * - Tokens are stored in localStorage so the app can reload without re-login.
 * - When expired, the app re-auths (or attempts refresh token flow if available).
 */

export const CLIENT_ID = "a8e6a5e75f584d9a906c541ad968af34";

export const REDIRECT_URI = "https://spotify-unwrapped.vercel.app/callback.html";

const SPOTIFY_AUTH_BASE = "https://accounts.spotify.com";

const STORAGE_KEYS = {
  token: "spotify_unwrapped.token",
  pkceVerifier: "spotify_unwrapped.pkce_verifier",
  oauthState: "spotify_unwrapped.oauth_state",
};

const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-top-read",
  "user-read-recently-played",
];

/**
 * Returns a cryptographically strong random string.
 */
function randomString(length) {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const random = new Uint8Array(length);
  crypto.getRandomValues(random);
  let out = "";
  for (const n of random) out += charset[n % charset.length];
  return out;
}

/**
 * Base64 URL-encodes bytes (no padding).
 */
function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * SHA-256 hashes a string into bytes.
 */
async function sha256Bytes(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

/**
 * Creates a PKCE code challenge from a verifier.
 */
async function pkceChallengeFromVerifier(verifier) {
  const hashed = await sha256Bytes(verifier);
  return base64UrlEncode(hashed);
}

/**
 * Starts the OAuth Authorization Code Flow with PKCE.
 */
export async function beginLogin() {
  if (CLIENT_ID === "CLIENT_ID") {
    throw new Error("Set CLIENT_ID in auth.js before using the app.");
  }

  const verifier = randomString(64);
  const challenge = await pkceChallengeFromVerifier(verifier);
  const state = randomString(24);

  localStorage.setItem(STORAGE_KEYS.pkceVerifier, verifier);
  localStorage.setItem(STORAGE_KEYS.oauthState, state);

  const url = new URL(`${SPOTIFY_AUTH_BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);

  window.location.assign(url.toString());
}

/**
 * Reads the token object from localStorage.
 */
export function readStoredToken() {
  const raw = localStorage.getItem(STORAGE_KEYS.token);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Writes the token object to localStorage.
 */
export function writeStoredToken(token) {
  localStorage.setItem(STORAGE_KEYS.token, JSON.stringify(token));
}

/**
 * Removes all auth-related storage.
 */
export function clearAuthStorage() {
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.pkceVerifier);
  localStorage.removeItem(STORAGE_KEYS.oauthState);
}

/**
 * Returns true if a token exists and is not expired (with a small safety buffer).
 */
export function isTokenValid(token) {
  if (!token?.access_token || !token?.expires_at) return false;
  const bufferMs = 60_000;
  return Date.now() + bufferMs < token.expires_at;
}

/**
 * Exchanges an authorization code for tokens.
 * Called from callback.js.
 */
export async function exchangeCodeForToken({ code, stateFromUrl }) {
  const expectedState = localStorage.getItem(STORAGE_KEYS.oauthState);
  if (!expectedState || stateFromUrl !== expectedState) {
    throw new Error("OAuth state mismatch. Please try connecting again.");
  }

  const verifier = localStorage.getItem(STORAGE_KEYS.pkceVerifier);
  if (!verifier) {
    throw new Error("Missing PKCE verifier. Please try connecting again.");
  }

  const body = new URLSearchParams();
  body.set("client_id", CLIENT_ID);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", REDIRECT_URI);
  body.set("code_verifier", verifier);

  const res = await fetch(`${SPOTIFY_AUTH_BASE}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error_description || json?.error || "Token exchange failed.";
    throw new Error(msg);
  }

  const expiresAt = Date.now() + (json.expires_in ?? 0) * 1000;
  const token = {
    access_token: json.access_token,
    token_type: json.token_type,
    scope: json.scope,
    expires_at: expiresAt,
    refresh_token: json.refresh_token,
  };

  writeStoredToken(token);

  localStorage.removeItem(STORAGE_KEYS.pkceVerifier);
  localStorage.removeItem(STORAGE_KEYS.oauthState);

  return token;
}

/**
 * Attempts to refresh the access token using a stored refresh token.
 * Spotify may not always return a refresh token (or only on first consent).
 */
export async function refreshAccessTokenIfPossible() {
  const existing = readStoredToken();
  if (!existing?.refresh_token) return null;
  if (CLIENT_ID === "CLIENT_ID") return null;

  const body = new URLSearchParams();
  body.set("client_id", CLIENT_ID);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", existing.refresh_token);

  const res = await fetch(`${SPOTIFY_AUTH_BASE}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) return null;

  const refreshed = {
    ...existing,
    access_token: json.access_token,
    token_type: json.token_type ?? existing.token_type,
    scope: json.scope ?? existing.scope,
    expires_at: Date.now() + (json.expires_in ?? 0) * 1000,
    refresh_token: json.refresh_token ?? existing.refresh_token,
  };

  writeStoredToken(refreshed);
  return refreshed;
}

/**
 * Ensures the caller gets a valid access token, or null if login is required.
 */
export async function getValidAccessToken() {
  const token = readStoredToken();
  if (isTokenValid(token)) return token.access_token;

  const refreshed = await refreshAccessTokenIfPossible();
  if (isTokenValid(refreshed)) return refreshed.access_token;

  return null;
}
