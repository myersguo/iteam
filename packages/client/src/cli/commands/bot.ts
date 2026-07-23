// `iteam bot ...` — manage external chat bots (Lark/Feishu) and their bindings.

import { printTable, printMessage } from "../output.js";
import { flagString, flagBool } from "../args.js";
import type { CommandContext } from "../types.js";
import type { ExternalBotConfig, ExternalBotBinding } from "@iteam/shared";

export async function runBot(cmd: CommandContext): Promise<void> {
  const sub = cmd.args.positionals[0];
  switch (cmd.action) {
    case "lark":
      return lark(cmd, sub);
    case "list":
      return listConfigs(cmd);
    case "binding":
    case "bindings":
      return bindings(cmd);
    default:
      throw new Error("usage: iteam bot lark config|list | bot list | bot binding list");
  }
}

async function lark(cmd: CommandContext, sub: string | undefined): Promise<void> {
  if (sub === "config") {
    const appId = flagString(cmd.args, "app-id") || process.env.ITEAM_LARK_APP_ID || process.env.ITEAM_FEISHU_APP_ID;
    if (!appId) throw new Error("--app-id is required");
    const appSecret = flagString(cmd.args, "app-secret") || process.env.ITEAM_LARK_APP_SECRET || process.env.ITEAM_FEISHU_APP_SECRET;
    const domain = flagString(cmd.args, "domain") || process.env.ITEAM_LARK_DOMAIN || process.env.ITEAM_FEISHU_DOMAIN;
    const body = {
      provider: "lark",
      appId,
      ...(appSecret ? { appSecret } : {}),
      ...(domain ? { domain } : {}),
      enabled: !flagBool(cmd.args, "disable")
    };
    const saved = await cmd.client.post("/api/external/bot-configs", body);
    printMessage("bot config saved; the daemon will (re)connect it automatically", cmd.output, saved);
    return;
  }
  if (sub === "list") return listConfigs(cmd);
  throw new Error("usage: iteam bot lark config|list");
}

async function listConfigs(cmd: CommandContext): Promise<void> {
  const configs = await cmd.client.get<ExternalBotConfig[]>("/api/external/bot-configs");
  printTable(
    configs.map(c => ({
      provider: c.provider,
      appId: c.appId,
      enabled: c.enabled,
      status: c.status || "",
      secret: c.appSecret ? "configured" : "",
      domain: c.domain || ""
    })),
    cmd.output
  );
}

async function bindings(cmd: CommandContext): Promise<void> {
  const rows = await cmd.client.get<ExternalBotBinding[]>("/api/external/bot-bindings");
  printTable(
    rows.map(b => ({
      id: b.id,
      provider: b.provider,
      chat: b.chatId,
      target: b.defaultTarget || "",
      agent: b.defaultAgentId || "",
      status: b.status
    })),
    cmd.output
  );
}
