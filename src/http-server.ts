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
  externalBotRuntime?: {
    sync(provider: string, spaceId: string): void | Promise<void>;
    remove(provider: string, spaceId: string): void | Promise<void>;
  };
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
      await route(core, sseClients, req, res, { serveWeb, webRoot, externalBotRuntime: options.externalBotRuntime });
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
      // server.close() only stops accepting new connections; keep-alive sockets
      // (e.g. SSE clients, iteam web/agent) can hold it open forever. Force
      // existing sockets shut so shutdown actually completes.
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  };
}

interface StaticConfig {
  serveWeb: boolean;
  webRoot: string | null;
  externalBotRuntime?: HttpServerOptions["externalBotRuntime"];
}

async function route(
  core: IteamCore,
  sseClients: Set<ServerResponse>,
  req: IncomingMessage,
  res: ServerResponse,
  staticConfig: StaticConfig
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const spaceId = resolveAuthenticatedSpace(core, req, resolveSpaceIdHeader(req, url));

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
    if (credentials.computerId !== computerId) {
      throw new HttpError(403, "connection credentials do not match the requested computer");
    }

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

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, core.snapshotForSpace(spaceId));
  }
  if (req.method === "GET" && url.pathname === "/api/spaces") return sendJson(res, 200, core.listSpaces());
  if (req.method === "POST" && url.pathname === "/api/spaces") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createSpace(body));
  }
  const spaceDelete = url.pathname.match(/^\/api\/spaces\/([^/]+)$/);
  if (req.method === "DELETE" && spaceDelete) {
    const targetSpaceId = decodeURIComponent(spaceDelete[1]);
    resolveAuthenticatedSpace(core, req, targetSpaceId);
    core.deleteSpace(targetSpaceId);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/channels") return sendJson(res, 200, core.listChannels(spaceId));
  if (req.method === "GET" && url.pathname === "/api/agents") return sendJson(res, 200, core.listAgents(spaceId));
  if (req.method === "GET" && url.pathname === "/api/computers") return sendJson(res, 200, core.listComputers(spaceId));
  if (req.method === "GET" && url.pathname === "/api/humans") return sendJson(res, 200, core.listHumans());
  if (req.method === "GET" && url.pathname === "/api/deliveries") return sendJson(res, 200, core.listDeliveries(spaceId));
  if (req.method === "GET" && url.pathname === "/api/delivery-events") {
    return sendJson(res, 200, core.listDeliveryEvents({
      target: url.searchParams.get("target"),
      deliveryId: url.searchParams.get("deliveryId"),
      limit: url.searchParams.get("limit"),
      spaceId
    }));
  }
  if (req.method === "GET" && url.pathname === "/api/ingress/pairing-codes") return sendJson(res, 200, core.listIngressPairings(spaceId));
  if (req.method === "GET" && url.pathname === "/api/ingress/policies") return sendJson(res, 200, core.listIngressPolicies(spaceId));
  if (req.method === "GET" && url.pathname === "/api/external/bot-configs") return sendJson(res, 200, core.listExternalBotConfigs(spaceId));
  if (req.method === "GET" && url.pathname === "/api/external/bot-bindings") return sendJson(res, 200, core.listExternalBotBindings(spaceId));
  if (req.method === "GET" && url.pathname === "/api/external/message-links") return sendJson(res, 200, core.listExternalMessageLinks(spaceId));
  if (req.method === "GET" && url.pathname === "/api/pending-connections") {
    return sendJson(res, 200, core.listPendingConnections(spaceId));
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    return sendJson(res, 200, core.listTasks({
      target: url.searchParams.get("target"),
      status: url.searchParams.get("status"),
      assigneeId: url.searchParams.get("assigneeId"),
      createdBy: url.searchParams.get("createdBy"),
      q: url.searchParams.get("q"),
      includeDone: parseBooleanQuery(url.searchParams.get("includeDone")),
      spaceId
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/scheduled-tasks") {
    return sendJson(res, 200, core.listScheduledTasks({
      target: url.searchParams.get("target"),
      status: url.searchParams.get("status"),
      agentId: url.searchParams.get("agentId"),
      spaceId
    }));
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/messages/channel/")) {
    const channelId = decodeURIComponent(url.pathname.slice("/api/messages/channel/".length));
    return sendJson(res, 200, core.listMessagesByChannel({
      channelId,
      limit: url.searchParams.get("limit"),
      before: url.searchParams.get("before"),
      spaceId
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/messages") {
    return sendJson(res, 200, core.listMessagesByTarget({
      target: url.searchParams.get("target") ?? undefined,
      limit: url.searchParams.get("limit"),
      before: url.searchParams.get("before"),
      spaceId
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/channels") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createChannel({
      ...body,
      spaceId: resolveAuthenticatedSpace(core, req, body?.spaceId || spaceId)
    }));
  }

  const agentDm = url.pathname.match(/^\/api\/direct-messages\/agents\/([^/]+)$/);
  if (req.method === "POST" && agentDm) {
    const agentId = decodeURIComponent(agentDm[1]);
    requireResourceSpaceIfAuthenticated(core, req, "agent", agentId);
    return sendJson(res, 201, core.ensureAgentDmChannel(agentId));
  }

  const channelPatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
  if (req.method === "PATCH" && channelPatch) {
    const body = await parseJsonBody<any>(req);
    const channelId = decodeURIComponent(channelPatch[1]);
    requireResourceSpaceIfAuthenticated(core, req, "channel", channelId);
    return sendJson(res, 200, core.patchChannel(channelId, body));
  }
  if (req.method === "DELETE" && channelPatch) {
    const channelId = decodeURIComponent(channelPatch[1]);
    requireResourceSpaceIfAuthenticated(core, req, "channel", channelId);
    const channel = core.deleteChannel(channelId);
    return sendJson(res, 200, { ok: true, channelId: channel.id });
  }

  if (req.method === "POST" && url.pathname === "/api/computers/connect-command") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createConnectInvite({
      ...body,
      spaceId: resolveAuthenticatedSpace(core, req, body?.spaceId || spaceId)
    }, `http://${req.headers.host}`));
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
    requireResourceSpaceIfAuthenticated(core, req, "computer", id);
    core.deleteComputer(id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/agents") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createAgent({
      ...body,
      spaceId: resolveAuthenticatedSpace(core, req, body?.spaceId || spaceId)
    }));
  }

  const agentPatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (req.method === "PATCH" && agentPatch) {
    const body = await parseJsonBody<any>(req);
    requireResourceSpaceIfAuthenticated(core, req, "agent", agentPatch[1]);
    return sendJson(res, 200, core.patchAgent(agentPatch[1], body));
  }
  if (req.method === "DELETE" && agentPatch) {
    requireResourceSpaceIfAuthenticated(core, req, "agent", agentPatch[1]);
    const agent = core.deleteAgent(decodeURIComponent(agentPatch[1]));
    return sendJson(res, 200, { ok: true, agentId: agent.id });
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
    requireResourceSpaceIfAuthenticated(core, req, "agent", agentId);
    return sendJson(res, 200, core.setAgentDesiredStatus(agentId, action as "start" | "stop"));
  }

  if (req.method === "POST" && url.pathname === "/api/messages") {
    const body = await parseJsonBody<any>(req);
    const messageSpaceId = resolveAuthenticatedSpace(core, req, body?.spaceId || spaceId);
    requireAgentAuthorAuthIfNeeded(core, req, body?.authorId);
    return sendJson(res, 201, core.createMessage({ ...body, spaceId: messageSpaceId }));
  }

  const deliveryResult = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/result$/);
  if (req.method === "POST" && deliveryResult) {
    requireComputerAuth(core, req, deliveryResult[1], "delivery");
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 200, core.applyDeliveryResult(deliveryResult[1], body));
  }

  const deliveryProgress = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/progress$/);
  if (req.method === "POST" && deliveryProgress) {
    requireComputerAuth(core, req, deliveryProgress[1], "delivery");
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.applyDeliveryProgress(deliveryProgress[1], body));
  }

  const deliveryRuntimeState = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/runtime-state$/);
  if (req.method === "POST" && deliveryRuntimeState) {
    requireComputerAuth(core, req, deliveryRuntimeState[1], "delivery");
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 200, core.applyDeliveryRuntimeState(deliveryRuntimeState[1], body));
  }

  const deliveryEvent = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/events$/);
  if (req.method === "POST" && deliveryEvent) {
    requireComputerAuth(core, req, deliveryEvent[1], "delivery");
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createDeliveryEvent({
      ...body,
      deliveryId: deliveryEvent[1]
    }));
  }

  const deliveryHelpNeeded = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/help-needed$/);
  if (req.method === "POST" && deliveryHelpNeeded) {
    requireComputerAuth(core, req, deliveryHelpNeeded[1], "delivery");
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 200, core.applyDeliveryHelpNeeded(deliveryHelpNeeded[1], body));
  }

  const deliveryCancel = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/cancel$/);
  if (req.method === "POST" && deliveryCancel) {
    const body = await parseJsonBody<any>(req);
    requireResourceSpaceIfAuthenticated(core, req, "delivery", deliveryCancel[1]);
    return sendJson(res, 200, core.cancelDelivery(deliveryCancel[1], body?.reason));
  }

  if (req.method === "POST" && url.pathname === "/api/ingress/pairing-codes") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createIngressPairing({
      ...body,
      spaceId: resolveAuthenticatedSpace(core, req, body?.spaceId || spaceId)
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/ingress/pair") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.pairIngress(body));
  }

  if (req.method === "POST" && url.pathname === "/api/ingress/messages") {
    const body = await parseJsonBody<any>(req);
    const header = String(req.headers["x-iteam-ingress"] || "");
    const [policyId, token] = header.includes(":") ? header.split(/:(.*)/s).filter(Boolean) : [];
    return sendJson(res, 201, core.createIngressMessage({
      ...body,
      policyId: body.policyId || policyId,
      token: body.token || token
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/external/bot-bindings") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.upsertExternalBotBinding({
      ...body,
      spaceId: resolveAuthenticatedSpace(core, req, body?.spaceId || spaceId)
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/external/bot-configs") {
    const body = await parseJsonBody<any>(req);
    const saved = core.upsertExternalBotConfig({
      ...body,
      spaceId: resolveAuthenticatedSpace(core, req, body?.spaceId || spaceId)
    });
    void Promise.resolve(staticConfig.externalBotRuntime?.sync(saved.provider, saved.spaceId)).catch(error => {
      console.error(`[http] external bot runtime sync failed for ${saved.provider}@${saved.spaceId}: ${(error as Error).message}`);
    });
    return sendJson(res, 201, { ...saved, appSecret: saved.appSecret ? "configured" : null });
  }

  const externalBotConfigDelete = url.pathname.match(/^\/api\/external\/bot-configs\/([^/]+)$/);
  if (req.method === "DELETE" && externalBotConfigDelete) {
    const result = core.deleteExternalBotConfig(decodeURIComponent(externalBotConfigDelete[1]), spaceId);
    void Promise.resolve(staticConfig.externalBotRuntime?.remove(result.provider, result.spaceId)).catch(error => {
      console.error(`[http] external bot runtime remove failed for ${result.provider}@${result.spaceId}: ${(error as Error).message}`);
    });
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/external/routed-messages") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createExternalRoutedMessage({
      ...body,
      spaceId: resolveAuthenticatedSpace(core, req, body?.spaceId || spaceId)
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/external/message-links/backfill") {
    const body = await parseJsonBody<any>(req);
    requireResourceSpaceIfAuthenticated(core, req, "message", body.rootMessageId);
    return sendJson(res, 200, core.backfillExternalMessageLinks(body.rootMessageId));
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createTask({
      ...body,
      spaceId: resolveAuthenticatedSpace(core, req, body?.spaceId || spaceId)
    }));
  }

  const taskPatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === "PATCH" && taskPatch) {
    const body = await parseJsonBody<any>(req);
    requireResourceSpaceIfAuthenticated(core, req, "task", taskPatch[1]);
    return sendJson(res, 200, core.patchTask(taskPatch[1], body));
  }

  if (req.method === "POST" && url.pathname === "/api/scheduled-tasks") {
    const body = await parseJsonBody<any>(req);
    return sendJson(res, 201, core.createScheduledTask({
      ...body,
      spaceId: resolveAuthenticatedSpace(core, req, body?.spaceId || spaceId)
    }));
  }

  const scheduledTask = url.pathname.match(/^\/api\/scheduled-tasks\/([^/]+)$/);
  if (scheduledTask && req.method === "PATCH") {
    const body = await parseJsonBody<any>(req);
    requireResourceSpaceIfAuthenticated(core, req, "scheduledTask", scheduledTask[1]);
    return sendJson(res, 200, core.patchScheduledTask(scheduledTask[1], body));
  }
  if (scheduledTask && req.method === "DELETE") {
    requireResourceSpaceIfAuthenticated(core, req, "scheduledTask", scheduledTask[1]);
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

function parseBooleanQuery(value: string | null): boolean {
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Extract the caller's active space. Priority: `spaceId` query -> body
 * (handled per-route) -> `X-Iteam-Space` header. Returns null when unset so
 * the core defaults to `space_default`.
 */
function resolveSpaceIdHeader(req: IncomingMessage, url: URL): string | null {
  const query = url.searchParams.get("spaceId");
  if (query && query.trim()) return query.trim();
  const header = req.headers["x-iteam-space"];
  const raw = Array.isArray(header) ? header[0] : header;
  return raw && String(raw).trim() ? String(raw).trim() : null;
}

function parseConnectionHeader(req: IncomingMessage): { computerId: string; token: string } {
  const header = req.headers["x-iteam-connection"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new HttpError(401, "X-Iteam-Connection header required");
  const colonAt = raw.indexOf(":");
  if (colonAt <= 0) throw new HttpError(401, "X-Iteam-Connection format must be <computerId>:<token>");
  return { computerId: raw.slice(0, colonAt), token: raw.slice(colonAt + 1) };
}

function resolveAuthenticatedSpace(
  core: IteamCore,
  req: IncomingMessage,
  spaceId: string | null | undefined
): string | null {
  const agentCredentials = readAgentCredentialsIfPresent(req);
  if (agentCredentials) {
    const agent = core.authenticateAgent(
      agentCredentials.computerId,
      agentCredentials.agentId,
      agentCredentials.token
    );
    if (spaceId && agent.spaceId !== spaceId) {
      throw new HttpError(403, "agent cannot access a different space");
    }
    return agent.spaceId;
  }
  const header = req.headers["x-iteam-connection"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return spaceId || null;
  const { computerId, token } = parseConnectionHeader(req);
  const computer = core.authenticateComputer(computerId, token);
  if (spaceId && computer.spaceId !== spaceId) {
    throw new HttpError(403, "computer cannot access a different space");
  }
  return computer.spaceId;
}

function requireAgentAuthorAuthIfNeeded(
  core: IteamCore,
  req: IncomingMessage,
  authorId: string | null | undefined
): void {
  if (!authorId) return;
  const agent = (core.snapshot().agents || []).find(item => item.id === authorId);
  if (!agent) return;
  const agentCredentials = readAgentCredentialsIfPresent(req);
  if (agentCredentials) {
    const authenticatedAgent = core.authenticateAgent(
      agentCredentials.computerId,
      agentCredentials.agentId,
      agentCredentials.token
    );
    if (authenticatedAgent.id !== authorId) {
      throw new HttpError(403, "agent cannot impersonate another agent");
    }
    return;
  }
  throw new HttpError(401, "X-Iteam-Agent-Connection header required");
}

type SpaceOwnedResourceKind =
  | "channel"
  | "computer"
  | "agent"
  | "delivery"
  | "task"
  | "scheduledTask"
  | "message";

function requireResourceSpaceIfAuthenticated(
  core: IteamCore,
  req: IncomingMessage,
  kind: SpaceOwnedResourceKind,
  resourceId: string
): void {
  const agentCredentials = readAgentCredentialsIfPresent(req);
  if (agentCredentials) {
    const agent = core.authenticateAgent(
      agentCredentials.computerId,
      agentCredentials.agentId,
      agentCredentials.token
    );
    requireResourceSpace(core, kind, resourceId, agent.spaceId);
    return;
  }
  const header = req.headers["x-iteam-connection"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return;
  const { computerId, token } = parseConnectionHeader(req);
  const computer = core.authenticateComputer(computerId, token);
  requireResourceSpace(core, kind, resourceId, computer.spaceId);
}

function requireResourceSpace(
  core: IteamCore,
  kind: SpaceOwnedResourceKind,
  resourceId: string,
  expectedSpaceId: string
): void {
  const state = core.snapshot();
  const collection =
    kind === "channel" ? state.channels :
    kind === "computer" ? state.computers :
    kind === "agent" ? state.agents :
    kind === "delivery" ? state.deliveries :
    kind === "task" ? state.tasks :
    kind === "scheduledTask" ? state.scheduledTasks :
    state.messages;
  const resource = collection.find(item => item.id === resourceId);
  if (!resource) throw new HttpError(404, `${kind} not found`);
  if (resource.spaceId !== expectedSpaceId) {
    throw new HttpError(403, `${kind} belongs to a different space`);
  }
}

function readAgentCredentialsIfPresent(
  req: IncomingMessage
): { computerId: string; agentId: string; token: string } | null {
  const header = req.headers["x-iteam-agent-connection"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const firstColon = raw.indexOf(":");
  const secondColon = raw.indexOf(":", firstColon + 1);
  if (firstColon <= 0 || secondColon <= firstColon + 1) {
    throw new HttpError(
      401,
      "X-Iteam-Agent-Connection format must be <computerId>:<agentId>:<token>"
    );
  }
  return {
    computerId: raw.slice(0, firstColon),
    agentId: raw.slice(firstColon + 1, secondColon),
    token: raw.slice(secondColon + 1)
  };
}
