#!/usr/bin/env node
// Daemon boot — argument parsing, single-instance lock, core wiring, graceful
// shutdown. All domain logic lives in IteamCore; the HTTP transport lives in
// http-server.ts. This split mirrors zouk-daemon's index.ts/core.ts layout so
// the same core can later be embedded in tests or alternate transports.

import { join } from "node:path";
import { DAEMON_VERSION, defaultHome } from "@iteam/shared";
import { IteamCore } from "./core.js";
import { startHttpServer } from "./http-server.js";
import { acquireLock, LockHeldError } from "./machine-lock.js";
import { LarkBotRuntime } from "./integrations/lark-runtime.js";

const port = Number(readArg("--port", process.env.ITEAM_PORT || "4318"));
const host = readArg("--host", process.env.ITEAM_HOST || "0.0.0.0") || "0.0.0.0";
const home = process.env.ITEAM_HOME || defaultHome();
const lockPath = join(home, "daemon.lock");
const serveWeb = resolveServeWeb();
const webRoot = readArg("--web-root", process.env.ITEAM_WEB_ROOT);

console.log(`iTeam daemon ${DAEMON_VERSION} starting (pid ${process.pid}, home ${home})`);

const lock = await acquireLock({ lockPath, port }).catch(error => {
  if (error instanceof LockHeldError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
});

const core = await IteamCore.create({
  // serverInviteRoot is the directory used to render `npm exec --package <root>`
  // in the connect-command response; staying with the historical "module root"
  // keeps the existing CLI invocation working.
  serverInviteRoot: resolveModuleRoot()
});
console.log(`Data: ${core.store.home} (backend: ${process.env.ITEAM_STORE || "sqlite"})`);

const larkRuntime = new LarkBotRuntime(core);
const http = startHttpServer({
  core,
  port,
  host,
  serveWeb,
  webRoot,
  externalBotRuntime: {
    sync: (provider, spaceId) => larkRuntime.syncProvider(provider, spaceId),
    remove: (provider, spaceId) => larkRuntime.removeProvider(provider, spaceId)
  }
});

http.server.on("listening", () => {
  console.log(`iTeam daemon listening on http://${host}:${port}`);
  if (http.serveWeb) {
    console.log(`Web: serving static bundle from ${http.webRoot}`);
  } else {
    console.log("Web: static hosting disabled (--no-serve-web)");
  }
  larkRuntime.startAll();
});
http.server.on("error", error => {
  console.error(`http server error: ${(error as Error).message}`);
});

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`shutting down (${reason})`);
  // Hard-exit safety net: if graceful shutdown stalls (usually a stuck HTTP
  // connection or store close), bail out after 5s so Ctrl+C / kill still
  // frees the port and lock.
  const forceExit = setTimeout(() => {
    console.error("shutdown timed out after 5s, forcing exit");
    process.exit(1);
  }, 5000);
  forceExit.unref();
  try {
    larkRuntime.closeAll();
  } catch (error) {
    console.error(`lark close error: ${(error as Error).message}`);
  }
  try {
    await http.close();
  } catch (error) {
    console.error(`http close error: ${(error as Error).message}`);
  }
  try {
    await core.store.close?.();
  } catch (error) {
    console.error(`store close error: ${(error as Error).message}`);
  }
  await lock.release();
  clearTimeout(forceExit);
  process.exit(0);
}

// Second Ctrl+C / SIGTERM while a shutdown is already in progress: give up on
// graceful shutdown and exit immediately.
let signalCount = 0;
function handleSignal(name: string): void {
  signalCount += 1;
  if (signalCount > 1) {
    console.error(`received ${name} again, forcing exit`);
    process.exit(1);
  }
  void shutdown(name);
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

function readArg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function resolveServeWeb(): boolean {
  if (process.argv.includes("--no-serve-web")) return false;
  if (process.argv.includes("--serve-web")) return true;
  const env = process.env.ITEAM_SERVE_WEB;
  if (env === undefined) return true;
  const normalized = env.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}

function resolveModuleRoot(): string {
  // process.argv[1] points to the bin shim or src/server.ts during dev.
  // We only need a string the npm-exec command can resolve; the historical
  // value was the package root, which `import.meta.url` lets us recover.
  const here = new URL(".", import.meta.url).pathname;
  return new URL("..", import.meta.url).pathname || here;
}
