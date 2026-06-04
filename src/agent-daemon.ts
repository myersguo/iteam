#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { requestJson } from "./http-client.js";
import { DAEMON_VERSION, localComputerFingerprint, nowIso } from "./lib.js";
import { detectRuntimes } from "./runtimes.js";
import { AgentLauncher } from "./agent-launcher.js";
import type { Agent, ConnectComputerResult, DeliveryWithContext } from "./types.js";

const serverUrl = readArg("--server-url", process.env.ITEAM_SERVER_URL);
const cliConnectToken = readArg("--connect-token", process.env.ITEAM_CONNECT_TOKEN);
const name = readArg("--name", localComputerFingerprint().hostname) || localComputerFingerprint().hostname;
const intervalMs = Number(readArg("--interval-ms", "5000"));

if (!serverUrl) {
  printUsage("--server-url is required");
  process.exit(1);
}
if (!cliConnectToken) {
  printUsage("--connect-token is required (token is the computer's permanent identity)");
  process.exit(1);
}

const baseUrl = serverUrl.replace(/\/$/, "");

/**
 * Auth state. The token is the computer's permanent identity — it is issued
 * by the server when an invite is generated, bound to a brand-new computer
 * on first successful `/api/computers/connect`, and from then on used for
 * every heartbeat, runtime callback, and the SSE push channel as
 * `X-Iteam-Connection: <computerId>:<token>`.
 *
 * The daemon does NOT cache credentials on disk: the token is supplied via
 * `--connect-token` (or `ITEAM_CONNECT_TOKEN`) on every launch, and the
 * computer id is whatever the server tells us in the connect response. This
 * keeps the source of truth in one place (the server's storage) so we never
 * end up with a stale on-disk token fighting the live one.
 */
const connectToken: string = cliConnectToken;
let computerId: string | undefined;

const launcher = new AgentLauncher({
  serverUrl: baseUrl,
  report: reportAgentStatus,
  getCredentials: () => ({ computerId, connectToken })
});

/**
 * Watchdog state. zouk-daemon tracks lastHeartbeatAt and force-resets the
 * connection when the gap exceeds a threshold; we follow the same pattern.
 *
 * - `lastHeartbeatAt`: ms timestamp of the last successful heartbeat.
 * - `consecutiveFailures`: drives exponential backoff for the *next* attempt.
 * - `nextHeartbeatAt`: scheduled monotonic timestamp; the watchdog uses this
 *   to detect schedule slippage too (a busy event loop could starve the
 *   heartbeat timer even when nothing has actually failed).
 */
const HEARTBEAT_STALL_MULTIPLIER = 3;
const BACKOFF_BASE_MS = intervalMs;
const BACKOFF_MAX_MS = Math.max(intervalMs * 12, 60_000);
const WATCHDOG_TICK_MS = Math.max(1_000, Math.floor(intervalMs / 2));

let lastHeartbeatAt = Date.now();
let consecutiveFailures = 0;
let heartbeatInFlight: Promise<void> | null = null;
let pendingTimer: NodeJS.Timeout | null = null;
// Track whether we have already logged the "connected" line for the current
// connection. We re-print it after a heartbeat failure so the operator sees
// when the daemon recovers, but otherwise stay quiet during steady state.
let hasLoggedConnected = false;

async function heartbeat(): Promise<void> {
  const fingerprint = localComputerFingerprint();
  const computer = await requestJson<ConnectComputerResult>(`${baseUrl}/api/computers/connect`, {
    method: "POST",
    body: {
      token: connectToken,
      name,
      fingerprint,
      daemonVersion: DAEMON_VERSION,
      runtimes: detectRuntimes(),
      connectedAt: nowIso()
    }
  });
  if (computer.id !== computerId) {
    computerId = computer.id;
    console.log(`[${nowIso()}] connect token bound to ${computer.id} (token=${maskToken(connectToken)})`);
  }
  if (!hasLoggedConnected) {
    console.log(`[${nowIso()}] connected ${computer.name} (${computer.id}) auth=${computer.id}:${maskToken(connectToken)}`);
    hasLoggedConnected = true;
  }
  for (const agent of computer.launchAgents || []) {
    console.log(`[${nowIso()}] launch agent ${agent.id} (runtime=${agent.runtime}, model=${agent.model || "default"})`);
    launcher.launch(agent).catch((error: Error) => {
      console.error(`[${nowIso()}] launch failed for ${agent.id}: ${error.message}`);
      reportAgentStatus(agent.id, "launch_failed", { error: error.message }).catch(() => {});
    });
  }
  for (const agent of computer.stopAgents || []) {
    console.log(`[${nowIso()}] stop agent ${agent.id} (runtime=${agent.runtime})`);
    launcher.stop(agent).catch((error: Error) => {
      console.error(`[${nowIso()}] stop failed for ${agent.id}: ${error.message}`);
      reportAgentStatus(agent.id, "stop_failed", { error: error.message }).catch(() => {});
    });
  }
  for (const delivery of computer.deliveries || []) {
    const author = (delivery.author?.handle && `@${delivery.author.handle}`) || delivery.author?.name || "unknown";
    const target = delivery.target || delivery.message?.target || "?";
    const agent = delivery.agent;
    const agentLabel = agent ? `@${agent.handle || agent.name} (${agent.id}, runtime=${agent.runtime})` : delivery.agentId;
    console.log(`[${nowIso()}] deliver ${delivery.id} -> ${agentLabel} (from=${author}, target=${target})`);
    launcher.deliver(delivery).then(result => {
      console.log(`[${nowIso()}] deliver ${delivery.id} ok (text length=${(result.text || "").length})`);
      reportDeliveryResult(delivery.id, result).catch(err => {
        console.error(`[${nowIso()}] report ${delivery.id} (ok) failed: ${err.message}`);
      });
    }).catch((error: Error) => {
      console.error(`[${nowIso()}] deliver ${delivery.id} failed`);
      reportDeliveryResult(delivery.id, { ok: false, error: error.message }).catch(err => {
        console.error(`[${nowIso()}] report ${delivery.id} (failed) failed: ${err.message}`);
      });
    });
  }
  // Open the SSE push channel once we have credentials. ensurePushStream is
  // idempotent so repeat calls during heartbeat are harmless.
  ensurePushStream();
}

function backoffDelayMs(): number {
  if (consecutiveFailures <= 0) return intervalMs;
  // 2^n with jitter, capped at BACKOFF_MAX_MS.
  const exponent = Math.min(consecutiveFailures - 1, 6);
  const base = Math.min(BACKOFF_BASE_MS * Math.pow(2, exponent), BACKOFF_MAX_MS);
  const jitter = Math.floor(Math.random() * Math.min(base, 1_000));
  return base + jitter;
}

function scheduleNext(delayMs: number): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    runHeartbeat().catch(() => {});
  }, delayMs);
}

async function runHeartbeat(): Promise<void> {
  if (heartbeatInFlight) return heartbeatInFlight;
  heartbeatInFlight = (async () => {
    try {
      await heartbeat();
      lastHeartbeatAt = Date.now();
      consecutiveFailures = 0;
      scheduleNext(intervalMs);
    } catch (error) {
      const message = (error as Error).message;
      // Server rejected our token. Either it was never minted (invalid),
      // already consumed by another daemon, or the server's storage was
      // wiped. There is no on-disk cache to clear — just exit so the
      // operator can pass a fresh `--connect-token` from a new invite.
      if (/invalid connect(ion (credentials|secret)| token)/i.test(message)) {
        const peers = findPeerDaemonPids();
        const lines: string[] = [];
        lines.push(
          `[${nowIso()}] connect token ${maskToken(connectToken)} rejected by server. ` +
          `It may already be bound to another daemon, or the invite expired/was wiped. ` +
          `Generate a fresh invite via POST /api/computers/connect-command and re-run with ` +
          `the new --connect-token.`
        );
        lines.push(`[${nowIso()}] this daemon pid=${process.pid}`);
        const others = peers.filter(p => p.pid !== process.pid);
        if (others.length > 0) {
          lines.push(`[${nowIso()}] other agent-daemon process(es) on this host:`);
          for (const p of others) lines.push(`  pid=${p.pid}  ${p.cmd}`);
          lines.push(`  # if one of them holds your token, stop it before reusing:`);
          lines.push(`  kill ${others.map(p => p.pid).join(" ")}`);
        }
        for (const line of lines) console.error(line);
        process.exit(1);
      }
      consecutiveFailures++;
      hasLoggedConnected = false;
      const delay = backoffDelayMs();
      console.error(
        `[${nowIso()}] heartbeat failed (#${consecutiveFailures}, retry in ${delay}ms): ${message}`
      );
      scheduleNext(delay);
    } finally {
      heartbeatInFlight = null;
    }
  })();
  return heartbeatInFlight;
}

function watchdogTick(): void {
  const stalledFor = Date.now() - lastHeartbeatAt;
  const threshold = intervalMs * HEARTBEAT_STALL_MULTIPLIER;
  if (stalledFor < threshold) return;
  if (heartbeatInFlight) return; // request is already running, give it a chance
  console.warn(
    `[${nowIso()}] heartbeat watchdog: ${stalledFor}ms since last success (threshold ${threshold}ms), forcing reconnect`
  );
  const reset = launcher.resetStale();
  if (reset.removedChildren || reset.removedDrivers) {
    console.warn(
      `[${nowIso()}] watchdog reset stale launcher entries: children=${reset.removedChildren} drivers=${reset.removedDrivers}`
    );
  }
  // Pretend a heartbeat just happened so the watchdog does not re-fire on the
  // next tick while the forced reconnect is still in flight; runHeartbeat
  // will overwrite lastHeartbeatAt on success.
  lastHeartbeatAt = Date.now();
  scheduleNext(0);
}

function readArg(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function reportAgentStatus(agentId: string, status: string, details: Record<string, unknown>): Promise<unknown> {
  const headers = buildAuthHeader();
  if (status === "output") {
    return requestJson(`${baseUrl}/api/agents/${agentId}/runtime-event`, {
      method: "POST",
      headers,
      body: { event: "output", details, updatedAt: nowIso() }
    });
  }
  return requestJson(`${baseUrl}/api/agents/${agentId}/runtime-status`, {
    method: "POST",
    headers,
    body: { status, details, updatedAt: nowIso() }
  });
}

interface DeliveryReport {
  ok: boolean;
  text?: string;
  error?: string;
}

async function reportDeliveryResult(deliveryId: string, result: DeliveryReport): Promise<unknown> {
  // Retry with exponential backoff so a transient 401/network error doesn't
  // silently strand the delivery in `delivering` forever. After all retries
  // exhaust, the caller logs and the server-side stuck-delivery sweeper
  // (sweepStuckDeliveries) will eventually surface a system message.
  const delays = [0, 1000, 3000, 8000, 20000];
  let lastErr: Error | null = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
    try {
      return await requestJson(`${baseUrl}/api/deliveries/${deliveryId}/result`, {
        method: "POST",
        headers: buildAuthHeader(),
        body: result
      });
    } catch (err) {
      lastErr = err as Error;
      const auth = `${computerId || "<no-id>"}:${maskToken(connectToken)}`;
      console.error(
        `[${nowIso()}] report ${deliveryId} attempt ${i + 1}/${delays.length} ` +
        `failed (auth=${auth}): ${lastErr.message}`
      );
    }
  }
  throw lastErr || new Error("reportDeliveryResult exhausted retries");
}

function buildAuthHeader(): Record<string, string> {
  if (connectToken && computerId) {
    return { "x-iteam-connection": `${computerId}:${connectToken}` };
  }
  return {};
}

/** Mirror of core.ts maskToken — render a token suffix for diagnostics. */
function maskToken(token: string | undefined | null): string {
  if (!token) return "<none>";
  if (token.length <= 12) return `${token.slice(0, 2)}…${token.slice(-2)}(len=${token.length})`;
  return `${token.slice(0, 6)}…${token.slice(-4)}(len=${token.length})`;
}

interface PeerProcess { pid: number; cmd: string }

/**
 * Best-effort scan for other agent-daemon processes on the same host.
 * Used when the server reports a token-rebind conflict so we can name the
 * suspect PIDs and a ready-to-paste `kill` command in the operator log.
 *
 * We only consider processes whose argv directly invokes a daemon entry
 * file (`agent-daemon.ts` / `computer-daemon.ts`). Wrapper layers (bash,
 * timeout, npm, npx, the `iteam` launcher) carry the same words in their
 * argv but are not real daemons — listing them confuses the operator and
 * suggests killing their own shell. We also exclude our own ancestor
 * process chain via ppid traversal so the user-facing kill list contains
 * only legitimate competitor daemons.
 *
 * Implemented with `ps` rather than reading /proc to keep this portable
 * across darwin / linux. Returns [] if `ps` is unavailable or output cannot
 * be parsed — the caller falls back to a generic instruction.
 */
function findPeerDaemonPids(): PeerProcess[] {
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    interface PsRow { pid: number; ppid: number; cmd: string }
    const rows: PsRow[] = [];
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      rows.push({ pid, ppid, cmd: m[3] });
    }
    // Walk ppid links to mark every ancestor of the current process so we
    // never list the bash/timeout/npm wrappers that spawned us.
    const byPid = new Map<number, PsRow>();
    for (const r of rows) byPid.set(r.pid, r);
    const ancestors = new Set<number>();
    let cur: number | undefined = process.pid;
    while (cur !== undefined && cur > 1 && !ancestors.has(cur)) {
      ancestors.add(cur);
      cur = byPid.get(cur)?.ppid;
    }
    const DAEMON_RE = /(agent-daemon|computer-daemon)\.ts\b/;
    const peers: PeerProcess[] = [];
    for (const r of rows) {
      if (ancestors.has(r.pid)) continue;
      if (!DAEMON_RE.test(r.cmd)) continue;
      peers.push({ pid: r.pid, cmd: r.cmd });
    }
    return peers;
  } catch {
    return [];
  }
}

// (credential persistence removed: token is the permanent identity passed
// via --connect-token on every launch; storage of truth is the server.)

// ----------------------------------------------------------------------------
// SSE push consumer
//
// Once we have credentials we hold a long-lived SSE connection on
// /api/computers/:id/stream. The server pushes `launch` / `stop` / `delivery`
// events in real time so we no longer need to poll every 5 seconds for
// commands. The heartbeat still runs (much slower in steady state via
// scheduleNext) for liveness and for catching events we may have missed
// during a reconnect.

const PUSH_RETRY_BASE_MS = 1_000;
const PUSH_RETRY_MAX_MS = 30_000;
let pushController: AbortController | null = null;
let pushRetryTimer: NodeJS.Timeout | null = null;
let pushFailures = 0;

function ensurePushStream(): void {
  if (!connectToken || !computerId) return;
  if (pushController) return;
  if (pushRetryTimer) return;
  console.log(`[${nowIso()}] ensurePushStream: starting new SSE stream`);
  startPushStream().catch(() => scheduleReconnect());
}

async function startPushStream(): Promise<void> {
  if (!connectToken || !computerId) return;
  const myController = new AbortController();
  pushController = myController;
  const url = `${baseUrl}/api/computers/${encodeURIComponent(computerId)}/stream`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "x-iteam-connection": `${computerId}:${connectToken}`
      },
      signal: myController.signal
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") return;
    if (pushController === myController) pushController = null;
    throw error;
  }
  if (!response.ok || !response.body) {
    if (pushController === myController) pushController = null;
    throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
  }
  // Defensive: if a sibling stream was started concurrently and the global
  // `pushController` no longer matches us, abort ours immediately so we
  // don't leak a duplicate SSE subscriber on the server side.
  if (pushController !== myController) {
    console.warn(`[${nowIso()}] startPushStream: stale controller detected, aborting duplicate stream`);
    try { myController.abort(); } catch { /* ignore */ }
    return;
  }
  pushFailures = 0;
  console.log(`[${nowIso()}] push stream connected for ${computerId}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let exitReason = "unknown";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { exitReason = "reader-done"; break; }
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        handlePushEvent(rawEvent);
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    exitReason = `error:${(error as Error).name}:${(error as Error).message}`;
    if ((error as { name?: string }).name !== "AbortError") {
      console.error(`[${nowIso()}] push stream read error: ${(error as Error).message}`);
    }
  } finally {
    console.log(`[${nowIso()}] push stream exited (reason=${exitReason}, shuttingDown=${isShuttingDown})`);
    // Only clear the global pointer if it still references our controller —
    // a concurrent startPushStream may have replaced it, in which case we
    // must not nuke its handle. Always abort our own controller so the
    // underlying socket and the server-side subscriber are released.
    try { myController.abort(); } catch { /* ignore */ }
    if (pushController === myController) pushController = null;
    if (!isShuttingDown) scheduleReconnect();
  }
}

function handlePushEvent(rawEvent: string): void {
  let type = "message";
  let data = "";
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim();
  }
  if (!data) return;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  if (type === "launch") {
    const agent = payload as Agent;
    console.log(`[${nowIso()}] push: launch agent ${agent.id} (runtime=${agent.runtime}, model=${agent.model || "default"})`);
    launcher.launch(agent).catch((error: Error) => {
      console.error(`[${nowIso()}] launch failed for ${agent.id}: ${error.message}`);
      reportAgentStatus(agent.id, "launch_failed", { error: error.message }).catch(() => {});
    });
  } else if (type === "stop") {
    const agent = payload as Agent;
    console.log(`[${nowIso()}] push: stop agent ${agent.id} (runtime=${agent.runtime})`);
    launcher.stop(agent).catch((error: Error) => {
      console.error(`[${nowIso()}] stop failed for ${agent.id}: ${error.message}`);
      reportAgentStatus(agent.id, "stop_failed", { error: error.message }).catch(() => {});
    });
  } else if (type === "delivery") {
    const delivery = payload as DeliveryWithContext;
    const author = (delivery.author?.handle && `@${delivery.author.handle}`) || delivery.author?.name || "unknown";
    const target = delivery.target || delivery.message?.target || "?";
    const agent = delivery.agent;
    const agentLabel = agent ? `@${agent.handle || agent.name} (${agent.id}, runtime=${agent.runtime})` : delivery.agentId;
    console.log(`[${nowIso()}] push: deliver ${delivery.id} -> ${agentLabel} (from=${author}, target=${target})`);
    launcher.deliver(delivery).then(result => {
      console.log(`[${nowIso()}] deliver ${delivery.id} ok (text length=${(result.text || "").length})`);
      reportDeliveryResult(delivery.id, result).catch(err => {
        console.error(`[${nowIso()}] report ${delivery.id} (ok) failed: ${err.message}`);
      });
    }).catch((error: Error) => {
      console.error(`[${nowIso()}] deliver ${delivery.id} failed: ${error.message}`);
      reportDeliveryResult(delivery.id, { ok: false, error: error.message }).catch(err => {
        console.error(`[${nowIso()}] report ${delivery.id} (failed) failed: ${err.message}`);
      });
    });
  }
  // ping / ready are keepalives, nothing to do
}

function scheduleReconnect(): void {
  if (isShuttingDown) return;
  pushFailures += 1;
  const exponent = Math.min(pushFailures, 5);
  const base = Math.min(PUSH_RETRY_BASE_MS * Math.pow(2, exponent - 1), PUSH_RETRY_MAX_MS);
  const jitter = Math.floor(Math.random() * Math.min(base, 1_000));
  const delay = base + jitter;
  console.warn(`[${nowIso()}] push stream disconnected (#${pushFailures}); reconnecting in ${delay}ms`);
  if (pushRetryTimer) clearTimeout(pushRetryTimer);
  pushRetryTimer = setTimeout(() => {
    pushRetryTimer = null;
    startPushStream().catch(() => scheduleReconnect());
  }, delay);
}

let isShuttingDown = false;
function closePushStream(): void {
  isShuttingDown = true;
  if (pushRetryTimer) {
    clearTimeout(pushRetryTimer);
    pushRetryTimer = null;
  }
  if (pushController) {
    pushController.abort();
    pushController = null;
  }
}

await runHeartbeat();
const watchdog = setInterval(watchdogTick, WATCHDOG_TICK_MS);

function shutdown(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  clearInterval(watchdog);
  closePushStream();
}
process.once("SIGINT", () => { shutdown(); process.exit(0); });
process.once("SIGTERM", () => { shutdown(); process.exit(0); });

function printUsage(reason: string): void {
  console.error(`agent-daemon: ${reason}`);
  console.error("");
  console.error("Usage:");
  console.error("  iteam agent-daemon --server-url <url> --connect-token <token> [--name <hostname>] [--interval-ms <ms>]");
  console.error("");
  console.error("Environment fallbacks: ITEAM_SERVER_URL, ITEAM_CONNECT_TOKEN");
  console.error("");
  console.error("--connect-token is the computer's permanent identity. The server issues");
  console.error("it once when you generate an invite, binds it to a brand-new computer on");
  console.error("first connect, and reuses it forever after. Pass the same token on every");
  console.error("launch.");
  console.error("");
  console.error("To obtain a token, ask the server for an invite:");
  console.error("  curl -X POST <server-url>/api/computers/connect-command \\");
  console.error("    -H 'content-type: application/json' \\");
  console.error("    -d '{\"serverUrl\":\"<server-url>\"}'");
  console.error("");
  console.error("The response includes a ready-to-run `command` field you can paste.");
}
