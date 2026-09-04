// ---------------------------------------------------------------------------
// ArcGIS OAuth sign-in — authorization-code flow with PKCE, implemented
// directly against ArcGIS Online's REST endpoints. No ArcGIS Maps SDK
// dependency, and no separate callback page: this app's own root URL is
// the registered Redirect URI, and doubles as its own OAuth callback —
// handleOAuthCallback() (called from boot()) detects a `?code=...` on load
// and handles it, whether this page instance is the popup or the
// standalone/top-level app.
//
// Works both as a standalone page and embedded via an iframe/Embed widget
// inside ArcGIS Online Experience Builder: standalone uses a full-page
// redirect; embedded uses a popup window (a same-origin iframe can't be
// redirected to ArcGIS's login page — it sets X-Frame-Options), piping the
// result back via postMessage.
//
// This is the same pattern used by the sibling ReadyOp Contacts app —
// ported here with a distinct storage key / message type / popup name so
// the two apps' sign-in state never collides if both are ever open in the
// same browser at once.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js?v=20260904b";

const AUTHORIZE_URL = `${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/oauth2/authorize`;
const TOKEN_URL = `${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/oauth2/token`;
const MESSAGE_TYPE = "assigned_inventory_oauth";
const POPUP_NAME = "assigned_inventory_oauth_popup";

let TOKEN = null; // { accessToken, refreshToken, expiresAt, refreshExpiresAt, username }
let refreshInFlight = null; // shared promise so concurrent ensureFreshToken() callers don't race each other

// --- PKCE helpers ---
function randomString(byteLen = 48) {
  const arr = new Uint8Array(byteLen);
  crypto.getRandomValues(arr);
  return base64url(arr);
}
function base64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256base64url(s) {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return base64url(new Uint8Array(hash));
}

// --- Token cache (localStorage) ---
function loadStoredToken() {
  try {
    const raw = localStorage.getItem(CONFIG.ARCGIS_TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!t.accessToken || !t.expiresAt) return null;
    return t;
  } catch {
    return null;
  }
}
function saveToken(t) {
  TOKEN = t;
  localStorage.setItem(CONFIG.ARCGIS_TOKEN_STORAGE_KEY, JSON.stringify(t));
}
function clearStoredToken() {
  TOKEN = null;
  localStorage.removeItem(CONFIG.ARCGIS_TOKEN_STORAGE_KEY);
  sessionStorage.removeItem("oauth_verifier");
  sessionStorage.removeItem("oauth_state");
}
function tokenFromResponse(data) {
  const now = Date.now();
  const expSec = Number(data.expires_in) || 7200;
  const refSec = Number(data.refresh_token_expires_in) || 0;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || (TOKEN && TOKEN.refreshToken) || null,
    expiresAt: now + expSec * 1000,
    refreshExpiresAt: refSec ? now + refSec * 1000 : (TOKEN && TOKEN.refreshExpiresAt) || null,
    username: data.username || (TOKEN && TOKEN.username) || null,
    fullName: (TOKEN && TOKEN.fullName) || null,
    email: (TOKEN && TOKEN.email) || null,
  };
}

function isInIframe() {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

async function buildAuthorizeUrl() {
  const verifier = randomString(48);
  const challenge = await sha256base64url(verifier);
  const state = randomString(16);
  sessionStorage.setItem("oauth_verifier", verifier);
  sessionStorage.setItem("oauth_state", state);
  const params = new URLSearchParams({
    client_id: CONFIG.ARCGIS_APP_ID,
    response_type: "code",
    redirect_uri: CONFIG.ARCGIS_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    expiration: String(CONFIG.ARCGIS_TOKEN_EXPIRATION_MINUTES),
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function exchangeCodeForToken(code) {
  const verifier = sessionStorage.getItem("oauth_verifier");
  if (!verifier) throw new Error("Missing PKCE verifier — please sign in again.");
  const params = new URLSearchParams({
    client_id: CONFIG.ARCGIS_APP_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: CONFIG.ARCGIS_REDIRECT_URI,
    code_verifier: verifier,
    f: "json",
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) {
    const msg = (data.error.details && data.error.details[0]) || data.error.message || "Sign-in failed";
    throw new Error(msg);
  }
  if (!data.access_token) throw new Error("No access token returned");
  sessionStorage.removeItem("oauth_verifier");
  sessionStorage.removeItem("oauth_state");
  return tokenFromResponse(data);
}

async function refreshAccessTokenNow() {
  if (!TOKEN || !TOKEN.refreshToken) throw new Error("No refresh token available");
  if (TOKEN.refreshExpiresAt && Date.now() > TOKEN.refreshExpiresAt) {
    throw new Error("Refresh token expired");
  }
  const params = new URLSearchParams({
    client_id: CONFIG.ARCGIS_APP_ID,
    grant_type: "refresh_token",
    refresh_token: TOKEN.refreshToken,
    f: "json",
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Token refresh failed");
  if (!data.access_token) throw new Error("No access token in refresh response");
  return tokenFromResponse(data);
}

/**
 * Ensures the in-memory token is fresh, refreshing if near expiry. Throws if
 * not signed in or refresh fails. Concurrent callers share one in-flight
 * refresh instead of each kicking off their own (the sibling Preds Summary
 * app hit a real race here when several token-gated lookups fired at once).
 */
export async function ensureFreshToken() {
  if (!TOKEN) throw new Error("Not signed in");
  if (TOKEN.expiresAt && Date.now() < TOKEN.expiresAt - CONFIG.ARCGIS_REFRESH_BUFFER_MS) return;
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessTokenNow()
      .then((fresh) => {
        saveToken(fresh);
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export function getToken() {
  return TOKEN ? TOKEN.accessToken : null;
}
export function getUsername() {
  return TOKEN ? TOKEN.username : null;
}

/**
 * Fetches (once) and caches the signed-in user's full name and email from
 * ArcGIS's own community/self endpoint. Email is what permissions.js
 * matches against the Users layer (see MATCH_CURRENT_USER_BY in config.js)
 * — there's no ArcGIS-username field on that layer, so email is the only
 * identifier both systems share.
 */
export async function fetchProfile() {
  if (!TOKEN) return null;
  if (TOKEN.fullName && TOKEN.email) return { fullName: TOKEN.fullName, email: TOKEN.email };
  try {
    const url = `${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/community/self?f=json&token=${encodeURIComponent(TOKEN.accessToken)}`;
    const res = await fetch(url);
    const data = await res.json();
    const fullName =
      data.fullName || [data.firstName, data.lastName].filter(Boolean).join(" ").trim() || null;
    TOKEN.fullName = fullName || TOKEN.username;
    TOKEN.email = data.email || null;
    saveToken(TOKEN);
  } catch (err) {
    console.warn("Could not fetch ArcGIS profile (name/email):", err);
  }
  return { fullName: TOKEN.fullName, email: TOKEN.email };
}

export function isSignedIn() {
  return !!TOKEN;
}
export function signOut() {
  clearStoredToken();
}

/**
 * Call once on page load, before anything else. Handles a `?code=...`
 * redirect if present (either as the popup, relaying to its opener and
 * closing, or as the standalone/top-level app, exchanging the code
 * directly), and loads any previously-stored token.
 *
 * @returns {Promise<"popup"|"redirected"|null>}
 */
export async function boot() {
  TOKEN = loadStoredToken();

  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (!code && !error) return null;

  if (window.opener && window.opener !== window) {
    try {
      window.opener.postMessage(
        {
          type: MESSAGE_TYPE,
          code,
          state,
          error,
          error_description: url.searchParams.get("error_description") || null,
        },
        window.location.origin
      );
    } catch (e) {
      console.error("postMessage to opener failed:", e);
    }
    setTimeout(() => {
      try {
        window.close();
      } catch {}
    }, 50);
    document.body.innerHTML =
      '<div style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#333">Sign-in complete. You can close this window.</div>';
    return "popup";
  }

  if (error) {
    history.replaceState({}, "", url.pathname);
    throw new Error(`Sign-in error: ${url.searchParams.get("error_description") || error}`);
  }
  const expectedState = sessionStorage.getItem("oauth_state");
  if (expectedState && state !== expectedState) {
    history.replaceState({}, "", url.pathname);
    throw new Error("Sign-in failed: state mismatch. Please try again.");
  }
  try {
    const tok = await exchangeCodeForToken(code);
    saveToken(tok);
    history.replaceState({}, "", url.pathname);
    return "redirected";
  } catch (err) {
    history.replaceState({}, "", url.pathname);
    throw err;
  }
}

let preparedAuthUrl = null;

export async function prepareAuthUrl() {
  preparedAuthUrl = await buildAuthorizeUrl();
  return preparedAuthUrl;
}

/**
 * Starts the sign-in flow. Standalone: redirects the whole page (this
 * promise never resolves — the page navigates away). Embedded in an
 * iframe: opens a popup and resolves once sign-in completes there.
 */
export function startSignIn() {
  if (isInIframe()) {
    return new Promise((resolve, reject) => {
      const w = 480,
        h = 640;
      const left = Math.max(0, (screen.width - w) / 2);
      const top = Math.max(0, (screen.height - h) / 2);
      const popup = window.open(
        "about:blank",
        POPUP_NAME,
        `width=${w},height=${h},left=${left},top=${top},toolbar=0,menubar=0,scrollbars=1`
      );
      if (!popup) {
        reject(new Error("Popup was blocked — please allow popups for this site, then try again."));
        return;
      }
      try {
        popup.document.write(
          "<!doctype html><meta charset='utf-8'><title>Signing in…</title>" +
            "<style>body{font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#333}</style>" +
            "<div>Connecting to ArcGIS Online…</div>"
        );
      } catch {
        /* fine to ignore */
      }
      const urlPromise = preparedAuthUrl ? Promise.resolve(preparedAuthUrl) : buildAuthorizeUrl();
      urlPromise
        .then((url) => {
          popup.location.href = url;
        })
        .catch((err) => {
          try {
            popup.close();
          } catch {}
          reject(err);
        });

      let settled = false;
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        clearInterval(closedTimer);
      };
      const onMessage = async (event) => {
        if (event.origin !== window.location.origin) return;
        if (!event.data || event.data.type !== MESSAGE_TYPE) return;
        settled = true;
        cleanup();
        if (event.data.error) {
          reject(new Error(event.data.error_description || event.data.error));
          return;
        }
        try {
          const tok = await exchangeCodeForToken(event.data.code);
          saveToken(tok);
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      window.addEventListener("message", onMessage);
      const closedTimer = setInterval(() => {
        if (popup.closed && !settled) {
          cleanup();
          reject(new Error("Sign-in window was closed."));
        }
      }, 500);
    });
  }

  const urlPromise = preparedAuthUrl ? Promise.resolve(preparedAuthUrl) : buildAuthorizeUrl();
  return urlPromise.then((url) => {
    window.location.href = url;
  });
}
