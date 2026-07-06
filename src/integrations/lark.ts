import * as Lark from "@larksuiteoapi/node-sdk";
import type { IteamCore } from "../core.js";
import type { Agent, ExternalBotConfig, State, StoreEvent } from "../types.js";

export interface LarkBotConfig {
  provider: string;
  alias?: string | null;
  appId: string;
  appSecret: string;
  domain?: string;
  enabled: boolean;
}

interface LarkMessageEvent {
  event_id?: string;
  tenant_key?: string;
  sender?: {
    sender_type?: string;
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: string; name?: string; mentioned_type?: string }>;
  };
}

interface ParsedCommand {
  kind: "message" | "task" | "bind" | "current" | "help";
  target?: string | null;
  text?: string;
}

export class LarkBotIntegration {
  private readonly client: any;
  private readonly wsClient: any;
  private readonly sentLinkIds = new Set<string>();
  private unsubscribe?: () => void;
  private started = false;

  constructor(private readonly core: IteamCore, private readonly config: LarkBotConfig) {
    const baseConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
      ...(config.domain ? { domain: config.domain as any } : {})
    };
    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel.info,
      source: "iteam"
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data: LarkMessageEvent) => this.handleMessage(data)
    });
    this.unsubscribe = this.core.subscribe((event: StoreEvent) => {
      if (event.type === "state:changed") void this.flushOutboundReplies();
    });
    try {
      await this.wsClient.start({ eventDispatcher: dispatcher });
      this.core.updateExternalBotStatus(this.config.provider, "connected", null);
      console.log("[lark] long-connection event client started");
    } catch (error) {
      this.core.updateExternalBotStatus(this.config.provider, "error", (error as Error).message);
      throw error;
    }
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try { this.wsClient.close?.({ force: true }); } catch { /* ignore */ }
  }

  private async handleMessage(data: LarkMessageEvent): Promise<void> {
    const message = data.message;
    if (!message?.chat_id || !message.message_id) return;
    if (data.sender?.sender_type === "app") return;
    const tenantKey = data.tenant_key || "default";
    const chatId = message.chat_id;
    const senderId = data.sender?.sender_id?.open_id || data.sender?.sender_id?.user_id || data.sender?.sender_id?.union_id || "unknown";
    const rawText = extractText(message.content || "", message.message_type || "");
    const text = stripLarkBotMention(rawText, message.mentions || [], [this.config.alias]);
    if (!text) return;

    const parsed = parseIteamCommand(text);
    if (parsed.kind === "help") {
      await this.sendText(chatId, [
        "iTeam 用法：",
        "- `/all @codex 帮我看一下这个问题`：发送到 iTeam #all 并指定 agent。",
        "- `/task /all @codex 帮我看一下这个问题`：在 #all 创建 task，并分配给 @codex。",
        "- `/all 帮我看一下这个问题`：发送到 #all，由频道默认/可用 agent 处理。",
        "- `/iteam bind #all`：把当前飞书会话默认绑定到 #all。",
        "- `@codex 帮我看一下这个问题`：无默认频道时走 @codex 的 iTeam DM。"
      ].join("\n"));
      return;
    }

    if (parsed.kind === "bind") {
      const target = parsed.target;
      if (!target) {
        await this.sendText(chatId, "请指定要绑定的 iTeam channel，例如 `/iteam bind #all`。");
        return;
      }
      const binding = this.core.upsertExternalBotBinding({
        provider: this.config.provider,
        tenantKey,
        chatId,
        chatType: message.chat_type || null,
        defaultTarget: target
      });
      await this.sendText(chatId, `已绑定当前飞书会话到 iTeam ${binding.defaultTarget}。`);
      return;
    }

    if (parsed.kind === "current") {
      const binding = this.core.listExternalBotBindings().find(item =>
        item.provider === this.config.provider && item.tenantKey === tenantKey && item.chatId === chatId && item.status === "active"
      );
      await this.sendText(chatId, binding?.defaultTarget
        ? `当前默认 iTeam channel：${binding.defaultTarget}`
        : "当前飞书会话还没有默认 iTeam channel。可执行 `/iteam bind #all`。"
      );
      return;
    }

    const result = this.core.createExternalRoutedMessage({
      provider: this.config.provider,
      tenantKey,
      chatId,
      chatType: message.chat_type || null,
      senderId,
      externalMessageId: message.message_id,
      target: parsed.target || null,
      text: parsed.text || text,
      asTask: parsed.kind === "task"
    });
    if (!result.ok && result.replyText) {
      await this.sendText(chatId, result.replyText);
    }
  }

  private async flushOutboundReplies(): Promise<void> {
    const state = this.core.snapshot();
    const links = (state.externalMessageLinks || []).filter(link =>
      link.provider === this.config.provider && link.direction === "out" && !link.externalMessageId && !this.sentLinkIds.has(link.id)
    );
    for (const link of links) {
      const message = state.messages.find(item => item.id === link.messageId);
      if (!message || message.type !== "agent") continue;
      this.sentLinkIds.add(link.id);
      try {
        const { chatId } = parseLarkConversationId(link.externalConversationId);
        const label = formatAgentLabel(state, message.authorId);
        const response = await this.sendText(chatId, `${label}\n${message.text}`);
        const externalMessageId = response?.data?.message_id || `sent:${Date.now()}`;
        this.core.markExternalMessageLinkSent(link.id, externalMessageId);
      } catch (error) {
        this.sentLinkIds.delete(link.id);
        console.error(`[lark] send outbound reply failed: ${(error as Error).message}`);
      }
    }
  }

  private async sendText(chatId: string, text: string): Promise<any> {
    return this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text })
      }
    });
  }
}

export function readLarkBotConfig(env: NodeJS.ProcessEnv = process.env, stored?: ExternalBotConfig | null): LarkBotConfig {
  const appId = String(env.ITEAM_LARK_APP_ID || env.ITEAM_FEISHU_APP_ID || stored?.appId || "").trim();
  const appSecret = String(env.ITEAM_LARK_APP_SECRET || env.ITEAM_FEISHU_APP_SECRET || stored?.appSecret || "").trim();
  const enabledRaw = String(env.ITEAM_LARK_ENABLED || env.ITEAM_FEISHU_ENABLED || "").trim().toLowerCase();
  const enabledByEnv = !["0", "false", "no", "off"].includes(enabledRaw);
  const enabled = Boolean(appId && appSecret && isLikelyLarkAppId(appId) && enabledByEnv && (stored?.enabled ?? true));
  return {
    provider: stored?.provider || providerKeyForLarkApp(appId),
    alias: stored?.alias || null,
    appId,
    appSecret,
    enabled,
    domain: String(env.ITEAM_LARK_DOMAIN || env.ITEAM_FEISHU_DOMAIN || stored?.domain || "").trim() || undefined
  };
}

export function isLikelyLarkAppId(appId: string): boolean {
  return /^cli_[A-Za-z0-9]+$/.test(String(appId || "").trim());
}

export function providerKeyForLarkApp(appId: string): string {
  const normalized = String(appId || "").trim().toLowerCase();
  return normalized ? `lark:${normalized}` : "lark";
}

export function parseIteamCommand(input: string): ParsedCommand {
  const text = stripKnownIteamBotPrefix(input.trim());
  if (!text) return { kind: "message", text: "" };
  const lowered = text.toLowerCase();
  if (lowered === "/iteam" || lowered === "/iteam help" || lowered === "help") return { kind: "help" };
  const task = text.match(/^\/(?:task|todo)\s+([\s\S]+)$/i);
  if (task) {
    const routed = parseIteamCommand(task[1]);
    return { kind: "task", target: routed.target, text: routed.text || task[1].trim() };
  }
  const bind = text.match(/^\/iteam\s+bind\s+([^\s]+)\s*$/i) || text.match(/^\/iteam\s+use\s+([^\s]+)\s*$/i);
  if (bind) return { kind: "bind", target: normalizeChannelSelector(bind[1]) };
  if (/^\/iteam\s+current\s*$/i.test(text)) return { kind: "current" };
  const route = text.match(/^(?:\/|#)([A-Za-z0-9_-]+)\s+([\s\S]+)$/);
  if (route && route[1].toLowerCase() !== "iteam") {
    return { kind: "message", target: `#${route[1]}`, text: route[2].trim() };
  }
  return { kind: "message", text };
}

function normalizeChannelSelector(value: string): string {
  return `#${String(value || "").trim().replace(/^[/#]+/, "")}`;
}

function extractText(content: string, messageType: string): string {
  try {
    const parsed = JSON.parse(content || "{}");
    if (typeof parsed.text === "string") return parsed.text;
    if (messageType === "post" && parsed.content) return JSON.stringify(parsed.content);
  } catch {
    // fall through
  }
  return content;
}

export function stripLarkBotMention(
  text: string,
  mentions: Array<{ key?: string; name?: string; mentioned_type?: string }>,
  aliases: Array<string | null | undefined> = []
): string {
  let out = text;
  for (const mention of mentions) {
    if (!isBotMention(mention)) continue;
    if (mention.key) out = out.replaceAll(mention.key, "");
    if (mention.name) out = stripLeadingMentionName(out, mention.name);
  }
  return stripKnownIteamBotPrefix(out, aliases).trim();
}

function isBotMention(mention: { mentioned_type?: string }): boolean {
  const type = String(mention.mentioned_type || "").trim().toLowerCase();
  return !type || type === "app" || type === "bot" || type.includes("bot");
}

function stripKnownIteamBotPrefix(text: string, aliases: Array<string | null | undefined> = []): string {
  let out = text;
  for (const name of ["iTeamBot", "iteam", ...aliases]) {
    out = stripLeadingMentionName(out, name);
  }
  return out.trim();
}

function stripLeadingMentionName(text: string, name: string | null | undefined): string {
  const normalized = String(name || "").trim().replace(/^@+/, "");
  if (!normalized) return text;
  return text.replace(new RegExp(`^\\s*@${escapeRegExp(normalized)}(?:\\s+|$)`, "i"), "");
}

function parseLarkConversationId(value: string): { tenantKey: string; chatId: string } {
  const parts = value.split(":");
  if (parts.length < 3) throw new Error(`invalid lark conversation id: ${value}`);
  const chatId = parts.pop()!;
  const tenantKey = parts.pop()!;
  const provider = parts.join(":");
  if (!provider.startsWith("lark") && !provider.startsWith("feishu")) throw new Error(`invalid lark conversation id: ${value}`);
  return { tenantKey, chatId };
}

function formatAgentLabel(state: State, authorId: string): string {
  const agent = (state.agents || []).find((item: Agent) => item.id === authorId);
  return agent ? `[@${agent.handle || agent.name}]` : `[${authorId}]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
