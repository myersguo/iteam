import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, type IteamCore, type OAuthHumanInput } from "./core.js";
import type { Human } from "@iteam/shared";

export type AuthMode = "none" | "oauth";
export type AuthProviderType = "github" | "oauth2";

export interface AuthConfig {
  mode: AuthMode;
  providers: AuthProviderConfig[];
  publicUrl?: string;
  sessionSecret: string;
  sessionTtlMs: number;
  stateTtlMs: number;
  cookieSecure: boolean;
  cookieSameSite: CookieSameSite;
}

export type CookieSameSite = "lax" | "strict" | "none";

export interface AuthProviderConfig {
  id: string;
  label: string;
  type: AuthProviderType;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  userinfoUrl?: string;
  emailsUrl?: string;
  logoutUrl?: string;
  redirectUri?: string;
  tokenAuth: "basic" | "body";
  extraAuthorizeParams?: Record<string, string>;
}

export interface AuthProviderSummary {
  id: string;
  label: string;
  type: AuthProviderType;
  loginUrl: string;
}

export interface OAuthSession {
  humanId: string;
  providerId: string;
  providerLabel?: string;
  username: string;
  name: string;
  email?: string;
  picture?: string;
  iat: number;
  exp: number;
}

interface StateCookiePayload {
  state: string;
  providerId: string;
  returnTo: string;
  exp: number;
  clientFingerprint?: string;
  /**
   * Loopback redirect for the `iteam auth login` CLI flow. When present the
   * callback hands the signed session back as a `?iteam_session=` query
   * parameter (readable by the CLI's local server) instead of a URL fragment.
   */
  cliRedirect?: string;
  /**
   * Manual CLI flow: render the signed session on an HTML page so the user can
   * copy it into the terminal. Used when the browser and CLI are on different
   * machines (e.g. SSH), where a loopback redirect cannot reach the CLI.
   */
  cliDisplay?: boolean;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  code?: number;
  error?: string;
  error_description?: string;
  message?: string;
}

interface ProviderProfile {
  id?: string | number;
  sub?: string;
  login?: string;
  username?: string;
  name?: string;
  nickname?: string;
  email?: string | null;
  avatar_url?: string;
  picture?: string;
  code?: number;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

interface GitHubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

export const SESSION_COOKIE = "iteam_session";
const STATE_COOKIE = "iteam_oauth_state";
const MAX_PENDING_OAUTH_STATES = 1000;
const pendingOAuthStates = new Map<string, StateCookiePayload>();

const DEFAULT_GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const DEFAULT_GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_GITHUB_USERINFO_URL = "https://api.github.com/user";
const DEFAULT_GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const providerIds = resolveProviderIds(env);
  const explicitMode = String(env.ITEAM_AUTH_MODE || "").trim().toLowerCase();
  const mode: AuthMode = explicitMode === "none" || (!explicitMode && providerIds.length === 0)
    ? "none"
    : "oauth";

  const publicUrl = stripTrailingSlash(String(env.ITEAM_PUBLIC_URL || "").trim()) || undefined;
  const secureFromEnv = env.ITEAM_AUTH_COOKIE_SECURE;
  const cookieSecure = secureFromEnv === undefined
    ? !!publicUrl?.startsWith("https://")
    : !["0", "false", "no", "off"].includes(secureFromEnv.trim().toLowerCase());
  const cookieSameSite = readCookieSameSite(env.ITEAM_AUTH_COOKIE_SAMESITE);

  if (mode === "none") {
    return {
      mode: "none",
      providers: [],
      publicUrl,
      sessionSecret: String(env.ITEAM_SESSION_SECRET || "local-dev-session").trim(),
      sessionTtlMs: readPositiveInt(env.ITEAM_SESSION_TTL_SECONDS, 7 * 24 * 60 * 60) * 1000,
      stateTtlMs: readPositiveInt(env.ITEAM_OAUTH_STATE_TTL_SECONDS, 10 * 60) * 1000,
      cookieSecure,
      cookieSameSite
    };
  }

  const providers = providerIds.map(id => readProviderConfig(id, env));
  if (providers.length === 0) throw new Error("ITEAM_AUTH_MODE=oauth requires at least one auth provider");
  const firstSecret = providers.find(provider => provider.clientSecret)?.clientSecret || "local-dev-session";
  return {
    mode: "oauth",
    providers,
    publicUrl,
    sessionSecret: String(env.ITEAM_SESSION_SECRET || firstSecret).trim(),
    sessionTtlMs: readPositiveInt(env.ITEAM_SESSION_TTL_SECONDS, 7 * 24 * 60 * 60) * 1000,
    stateTtlMs: readPositiveInt(env.ITEAM_OAUTH_STATE_TTL_SECONDS, 10 * 60) * 1000,
    cookieSecure,
    cookieSameSite
  };
}

export function readOAuthSession(config: AuthConfig, req: IncomingMessage): OAuthSession | null {
  if (config.mode !== "oauth") return null;
  const raw = parseCookies(req)[SESSION_COOKIE] || readBearerSession(req);
  if (!raw) return null;
  const payload = verifySignedPayload<OAuthSession>(raw, config.sessionSecret);
  if (!payload || !payload.humanId || Date.now() > payload.exp) return null;
  return payload;
}

export function requireOAuthSession(config: AuthConfig, req: IncomingMessage): OAuthSession {
  const session = readOAuthSession(config, req);
  if (!session) throw new HttpError(401, "login required");
  return session;
}

export async function handleAuthRoute(
  config: AuthConfig,
  core: IteamCore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/me") {
    if (config.mode !== "oauth") {
      return sendJson(res, 200, { authMode: "none", authenticated: true, human: core.listHumans()[0] || null, providers: [] });
    }
    const providers = publicProviders(config, url.searchParams.get("return_to"));
    const session = readOAuthSession(config, req);
    if (!session) {
      return sendJson(res, 401, {
        authMode: "oauth",
        authenticated: false,
        providers,
        ...(providers.length === 1 ? { loginUrl: providers[0].loginUrl } : {})
      });
    }
    const human = core.listHumans().find(item => item.id === session.humanId) || sessionHuman(session);
    return sendJson(res, 200, {
      authMode: "oauth",
      authenticated: true,
      human,
      providers,
      logoutUrl: "/auth/logout"
    });
  }

  if (config.mode !== "oauth") return false;

  if (req.method === "GET" && url.pathname === "/auth/login") {
    const provider = resolveRequestedProvider(config, url.searchParams.get("provider"));
    const state = randomToken();
    const returnTo = sanitizeReturnTo(url.searchParams.get("return_to") || "/");
    const cliRedirect = sanitizeCliRedirect(url.searchParams.get("cli_redirect"));
    const cliDisplay = isTruthyParam(url.searchParams.get("cli_display"));
    const statePayload: StateCookiePayload = {
      state,
      providerId: provider.id,
      returnTo,
      exp: Date.now() + config.stateTtlMs,
      clientFingerprint: oauthClientFingerprint(req),
      ...(cliRedirect ? { cliRedirect } : {}),
      ...(cliDisplay ? { cliDisplay: true } : {})
    };
    rememberOAuthState(statePayload);
    appendSetCookie(res, serializeSignedCookie(STATE_COOKIE, statePayload, config.sessionSecret, {
      maxAgeSeconds: Math.floor(config.stateTtlMs / 1000),
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite
    }));
    const authorize = new URL(provider.authorizeUrl);
    for (const [key, value] of Object.entries(provider.extraAuthorizeParams || {})) {
      authorize.searchParams.set(key, value);
    }
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", provider.clientId);
    authorize.searchParams.set("redirect_uri", callbackUrl(req, config, provider));
    if (provider.scope) authorize.searchParams.set("scope", provider.scope);
    authorize.searchParams.set("state", state);
    redirect(res, authorize.toString());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    const code = String(url.searchParams.get("code") || "").trim();
    const state = String(url.searchParams.get("state") || "").trim();
    if (!code || !state) throw new HttpError(400, "code and state are required");
    const statePayload = consumeOAuthStatePayload(config, req, state);
    if (!statePayload) {
      throw new HttpError(400, "invalid OAuth state");
    }
    const provider = findProvider(config, statePayload.providerId);
    const token = await exchangeCode(provider, code, callbackUrl(req, config, provider));
    const profile = await fetchProviderProfile(provider, token.access_token!);
    const humanInput = providerHumanInput(provider, profile);
    const human = core.upsertOAuthHuman(humanInput);
    const sessionToken = signPayload(sessionFromHuman(provider, human, config.sessionTtlMs), config.sessionSecret);
    appendSetCookie(res, clearCookie(STATE_COOKIE, config.cookieSecure, config.cookieSameSite));
    appendSetCookie(res, serializeCookie(SESSION_COOKIE, sessionToken, {
      maxAgeSeconds: Math.floor(config.sessionTtlMs / 1000),
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite
    }));
    if (statePayload.cliRedirect) {
      redirect(res, appendSessionQuery(statePayload.cliRedirect, sessionToken));
      return true;
    }
    if (statePayload.cliDisplay) {
      sendCliTokenPage(res, sessionToken, human);
      return true;
    }
    redirect(res, appendSessionFragment(statePayload.returnTo || "/", sessionToken));
    return true;
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/auth/logout") {
    const session = readOAuthSession(config, req);
    appendSetCookie(res, clearCookie(SESSION_COOKIE, config.cookieSecure, config.cookieSameSite));
    const postLogout = absoluteUrl(req, config, "/");
    const provider = session ? config.providers.find(item => item.id === session.providerId) : null;
    if (provider?.logoutUrl) {
      const logout = new URL(provider.logoutUrl);
      logout.searchParams.set("client_id", provider.clientId);
      logout.searchParams.set("post_logout_redirect_uri", postLogout);
      logout.searchParams.set("state", randomToken());
      redirect(res, logout.toString());
      return true;
    }
    redirect(res, postLogout);
    return true;
  }

  return false;
}

function readBearerSession(req: IncomingMessage): string | null {
  const raw = String(req.headers.authorization || "").trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function appendSessionFragment(returnTo: string, sessionToken: string): string {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  const separator = safeReturnTo.includes("#") ? "&" : "#";
  return `${safeReturnTo}${separator}iteam_session=${encodeURIComponent(sessionToken)}`;
}

/**
 * Hand the signed session back to the `iteam auth login` loopback server as a
 * query parameter. Unlike the browser flow (which uses a URL fragment so the
 * token never reaches the server), the CLI runs its own localhost listener and
 * needs the token in the query string to read it.
 */
function appendSessionQuery(cliRedirect: string, sessionToken: string): string {
  const target = new URL(cliRedirect);
  target.searchParams.set("iteam_session", sessionToken);
  return target.toString();
}

/**
 * Only allow loopback http(s) redirects so a malicious `cli_redirect` cannot
 * turn the OAuth callback into an open redirector to an external host.
 */
function sanitizeCliRedirect(value: string | null | undefined): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return undefined;
  return parsed.toString();
}

function isTruthyParam(value: string | null | undefined): boolean {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Manual CLI login page: shows the signed session token so the user can copy
 * it into `iteam auth token <token>`. Used when the browser and the CLI run on
 * different machines and a loopback redirect cannot reach the terminal.
 */
function sendCliTokenPage(res: ServerResponse, sessionToken: string, human: Human): void {
  const safeName = escapeHtml(human.name || human.username || human.id || "you");
  const safeToken = escapeHtml(sessionToken);
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>iTeam CLI login</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1115; color: #e6e8eb; margin: 0; padding: 48px 20px; }
  .card { max-width: 640px; margin: 0 auto; background: #171a21; border: 1px solid #262b36; border-radius: 12px; padding: 28px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #9aa4b2; font-size: 14px; line-height: 1.5; }
  .token { width: 100%; box-sizing: border-box; margin: 16px 0; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #e6e8eb; background: #0f1115; border: 1px solid #2f3644; border-radius: 8px; word-break: break-all; }
  button { background: #3b82f6; color: #fff; border: 0; border-radius: 8px; padding: 10px 16px; font-size: 14px; cursor: pointer; }
  code { background: #0f1115; padding: 2px 6px; border-radius: 4px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Signed in as ${safeName}</h1>
    <p>Copy this session token and paste it into your terminal:</p>
    <p><code>iteam auth token &lt;token&gt;</code></p>
    <textarea class="token" id="token" rows="4" readonly>${safeToken}</textarea>
    <button onclick="navigator.clipboard.writeText(document.getElementById('token').value).then(()=>{this.textContent='Copied!'})">Copy token</button>
    <p style="margin-top:16px">You can close this tab after copying. The token is stored only on your machine.</p>
  </div>
</body>
</html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveProviderIds(env: NodeJS.ProcessEnv): string[] {
  const raw = String(env.ITEAM_AUTH_PROVIDERS || "").trim();
  if (raw) return unique(raw.split(/[ ,]+/).map(item => normalizeProviderId(item)).filter(Boolean));
  const inferred: string[] = [];
  if (env.ITEAM_GITHUB_CLIENT_ID || env.ITEAM_GITHUB_CLIENT_SECRET) inferred.push("github");
  if (env.ITEAM_OAUTH2_CLIENT_ID || env.ITEAM_OAUTH2_CLIENT_SECRET) inferred.push("oauth2");
  return unique(inferred);
}

function readProviderConfig(id: string, env: NodeJS.ProcessEnv): AuthProviderConfig {
  switch (normalizeProviderId(id)) {
    case "github":
      return readGitHubProvider(env);
    case "oauth2":
    case "generic":
      return readGenericOAuth2Provider(env);
    default:
      throw new Error(`unsupported auth provider: ${id}`);
  }
}

function readGitHubProvider(env: NodeJS.ProcessEnv): AuthProviderConfig {
  const clientId = requiredEnv(env, "ITEAM_GITHUB_CLIENT_ID", "github auth provider");
  const clientSecret = requiredEnv(env, "ITEAM_GITHUB_CLIENT_SECRET", "github auth provider");
  return {
    id: "github",
    label: String(env.ITEAM_GITHUB_LABEL || "GitHub"),
    type: "github",
    clientId,
    clientSecret,
    authorizeUrl: String(env.ITEAM_GITHUB_AUTHORIZE_URL || DEFAULT_GITHUB_AUTHORIZE_URL).trim(),
    tokenUrl: String(env.ITEAM_GITHUB_TOKEN_URL || DEFAULT_GITHUB_TOKEN_URL).trim(),
    userinfoUrl: String(env.ITEAM_GITHUB_USERINFO_URL || DEFAULT_GITHUB_USERINFO_URL).trim(),
    emailsUrl: String(env.ITEAM_GITHUB_EMAILS_URL || DEFAULT_GITHUB_EMAILS_URL).trim(),
    redirectUri: normalizeOptional(env.ITEAM_GITHUB_REDIRECT_URI),
    scope: String(env.ITEAM_GITHUB_SCOPE || "read:user user:email").trim(),
    tokenAuth: "body"
  };
}

function readGenericOAuth2Provider(env: NodeJS.ProcessEnv): AuthProviderConfig {
  const clientId = requiredEnv(env, "ITEAM_OAUTH2_CLIENT_ID", "oauth2 auth provider");
  const clientSecret = requiredEnv(env, "ITEAM_OAUTH2_CLIENT_SECRET", "oauth2 auth provider");
  return {
    id: String(env.ITEAM_OAUTH2_PROVIDER_ID || "oauth2").trim() || "oauth2",
    label: String(env.ITEAM_OAUTH2_LABEL || "OAuth2"),
    type: "oauth2",
    clientId,
    clientSecret,
    authorizeUrl: requiredEnv(env, "ITEAM_OAUTH2_AUTHORIZE_URL", "oauth2 auth provider"),
    tokenUrl: requiredEnv(env, "ITEAM_OAUTH2_TOKEN_URL", "oauth2 auth provider"),
    userinfoUrl: requiredEnv(env, "ITEAM_OAUTH2_USERINFO_URL", "oauth2 auth provider"),
    logoutUrl: normalizeOptional(env.ITEAM_OAUTH2_LOGOUT_URL),
    redirectUri: normalizeOptional(env.ITEAM_OAUTH2_REDIRECT_URI),
    scope: String(env.ITEAM_OAUTH2_SCOPE || "openid profile email").trim(),
    tokenAuth: env.ITEAM_OAUTH2_TOKEN_AUTH === "basic" ? "basic" : "body"
  };
}

function publicProviders(config: AuthConfig, returnToInput: string | null): AuthProviderSummary[] {
  const returnTo = sanitizeReturnTo(returnToInput || "/");
  return config.providers.map(provider => ({
    id: provider.id,
    label: provider.label,
    type: provider.type,
    loginUrl: `/auth/login?provider=${encodeURIComponent(provider.id)}&return_to=${encodeURIComponent(returnTo)}`
  }));
}

function rememberOAuthState(payload: StateCookiePayload): void {
  prunePendingOAuthStates();
  pendingOAuthStates.set(payload.state, payload);
  if (pendingOAuthStates.size <= MAX_PENDING_OAUTH_STATES) return;
  const overflow = pendingOAuthStates.size - MAX_PENDING_OAUTH_STATES;
  let removed = 0;
  for (const key of pendingOAuthStates.keys()) {
    pendingOAuthStates.delete(key);
    removed++;
    if (removed >= overflow) break;
  }
}

function consumeOAuthStatePayload(config: AuthConfig, req: IncomingMessage, state: string): StateCookiePayload | null {
  const cookiePayload = verifySignedPayload<StateCookiePayload>(parseCookies(req)[STATE_COOKIE], config.sessionSecret);
  if (validOAuthStatePayload(cookiePayload, state, oauthClientFingerprint(req))) {
    pendingOAuthStates.delete(state);
    return cookiePayload;
  }

  const stored = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
  return validOAuthStatePayload(stored, state, oauthClientFingerprint(req)) ? stored! : null;
}

function validOAuthStatePayload(payload: StateCookiePayload | null | undefined, state: string, clientFingerprint: string): boolean {
  if (!payload || payload.state !== state || Date.now() > payload.exp) return false;
  return !payload.clientFingerprint || payload.clientFingerprint === clientFingerprint;
}

function prunePendingOAuthStates(): void {
  const now = Date.now();
  for (const [state, payload] of pendingOAuthStates) {
    if (payload.exp <= now) pendingOAuthStates.delete(state);
  }
}

function oauthClientFingerprint(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket.remoteAddress || "";
  const ua = String(req.headers["user-agent"] || "");
  return createHash("sha256").update(`${ip}\n${ua}`).digest("base64url");
}

function resolveRequestedProvider(config: AuthConfig, providerId: string | null): AuthProviderConfig {
  if (!providerId && config.providers.length === 1) return config.providers[0];
  if (!providerId) throw new HttpError(400, "provider is required");
  return findProvider(config, providerId);
}

function findProvider(config: AuthConfig, providerId: string): AuthProviderConfig {
  const normalized = normalizeProviderId(providerId);
  const provider = config.providers.find(item => normalizeProviderId(item.id) === normalized);
  if (!provider) throw new HttpError(404, `auth provider not found: ${providerId}`);
  return provider;
}

function sessionFromHuman(provider: AuthProviderConfig, human: Human, ttlMs: number): OAuthSession {
  const now = Date.now();
  return {
    humanId: human.id,
    providerId: provider.id,
    providerLabel: provider.label,
    username: human.username || human.handle || human.id,
    name: human.name,
    ...(human.email ? { email: human.email } : {}),
    ...(human.avatarUrl ? { picture: human.avatarUrl } : {}),
    iat: now,
    exp: now + ttlMs
  };
}

function sessionHuman(session: OAuthSession): Human {
  return {
    id: session.humanId,
    name: session.name,
    handle: slugHandle(session.username),
    source: session.providerId,
    username: session.username,
    ...(session.email ? { email: session.email } : {}),
    ...(session.picture ? { avatarUrl: session.picture } : {})
  };
}

async function exchangeCode(provider: AuthProviderConfig, code: string, redirectUri: string): Promise<TokenResponse> {
  const body = new URLSearchParams();
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  if (provider.type !== "github") body.set("grant_type", "authorization_code");
  if (provider.tokenAuth === "body") {
    body.set("client_id", provider.clientId);
    body.set("client_secret", provider.clientSecret);
  }
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json"
  };
  if (provider.tokenAuth === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString("base64")}`;
  }
  const response = await fetch(provider.tokenUrl, { method: "POST", headers, body });
  const data = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok || data.code || !data.access_token) {
    throw new HttpError(502, `${provider.label} token exchange failed: ${data.error_description || data.error || data.message || response.statusText}`);
  }
  return data;
}

async function fetchProviderProfile(provider: AuthProviderConfig, accessToken: string): Promise<ProviderProfile> {
  if (provider.type === "github") return fetchGitHubProfile(provider, accessToken);
  if (!provider.userinfoUrl) throw new HttpError(500, `${provider.label} userinfo URL is not configured`);
  const response = await fetch(provider.userinfoUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
  });
  const data = await response.json().catch(() => ({})) as ProviderProfile;
  if (!response.ok || data.code || data.error) {
    throw new HttpError(502, `${provider.label} userinfo failed: ${data.error || data.message || response.statusText}`);
  }
  return data;
}

async function fetchGitHubProfile(provider: AuthProviderConfig, accessToken: string): Promise<ProviderProfile> {
  const headers = githubHeaders(accessToken);
  const response = await fetch(provider.userinfoUrl || DEFAULT_GITHUB_USERINFO_URL, { headers });
  const profile = await response.json().catch(() => ({})) as ProviderProfile;
  if (!response.ok || profile.error) {
    throw new HttpError(502, `${provider.label} userinfo failed: ${profile.error || profile.message || response.statusText}`);
  }
  if (!profile.email && provider.emailsUrl) {
    const emailResponse = await fetch(provider.emailsUrl, { headers });
    if (emailResponse.ok) {
      const emails = await emailResponse.json().catch(() => []) as GitHubEmail[];
      const primary = emails.find(item => item.primary && item.verified && item.email);
      const verified = emails.find(item => item.verified && item.email);
      profile.email = primary?.email || verified?.email || emails.find(item => item.email)?.email || profile.email;
    }
  }
  return profile;
}

function providerHumanInput(provider: AuthProviderConfig, profile: ProviderProfile): OAuthHumanInput {
  if (provider.type === "github") {
    const providerUserId = String(profile.id || profile.login || "").trim();
    const login = String(profile.login || providerUserId).trim();
    if (!providerUserId || !login) throw new HttpError(502, `${provider.label} profile missing id/login`);
    const externalId = `${provider.id}:${providerUserId}`;
    return {
      id: `human_oauth_${createHash("sha256").update(externalId).digest("hex").slice(0, 16)}`,
      name: String(profile.name || login).trim(),
      handle: slugHandle(login),
      role: "member",
      source: provider.id,
      username: login,
      email: normalizeOptional(profile.email),
      avatarUrl: normalizeOptional(profile.avatar_url),
      externalId
    };
  }

  const providerUserId = String(profile.sub || profile.id || profile.username || profile.email || "").trim();
  if (!providerUserId) throw new HttpError(502, `${provider.label} profile missing id/sub/username`);
  const username = String(profile.username || profile.name || profile.email || providerUserId).trim();
  const externalId = `${provider.id}:${providerUserId}`;
  return {
    id: `human_oauth_${createHash("sha256").update(externalId).digest("hex").slice(0, 16)}`,
    name: String(profile.nickname || profile.name || username).trim(),
    handle: slugHandle(username),
    role: "member",
    source: provider.id,
    username,
    email: normalizeOptional(profile.email),
    avatarUrl: normalizeOptional(profile.picture || profile.avatar_url),
    externalId
  };
}

function githubHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "iteam"
  };
}

function serializeSignedCookie(
  name: string,
  payload: unknown,
  secret: string,
  options: { maxAgeSeconds: number; httpOnly: boolean; secure: boolean; sameSite: CookieSameSite }
): string {
  return serializeCookie(name, signPayload(payload, secret), options);
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; httpOnly: boolean; secure: boolean; sameSite: CookieSameSite }
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `SameSite=${sameSiteCookieValue(options.sameSite)}`
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name: string, secure: boolean, sameSite: CookieSameSite = "lax"): string {
  return serializeCookie(name, "", { maxAgeSeconds: 0, httpOnly: true, secure, sameSite });
}

function signPayload(payload: unknown, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${hmac(encoded, secret)}`;
}

function verifySignedPayload<T>(raw: string | undefined, secret: string): T | null {
  if (!raw) return null;
  const [encoded, signature] = decodeURIComponent(raw).split(".");
  if (!encoded || !signature) return null;
  if (!safeEqual(signature, hmac(encoded, secret))) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie || "";
  return Object.fromEntries(String(raw).split(";").map(part => {
    const index = part.indexOf("=");
    if (index <= 0) return ["", ""];
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
}

function appendSetCookie(res: ServerResponse, value: string): void {
  const current = res.getHeader("set-cookie");
  if (!current) {
    res.setHeader("set-cookie", value);
  } else if (Array.isArray(current)) {
    res.setHeader("set-cookie", [...current, value]);
  } else {
    res.setHeader("set-cookie", [String(current), value]);
  }
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

function sendJson(res: ServerResponse, status: number, data: unknown): true {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
  return true;
}

function callbackUrl(req: IncomingMessage, config: AuthConfig, provider: AuthProviderConfig): string {
  return provider.redirectUri || absoluteUrl(req, config, "/auth/callback");
}

function absoluteUrl(req: IncomingMessage, config: Pick<AuthConfig, "publicUrl">, path: string): string {
  if (config.publicUrl) return `${config.publicUrl}${path}`;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1").split(",")[0].trim();
  return `${proto}://${host}${path}`;
}

function sanitizeReturnTo(value: string | null | undefined): string {
  const raw = String(value || "/").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.startsWith("/auth/")) return "/";
  return raw;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function readCookieSameSite(value: string | undefined): CookieSameSite {
  const normalized = String(value || "lax").trim().toLowerCase();
  if (normalized === "strict" || normalized === "none") return normalized;
  return "lax";
}

function sameSiteCookieValue(value: CookieSameSite): string {
  return value === "none" ? "None" : value === "strict" ? "Strict" : "Lax";
}

function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

function normalizeProviderId(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string, label: string): string {
  const value = String(env[key] || "").trim();
  if (!value) throw new Error(`${key} is required for ${label}`);
  return value;
}

function normalizeOptional(value: unknown): string | undefined {
  const text = String(value || "").trim();
  return text || undefined;
}

function slugHandle(value: string): string {
  return String(value || "member").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "member";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
