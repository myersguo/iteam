#!/usr/bin/env node
// Daemon boot — argument parsing, single-instance lock, core wiring, graceful
// shutdown. All domain logic lives in IteamCore; the HTTP transport lives in
// http-server.ts. This split mirrors zouk-daemon's index.ts/core.ts layout so
// the same core can later be embedded in tests or alternate transports.

import { join } from "node:path";
import { DAEMON_VERSION, defaultHome } from "./lib.js";
import { IteamCore } from "./core.js";
import { startHttpServer } from "./http-server.js";
import { acquireLock, LockHeldError } from "./machine-lock.js";
import { LarkBotIntegration, readLarkBotConfig, isLikelyLarkAppId } from "./integrations/lark.js";

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

class LarkBotRuntime {
  private readonly bots = new Map<string, LarkBotIntegration>();

  constructor(private readonly core: IteamCore) {}

  startAll(): void {
    const envConfig = readLarkBotConfig(process.env);
    if (envConfig.enabled) void this.startConfig(envConfig);
    for (const stored of this.core.listExternalBotConfigs()) {
      void this.syncProvider(stored.provider);
    }
  }

  async syncProvider(provider: string): Promise<void> {
    const normalized = normalizeRuntimeProvider(provider);
    if (!isLarkRuntimeProvider(normalized)) return;
    this.removeProvider(normalized);

    const stored = this.core.getExternalBotConfig(normalized);
    if (!stored) return;
    if (!stored.enabled) {
      this.core.updateExternalBotStatus(normalized, "disabled", null);
      return;
    }
    if (stored.appId && !isLikelyLarkAppId(stored.appId)) {
      console.warn(`[lark] skip long-connection client for ${stored.provider}: invalid appId`);
      this.core.updateExternalBotStatus(normalized, "invalid", "App ID should look like cli_xxx");
      return;
    }

    const config = readLarkBotConfig({}, stored);
    if (!config.enabled) {
      this.core.updateExternalBotStatus(normalized, "pending", "App ID and App Secret are required before pairing");
      return;
    }
    await this.startConfig(config);
  }

  removeProvider(provider: string): void {
    const normalized = normalizeRuntimeProvider(provider);
    const bot = this.bots.get(normalized);
    if (!bot) return;
    bot.close();
    this.bots.delete(normalized);
  }

  closeAll(): void {
    for (const bot of this.bots.values()) bot.close();
    this.bots.clear();
  }

  private async startConfig(config: ReturnType<typeof readLarkBotConfig>): Promise<void> {
    this.removeProvider(config.provider);
    const bot = new LarkBotIntegration(this.core, config);
    this.bots.set(config.provider, bot);
    try {
      await bot.start();
    } catch (error) {
      bot.close();
      this.bots.delete(config.provider);
      console.error(`[lark] failed to start long-connection client for ${config.provider}: ${(error as Error).message}`);
    }
  }
}

function normalizeRuntimeProvider(provider: string): string {
  return String(provider || "").trim().toLowerCase();
}

function isLarkRuntimeProvider(provider: string): boolean {
  return provider.startsWith("lark") || provider.startsWith("feishu");
}

const larkRuntime = new LarkBotRuntime(core);
const http = startHttpServer({
  core,
  port,
  host,
  serveWeb,
  webRoot,
  externalBotRuntime: {
    sync: provider => larkRuntime.syncProvider(provider),
    remove: provider => larkRuntime.removeProvider(provider)
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
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

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
