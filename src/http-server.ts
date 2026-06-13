// HTTP transport layer — translates wire protocol to IteamCore method calls.
//
// Mirrors the split in zouk-daemon between connection.ts (transport) and
// core.ts (domain). This file owns no business state; every route just parses
// the request, calls into IteamCore, and serialises the result.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonBody, sendJson, sendText } from "./lib.js";
import { HttpError, type IteamCore } from "./core.js";
import type { StoreEvent } from "./types.js";

// Locate <pkg>/dist regardless of whether this file runs from source
// (src/http-server.ts → pkg root one level up) or from the tsup bundle
// (dist/cli/server.mjs → pkg root two levels up). Walk upward looking for
// the package.json so both layouts resolve correctly.
const DEFAULT_STATIC_DIR = resolveDefaultStaticDir();

function resolveDefaultStaticDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "package.json"))) {
      return resolve(dir, "dist");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to the historical behaviour if package.json isn't found.
  return resolve(here, "..", "dist");
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

export interface HttpServerOptions {
  core: IteamCore;
  port: number;
  host?: string;
  /** When false, GET requests outside /api/ return 404. Default: true. */
  serveWeb?: boolean;
  /** Override the directory used to serve the web bundle. Default: <pkg>/dist. */
  webRoot?: string;
}

export interface RunningHttpServer {
  server: Server;
  close(): Promise<void>;
  /** Resolved configuration, useful for startup logging. */
  serveWeb: boolean;
  webRoot: string | null;
}

export function startHttpServer(options: HttpServerOptions): RunningHttpServer {
  const { core, port, host = "127.0.0.1" } = options;
  const serveWeb = options.serveWeb ?? true;
  const webRoot = serveWeb ? resolve(options.webRoot || DEFAULT_STATIC_DIR) : null;
  const sseClients = new Set<ServerResponse>();

  if (serveWeb && webRoot && !existsSync(webRoot)) {
    console.warn(
      `[http] serveWeb=true but webRoot not found: ${webRoot}. ` +
      `Run \`npm run build\` first, or pass --no-serve-web to disable static hosting.`
    );
  }

  const unsubscribe = core.subscribe((event: StoreEvent) => {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) client.write(payload);
  });

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const method = req.method || "GET";
    const pathname = (req.url || "/").split("?")[0];
    res.on("finish", () => {
      // Routine 2xx requests are noise (web UI polling, agent-daemon
      // heartbeats, runtime-status/-event callbacks, SSE handshakes).
      // Only log non-2xx so problems still surface.
      if (res.statusCode >= 200 && res.statusCode < 300) return;
      const ms = Date.now() - startedAt;
      console.log(`[http] ${method} ${pathname} -> ${res.statusCode} (${ms}ms)`);
    });
    try {
      await route(core, sseClients, req, res, { serveWeb, webRoot });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      console.error(`[http] ${method} ${pathname} crashed: ${(error as Error).message}`);
      sendJson(res, 500, { error: (error as Error).message });
    }
  });

  server.listen(port, host);

  // Safety net: every 30s mark any delivery stuck in `delivering` longer than
  // 10 minutes as failed and post a system message. Covers daemon crashes,
  // result-callback 401s, runtime hangs past their own timeout, etc.
  const stuckThresholdMs = 10 * 60 * 1000;
  const sweepTimer = setInterval(() => {
    try { core.sweepStuckDeliveries(stuckThresholdMs); } catch (err) {
      console.error(`[http] sweepStuckDeliveries error: ${(err as Error).message}`);
    }
  }, 30_000);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  const scheduleTimer = setInterval(() => {
    try {
      const ran = core.runDueScheduledTasks();
      if (ran > 0) console.log(`[http] ran ${ran} scheduled task(s)`);
    } catch (err) {
      console.error(`[http] runDueScheduledTasks error: ${(err as Error).message}`);
    }
  }, Number(process.env.ITEAM_SCHEDULER_INTERVAL_MS || "1000"));
  if (typeof scheduleTimer.unref === "function") scheduleTimer.unref();

  return {
    server,
    serveWeb,
    webRoot,
    async close() {
      clearInterval(sweepTimer);
      clearInterval(scheduleTimer);
      unsubscribe();
      for (const client of sseClients) client.end();
      sseClients.clear();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  };
}

interface StaticConfig {
  serveWeb: boolean;
  webRoot: string | null;
}

async function route(
  core: IteamCore,
  sseClients: Set<ServerResponse>,
  req: IncomingMessage,
  res: ServerResponse,
  staticConfig: StaticConfig
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, core.health());
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive"
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  const computerStream = url.pathname.match(/^\/api\/computers\/([^/]+)\/stream$/);
  if (req.method === "GET" && computerStream) {
    const computerId = decodeURIComponent(computerStream[1]);
    // EventSource cannot set custom headers in browsers, but our agent-daemon
    // is Node and uses fetch with headers. We accept either form for symmetry
    // with the rest of the daemon-protected routes.
    const credentials = readComputerCredentials(req, url, computerId);
    core.authenticateComputer(credentials.computerId, credentials.token);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, computerId })}\n\n`);

    const send = (event: { type: string; payload: unknown }): void => {
      try {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      } catch {
        // socket may have already closed; cleanup runs in `close` handler
      }
    };
    // Newest SSE wins: subscribeComputerPush evicts any prior subscribers
    // for this computer by closing their underlying response. This makes
    // duplicate-delivery bugs caused by daemon-side reconnect races
    // impossible regardless of the client-side fix.
    const unsubscribe = core.subscribeComputerPush(computerId, send, () => {
      try { res.end(); } catch { /* ignore */ }
    });
    const pingTimer = setInterval(() => {
      send({ type: "ping", payload: { now: new Date().toISOString() } });
    }, 30_000);
    req.on("close", () => {
      clearInterval(pingTimer);
      unsubscribe();
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, core.snapshot());
  if (req.method === "GET" && url.pathname === "/api/channels") return sendJson(res, 200, core.listChannels());
  if (req.method === "GET" && url.pathname === "/api/agents") return sendJson(res, 200, core.listAgents());
  if (req.method === "GET" && url.pathname === "/api/computers") return sendJson(res, 200, core.listComputers());
  if (req.method === "GET" && url.pathname === "/api/humans") return sendJson(res, 200, core.listHumans());
  if (req.method === "GET" && url.pathname === "/api/deliveries") return sendJson(res, 200, core.listDeliveries());
  if (req.method === "GET" && url.pathname === "/api/pending-connections") {
    return sendJson(res, 200, core.listPendingConnections());
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    return sendJson(res, 200, core.listTasks({
      target: url.searchParams.get("target"),
      status: url.searchParams.get("status")
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/scheduled-tasks") {
    return sendJson(res, 200, core.listScheduledTasks({
      target: url.searchParams.get("target"),
      status: url.searchParams.get("status"),
      agentId: url.searchParams.get("agentId")
    }));
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/messages/channel/")) {
    const channelId = decodeURIComponent(url.pathname.slice("/api/messages/channel/".length));
    return sendJson(res, 200, core.listMessagesByChannel({
      channelId,
      limit: url.searchParams.get("limit"),
      before: url.searchParams.get("before")
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/messages") {
    return sendJson(res, 200, core.listMessagesByTarget({
      target: url.searchParams.get("target") ?? undefined,
      limit: url.searchParams.get("limit"),
      before: url.searchParams.get("before")
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/channels") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createChannel(body));
  }

  const agentDm = url.pathname.match(/^\/api\/direct-messages\/agents\/([^/]+)$/);
  if (req.method === "POST" && agentDm) {
    const agentId = decodeURIComponent(agentDm[1]);
    return sendJson(res, 201, core.ensureAgentDmChannel(agentId));
  }

  const channelPatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
  if (req.method === "PATCH" && channelPatch) {
    const body = await parseJsonBody<any>(req);
    const channelId = decodeURIComponent(channelPatch[1]);
    return sendJson(res, 200, core.patchChannel(channelId, body));
  }

  if (req.method === "POST" && url.pathname === "/api/computers/connect-command") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createConnectInvite(body, `http://${req.headers.host}`));
  }

  if (req.method === "POST" && url.pathname === "/api/computers/connect") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 200, core.connectComputer(body));
  }

  if (req.method === "POST" && url.pathname === "/api/computers/register") {
    return sendJson(res, 410, { error: "Use /api/computers/connect with a connect token" });
  }

  const computerDelete = url.pathname.match(/^\/api\/computers\/([^/]+)$/);
  if (req.method === "DELETE" && computerDelete) {
    const id = decodeURIComponent(computerDelete[1]);
    core.deleteComputer(id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/agents") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createAgent(body));
  }

  const agentPatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (req.method === "PATCH" && agentPatch) {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 200, core.patchAgent(agentPatch[1], body));
  }

  const humanPatch = url.pathname.match(/^\/api\/humans\/([^/]+)$/);
  if (req.method === "PATCH" && humanPatch) {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 200, core.patchHuman(decodeURIComponent(humanPatch[1]), body));
  }

  const runtimeStatus = url.pathname.match(/^\/api\/agents\/([^/]+)\/runtime-status$/);
  if (req.method === "POST" && runtimeStatus) {
    requireComputerAuth(core, req, runtimeStatus[1], "agent");
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 200, core.reportRuntimeStatus(runtimeStatus[1], body));
  }

  const runtimeEvent = url.pathname.match(/^\/api\/agents\/([^/]+)\/runtime-event$/);
  if (req.method === "POST" && runtimeEvent) {
    requireComputerAuth(core, req, runtimeEvent[1], "agent");
    const body = await parseJsonBody<any>(req);
    core.recordRuntimeEvent(runtimeEvent[1], body);
    return sendJson(res, 200, { ok: true });
  }

  const agentAction = url.pathname.match(/^\/api\/agents\/([^/]+)\/(start|stop)$/);
  if (req.method === "POST" && agentAction) {
    const [, agentId, action] = agentAction;
    return sendJson(res, 200, core.setAgentDesiredStatus(agentId, action as "start" | "stop"));
  }

  if (req.method === "POST" && url.pathname === "/api/messages") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createMessage(body));
  }

  const deliveryResult = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/result$/);
  if (req.method === "POST" && deliveryResult) {
    requireComputerAuth(core, req, deliveryResult[1], "delivery");
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 200, core.applyDeliveryResult(deliveryResult[1], body));
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createTask(body));
  }

  const taskPatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === "PATCH" && taskPatch) {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 200, core.patchTask(taskPatch[1], body));
  }

  if (req.method === "POST" && url.pathname === "/api/scheduled-tasks") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createScheduledTask(body));
  }

  const scheduledTask = url.pathname.match(/^\/api\/scheduled-tasks\/([^/]+)$/);
  if (scheduledTask && req.method === "PATCH") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 200, core.patchScheduledTask(scheduledTask[1], body));
  }
  if (scheduledTask && req.method === "DELETE") {
    core.deleteScheduledTask(scheduledTask[1]);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    if (!staticConfig.serveWeb || !staticConfig.webRoot) {
      return sendText(res, 404, "not found");
    }
    return serveStatic(res, url.pathname, staticConfig.webRoot);
  }

  sendText(res, 404, "not found");
}

async function serveStatic(res: ServerResponse, pathname: string, root: string): Promise<void> {
  const decoded = decodeURIComponent(pathname);
  const safeRelative = normalize(decoded).replace(/^([./\\]+)/, "");
  const candidate = safeRelative ? resolve(root, safeRelative) : root;
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return sendIndexHtml(res, root);
  }
  try {
    const info = await stat(candidate);
    if (info.isFile()) return sendFile(res, candidate);
  } catch {
    // fall through
  }
  return sendIndexHtml(res, root);
}

async function sendFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const data = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": filePath.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache"
    });
    res.end(data);
  } catch {
    sendText(res, 404, "not found");
  }
}

async function sendIndexHtml(res: ServerResponse, root: string): Promise<void> {
  try {
    const data = await readFile(resolve(root, "index.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache"
    });
    res.end(data);
  } catch {
    sendText(res, 404, "web build not found; run `npm run build`");
  }
}

/**
 * Validates the `X-Iteam-Connection: <computerId>:<token>` header and verifies
 * that the targeted resource (agent or delivery) actually belongs to that
 * computer. Throws HttpError(401/403) on failure so the route handler aborts
 * before mutating state.
 */
function requireComputerAuth(
  core: IteamCore,
  req: IncomingMessage,
  resourceId: string,
  kind: "agent" | "delivery"
): void {
  const { computerId, token } = parseConnectionHeader(req);
  core.authenticateComputer(computerId, token);

  const state = core.snapshot();
  if (kind === "agent") {
    const agent = (state.agents || []).find(a => a.id === resourceId);
    if (!agent) throw new HttpError(404, "agent not found");
    if (agent.computerId !== computerId) {
      throw new HttpError(403, "agent does not belong to this computer");
    }
  } else {
    const delivery = (state.deliveries || []).find(d => d.id === resourceId);
    if (!delivery) throw new HttpError(404, "delivery not found");
    if (delivery.computerId !== computerId) {
      throw new HttpError(403, "delivery does not belong to this computer");
    }
  }
}

/**
 * Resolve `<computerId>:<token>` from the request — header preferred, falling
 * back to `?token=` query string for EventSource clients that cannot set
 * custom headers. The expected computerId comes from the URL path so the
 * caller does not have to guess.
 */
function readComputerCredentials(
  req: IncomingMessage,
  url: URL,
  expectedComputerId: string
): { computerId: string; token: string } {
  const header = req.headers["x-iteam-connection"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw) {
    const colonAt = raw.indexOf(":");
    if (colonAt <= 0) throw new HttpError(401, "X-Iteam-Connection format must be <computerId>:<token>");
    return { computerId: raw.slice(0, colonAt), token: raw.slice(colonAt + 1) };
  }
  const queryToken = url.searchParams.get("token");
  if (queryToken) return { computerId: expectedComputerId, token: queryToken };
  throw new HttpError(401, "X-Iteam-Connection header or ?token= required");
}

function parseConnectionHeader(req: IncomingMessage): { computerId: string; token: string } {
  const header = req.headers["x-iteam-connection"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new HttpError(401, "X-Iteam-Connection header required");
  const colonAt = raw.indexOf(":");
  if (colonAt <= 0) throw new HttpError(401, "X-Iteam-Connection format must be <computerId>:<token>");
  return { computerId: raw.slice(0, colonAt), token: raw.slice(colonAt + 1) };
}
