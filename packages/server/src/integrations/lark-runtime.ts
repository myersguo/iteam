// Lark long-connection runtime — one WSClient per (spaceId, provider) pair.
//
// Extracted from server.ts so the native transport can pass `sync`/`remove`
// hooks to http-server through createIteamRequestHandler's externalBotRuntime
// option.
//
// Behavior is unchanged: two spaces can bind the same Lark app id, so sessions
// are keyed on (provider, spaceId) — the Lark app gets one WS connection per
// space, matching the fact that channels/bindings are space-owned.
import type { IteamCore } from "../core.js";
import { LarkBotIntegration, readLarkBotConfig, isLikelyLarkAppId } from "./lark.js";

export class LarkBotRuntime {
  private readonly bots = new Map<string, LarkBotIntegration>();

  constructor(private readonly core: IteamCore) {}

  startAll(): void {
    const envConfig = readLarkBotConfig(process.env);
    if (envConfig.enabled) void this.startConfig(envConfig, "space_default");
    for (const stored of this.core.listAllExternalBotConfigsRaw()) {
      void this.syncProvider(stored.provider, stored.spaceId);
    }
  }

  async syncProvider(provider: string, spaceId: string): Promise<void> {
    const normalized = normalizeRuntimeProvider(provider);
    if (!isLarkRuntimeProvider(normalized)) return;
    this.removeProvider(normalized, spaceId);

    const stored = this.core.getExternalBotConfigInSpace(normalized, spaceId);
    if (!stored) return;
    if (!stored.enabled) {
      this.core.updateExternalBotStatus(normalized, "disabled", null, spaceId);
      return;
    }
    if (stored.appId && !isLikelyLarkAppId(stored.appId)) {
      console.warn(`[lark] skip long-connection client for ${stored.provider} in ${spaceId}: invalid appId`);
      this.core.updateExternalBotStatus(normalized, "invalid", "App ID should look like cli_xxx", spaceId);
      return;
    }

    const config = readLarkBotConfig({}, stored);
    if (!config.enabled) {
      this.core.updateExternalBotStatus(normalized, "pending", "App ID and App Secret are required before pairing", spaceId);
      return;
    }
    await this.startConfig(config, spaceId);
  }

  removeProvider(provider: string, spaceId: string): void {
    const key = runtimeKey(provider, spaceId);
    const bot = this.bots.get(key);
    if (!bot) return;
    bot.close();
    this.bots.delete(key);
  }

  closeAll(): void {
    for (const bot of this.bots.values()) bot.close();
    this.bots.clear();
  }

  private async startConfig(config: ReturnType<typeof readLarkBotConfig>, spaceId: string): Promise<void> {
    const key = runtimeKey(config.provider, spaceId);
    this.removeProvider(config.provider, spaceId);
    const bot = new LarkBotIntegration(this.core, { ...config, spaceId });
    this.bots.set(key, bot);
    try {
      await bot.start();
    } catch (error) {
      bot.close();
      this.bots.delete(key);
      console.error(`[lark] failed to start long-connection client for ${config.provider} in ${spaceId}: ${(error as Error).message}`);
    }
  }
}

function runtimeKey(provider: string, spaceId: string): string {
  return `${normalizeRuntimeProvider(provider)}::${String(spaceId || "").trim() || "space_default"}`;
}

function normalizeRuntimeProvider(provider: string): string {
  return String(provider || "").trim().toLowerCase();
}

function isLarkRuntimeProvider(provider: string): boolean {
  return provider.startsWith("lark") || provider.startsWith("feishu");
}
