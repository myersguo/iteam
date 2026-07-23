// `iteam auth ...` — login (browser loopback), logout, whoami, token, status.
//
// The login flow starts a throwaway localhost HTTP server, opens (or prints)
// `{server}/auth/login?provider=..&cli_redirect=http://127.0.0.1:<port>/cb`,
// and waits for the OAuth callback to redirect back with `?iteam_session=`.
// The captured session token is persisted into the active CLI profile.

import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";
import { updateActiveProfile } from "../config.js";
import { printMessage, printResult } from "../output.js";
import { flagString, flagBool } from "../args.js";
import type { CommandContext } from "../types.js";

interface MeResponse {
  authMode: "none" | "oauth";
  authenticated: boolean;
  human?: { id: string; name: string; username?: string; email?: string } | null;
  providers?: { id: string; label: string; loginUrl: string }[];
  loginUrl?: string;
}

export async function runAuth(cmd: CommandContext): Promise<void> {
  const { action } = cmd;
  switch (action) {
    case "login":
      return login(cmd);
    case "logout":
      return logout(cmd);
    case "whoami":
    case "status":
      return whoami(cmd);
    case "token":
      return setToken(cmd);
    default:
      throw new Error("usage: iteam auth login|logout|whoami|token <token>");
  }
}

async function whoami(cmd: CommandContext): Promise<void> {
  const me = await cmd.client.request<MeResponse>("/api/me", { allowErrorBody: true });
  if (cmd.output.json) return printResult(me, cmd.output);
  if (me.authMode === "none") {
    console.log("auth mode: none (no login required)");
    return;
  }
  if (!me.authenticated) {
    console.log("not logged in. Run `iteam auth login`.");
    return;
  }
  const human = me.human;
  console.log(`logged in as ${human?.name || human?.username || human?.id}`);
  if (human?.email) console.log(`email: ${human.email}`);
  console.log(`server: ${cmd.ctx.serverUrl}`);
}

async function setToken(cmd: CommandContext): Promise<void> {
  const token = cmd.args.positionals[0];
  if (!token) throw new Error("usage: iteam auth token <session-token>");
  updateActiveProfile({ token });
  // Verify against the server so an invalid paste fails loudly.
  const me = await cmd.client.request<MeResponse>("/api/me", {
    headers: { Authorization: `Bearer ${token}` },
    allowErrorBody: true
  });
  if (me.authMode === "oauth" && !me.authenticated) {
    throw new Error("token was saved but the server rejected it; check the value");
  }
  printMessage(`token saved to profile "${cmd.ctx.profileName}"`, cmd.output, { ok: true, human: me.human });
}

async function logout(cmd: CommandContext): Promise<void> {
  // Best-effort server-side logout; always clear the local token.
  try {
    await cmd.client.post("/auth/logout");
  } catch {
    /* ignore — token may already be expired */
  }
  updateActiveProfile({ token: undefined });
  printMessage("logged out (local token cleared)", cmd.output, { ok: true });
}

async function login(cmd: CommandContext): Promise<void> {
  // `/api/me` returns 401 with a body (auth mode + providers) when not logged
  // in, so read the error body instead of throwing on it.
  const me = await cmd.client
    .request<MeResponse>("/api/me", { allowErrorBody: true })
    .catch(() => null);
  if (me && me.authMode === "none") {
    printMessage("server auth mode is 'none' — no login required.", cmd.output, { authMode: "none" });
    return;
  }

  const providers = me?.providers || [];
  const requested = flagString(cmd.args, "provider") || cmd.args.positionals[0];
  let providerId = requested;
  if (!providerId) {
    if (providers.length === 1) {
      providerId = providers[0].id;
    } else if (providers.length > 1) {
      throw new Error(`multiple providers available: ${providers.map((p: { id: string }) => p.id).join(", ")}. Pass --provider <id>.`);
    }
  }
  if (!providerId) {
    throw new Error("could not determine an auth provider from the server. Pass --provider <id> (e.g. github).");
  }

  // Default: manual token flow — open a browser page that displays the signed
  // session, then prompt for it here. This works even when the browser and the
  // CLI are on different machines (SSH). `--loopback` opts into the automatic
  // localhost-capture flow for when both run on the same machine.
  const token = flagBool(cmd.args, "loopback")
    ? await captureSessionViaLoopback(cmd, providerId)
    : await captureSessionViaManualPrompt(cmd, providerId);

  updateActiveProfile({ token });
  const confirmed = await cmd.client.request<MeResponse>("/api/me", {
    headers: { Authorization: `Bearer ${token}` },
    allowErrorBody: true
  });
  if (confirmed.authMode === "oauth" && !confirmed.authenticated) {
    throw new Error("the pasted token was rejected by the server; please try `iteam auth login` again");
  }
  printMessage(
    `logged in as ${confirmed.human?.name || confirmed.human?.username || "user"}`,
    cmd.output,
    { ok: true, human: confirmed.human }
  );
}

/**
 * Open a browser page that renders the signed session (via `cli_display=1`),
 * then read the pasted token from stdin. This is the SSH-friendly default: the
 * browser and the CLI need not share a network namespace.
 */
function captureSessionViaManualPrompt(cmd: CommandContext, providerId: string): Promise<string> {
  const loginUrl = new URL(`${cmd.ctx.serverUrl}/auth/login`);
  loginUrl.searchParams.set("provider", providerId);
  loginUrl.searchParams.set("cli_display", "1");
  const target = loginUrl.toString();
  console.log("Open this URL in your browser to sign in:");
  console.log(`  ${target}`);
  console.log("After signing in, the page shows a token. Copy it and paste it here.");
  openBrowser(target);
  return promptForToken();
}

function promptForToken(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\nPaste token: ", answer => {
      rl.close();
      const token = answer.trim();
      if (!token) {
        reject(new Error("no token entered"));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * Spin up a localhost listener, send the user through the browser OAuth flow
 * with `cli_redirect` pointed back at us, and resolve with the session token
 * the callback hands over as `?iteam_session=`.
 */
function captureSessionViaLoopback(cmd: CommandContext, providerId: string | undefined): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeoutMs = 5 * 60 * 1000;
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/cb") {
        res.writeHead(404).end("not found");
        return;
      }
      const token = url.searchParams.get("iteam_session");
      if (!token) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end("<h1>Login failed</h1><p>No session token received. You can close this tab.</p>");
        cleanup();
        reject(new Error("callback did not include a session token"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>iTeam login complete</h1><p>You can close this tab and return to the terminal.</p>");
      cleanup();
      resolve(token);
    });

    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("login timed out after 5 minutes"));
    }, timeoutMs);
    timer.unref?.();

    function cleanup(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch { /* ignore */ }
    }

    server.on("error", err => {
      cleanup();
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const cliRedirect = `http://127.0.0.1:${port}/cb`;
      const loginUrl = new URL(`${cmd.ctx.serverUrl}/auth/login`);
      if (providerId) loginUrl.searchParams.set("provider", providerId);
      loginUrl.searchParams.set("cli_redirect", cliRedirect);
      const target = loginUrl.toString();
      console.log("Opening browser to complete login:");
      console.log(`  ${target}`);
      console.log("If the browser did not open, copy the URL above into it manually.");
      openBrowser(target);
    });
  });
}

/** Best-effort cross-platform "open this URL in the default browser". */
function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => { /* headless env — user copies the URL */ });
    child.unref();
  } catch {
    /* headless env — user copies the URL */
  }
}
