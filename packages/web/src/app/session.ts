const AUTH_TOKEN_STORAGE_KEY = "iteam.authToken";
const AUTH_TOKEN_HASH_KEY = "iteam_session";
const ACTIVE_SPACE_STORAGE_KEY = "iteam.spaceId";
const DEFAULT_SPACE_ID = "space_default";

/**
 * Space-aware fetch. Injects the currently selected space as `X-Iteam-Space`
 * so server calls stay scoped without threading spaceId through view code.
 */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const spaceId = getActiveSpaceId();
  const headers = new Headers(init?.headers);
  // Header values must be ISO-8859-1. Stale localStorage or a corrupt token can
  // otherwise throw inside `headers.set` and crash the app on load.
  if (spaceId && !headers.has("X-Iteam-Space") && isHeaderSafe(spaceId)) {
    headers.set("X-Iteam-Space", spaceId);
  }
  const authToken = getAuthToken();
  if (authToken && !headers.has("Authorization") && isHeaderSafe(authToken)) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  return fetch(input, { ...init, headers });
}

/** True when every character is a valid ISO-8859-1 (Latin1) code point. */
function isHeaderSafe(value: string): boolean {
  return !/[^\u0000-\u00ff]/.test(value);
}

export function getAuthToken(): string {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function setAuthToken(token: string): void {
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {}
}

export function consumeAuthTokenFromHash(): boolean {
  if (typeof window === "undefined" || !window.location.hash) return false;
  const raw = window.location.hash.slice(1);
  const params = new URLSearchParams(raw);
  const token = params.get(AUTH_TOKEN_HASH_KEY);
  if (!token) return false;
  setAuthToken(token);
  params.delete(AUTH_TOKEN_HASH_KEY);
  const rest = params.toString();
  const next = `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`;
  window.history.replaceState(null, "", next);
  return true;
}

export function getActiveSpaceId(): string {
  try {
    const stored = localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY) || DEFAULT_SPACE_ID;
    // A non-Latin1 stored value would later throw when used as an HTTP header;
    // treat it as unset and self-heal to the default.
    if (!isHeaderSafe(stored)) {
      localStorage.removeItem(ACTIVE_SPACE_STORAGE_KEY);
      return DEFAULT_SPACE_ID;
    }
    return stored;
  } catch {
    return DEFAULT_SPACE_ID;
  }
}

export function setActiveSpaceId(spaceId: string): void {
  try {
    localStorage.setItem(ACTIVE_SPACE_STORAGE_KEY, spaceId || DEFAULT_SPACE_ID);
  } catch {}
}

/**
 * Read the active space id at page load. URL wins over localStorage so a shared
 * link like `/growth/channel/all` lands on the right space even on a fresh browser.
 */
export function resolveInitialSpaceId(slug: string | null | undefined): string {
  const value = String(slug || "").trim();
  if (!value) return getActiveSpaceId();
  // The URL slug may be either a space slug (`growth`) or a raw id
  // (`space_abc`). Store the raw string until the spaces list can resolve it.
  return value;
}
