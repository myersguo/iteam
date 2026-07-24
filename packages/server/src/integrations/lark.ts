import * as Lark from "@larksuiteoapi/node-sdk";
import type { IteamCore } from "../core.js";
import type { Agent, ExternalBotConfig, ExternalMessageLink, State, StoreEvent } from "@iteam/shared";

export interface LarkBotConfig {
  provider: string;
  spaceId: string;
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
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: string; name?: string; mentioned_type?: string }>;
  };
}

interface LarkSendContext {
  replyToMessageId?: string | null;
  replyInThread?: boolean;
}

interface LarkSendOptions {
  title?: string;
  cardTemplate?: string;
}

interface LarkPayload {
  msg_type: "text" | "interactive";
  content: string;
}

interface ParsedCommand {
  kind: "message" | "task" | "bind" | "current" | "help";
  target?: string | null;
  agentHandle?: string | null;
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
    this.client = new Lark.Client({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel.fatal
    });
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
      this.core.updateExternalBotStatus(this.config.provider, "connected", null, this.config.spaceId);
      console.log(`[lark] long-connection event client started (${this.config.provider}@${this.config.spaceId})`);
    } catch (error) {
      this.core.updateExternalBotStatus(this.config.provider, "error", (error as Error).message, this.config.spaceId);
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
    void this.reactToMessage(message.message_id).catch(error => {
      console.warn(`[lark] add ack reaction failed for ${message.message_id}: ${(error as Error).message}`);
    });
    const tenantKey = data.tenant_key || "default";
    const chatId = message.chat_id;
    const sendContext = larkSendContext(message);
    const senderId = data.sender?.sender_id?.open_id || data.sender?.sender_id?.user_id || data.sender?.sender_id?.union_id || "unknown";
    const rawText = extractText(message.content || "", message.message_type || "");
    const text = stripLarkBotMention(rawText, message.mentions || [], [this.config.alias]);
    if (!text) return;

    const parsed = parseIteamCommand(text);
    if (parsed.kind === "help") {
      await this.sendText(chatId, [
        "iTeam 用法：",
        "- `/iteam bind #all`：把当前飞书会话绑定到 iTeam 频道；绑定后直接说话即可，无需前缀。",
        "- `/iteam bind #all codex`：绑定 channel 的同时指定默认 agent。",
        "- `/all 帮我看一下这个问题`：显式指定 iTeam 频道，由该频道默认/可用 agent 处理。",
        "- `codex: 帮我看一下这个问题`：显式指定 agent（不改变已绑定的频道）。",
        "- `/all codex: 帮我看...`：同时指定频道和 agent。",
        "- `/task /all codex: 帮我看...`：创建 iTeam task，可组合频道 / agent。",
        "- `/iteam current`：查看当前绑定。"
      ].join("\n"), sendContext);
      return;
    }

    if (parsed.kind === "bind") {
      const target = parsed.target;
      if (!target) {
        await this.sendText(chatId, "请指定要绑定的 iTeam channel，例如 `/iteam bind #all`。", sendContext);
        return;
      }
      let defaultAgentId: string | undefined;
      if (parsed.agentHandle) {
        const resolved = this.resolveAgentIdByHandle(parsed.agentHandle);
        if (!resolved) {
          await this.sendText(chatId, `找不到 iTeam agent \`${parsed.agentHandle}\`，绑定未生效。`, sendContext);
          return;
        }
        defaultAgentId = resolved;
      }
      const binding = this.core.upsertExternalBotBinding({
        provider: this.config.provider,
        spaceId: this.config.spaceId,
        tenantKey,
        chatId,
        chatType: message.chat_type || null,
        defaultTarget: target,
        ...(defaultAgentId !== undefined ? { defaultAgentId } : {})
      });
      const agentLabel = binding.defaultAgentId
        ? `，默认 agent \`${this.core.listAgents(this.config.spaceId).find(a => a.id === binding.defaultAgentId)?.handle || binding.defaultAgentId}\``
        : "";
      await this.sendText(chatId, `已绑定当前飞书会话到 iTeam ${binding.defaultTarget}${agentLabel}。之后无需前缀直接发消息即可，或用 \`codex: ...\` 指定 agent。`, sendContext);
      return;
    }

    if (parsed.kind === "current") {
      const binding = this.core.listExternalBotBindings(this.config.spaceId).find(item =>
        item.provider === this.config.provider && item.tenantKey === tenantKey && item.chatId === chatId && item.status === "active"
      );
      const reply = binding?.defaultTarget
        ? `当前默认 iTeam channel：${binding.defaultTarget}`
        : "当前飞书会话还没有默认 iTeam channel。可执行 `/iteam bind #all`。";
      await this.sendText(chatId, reply, sendContext);
      return;
    }

    let resolvedAgentId: string | null = null;
    if (parsed.agentHandle) {
      const resolved = this.resolveAgentIdByHandle(parsed.agentHandle);
      if (!resolved) {
        await this.sendText(chatId, `找不到 iTeam agent \`${parsed.agentHandle}\`。可通过 \`/iteam current\` 查看当前绑定，或访问 iTeam 面板查看在线 agent。`, sendContext);
        return;
      }
      resolvedAgentId = resolved;
    }

    const result = this.core.createExternalRoutedMessage({
      provider: this.config.provider,
      spaceId: this.config.spaceId,
      tenantKey,
      chatId,
      chatType: message.chat_type || null,
      senderId,
      externalMessageId: message.message_id,
      externalThreadId: message.thread_id || null,
      externalRootMessageId: message.root_id || null,
      externalParentMessageId: message.parent_id || null,
      externalReplyToMessageId: message.message_id,
      target: parsed.target || null,
      defaultAgentId: resolvedAgentId,
      text: parsed.text || text,
      asTask: parsed.kind === "task"
    });
    if (!result.ok && result.replyText) {
      await this.sendText(chatId, result.replyText, sendContext);
    }
  }

  /**
   * Look up an agent id by its handle (case-insensitive), scoped to this
   * bot's space so bots in space A can't accidentally route to agents in
   * space B just because the handles match.
   */
  private resolveAgentIdByHandle(handle: string): string | null {
    const needle = String(handle || "").trim().toLowerCase();
    if (!needle) return null;
    const agents = this.core.listAgents(this.config.spaceId);
    const match = agents.find(agent =>
      String(agent.handle || "").toLowerCase() === needle ||
      String(agent.id || "").toLowerCase() === needle
    );
    return match?.id || null;
  }

  private async flushOutboundReplies(): Promise<void> {
    const state = this.core.snapshot();
    const links = (state.externalMessageLinks || []).filter(link =>
      link.provider === this.config.provider &&
      link.spaceId === this.config.spaceId &&
      link.direction === "out" &&
      !link.externalMessageId &&
      !this.sentLinkIds.has(link.id)
    );
    for (const link of links) {
      const message = state.messages.find(item => item.id === link.messageId);
      if (!message || message.type !== "agent") continue;
      this.sentLinkIds.add(link.id);
      try {
        const { chatId } = parseLarkConversationId(link.externalConversationId);
        const label = formatAgentLabel(state, message.authorId);
        const response = await this.sendText(chatId, message.text, larkSendContextForLink(link), {
          title: label,
          cardTemplate: "blue"
        });
        const externalMessageId = response?.data?.message_id || `sent:${Date.now()}`;
        this.core.markExternalMessageLinkSent(link.id, externalMessageId);
      } catch (error) {
        this.sentLinkIds.delete(link.id);
        console.error(`[lark] send outbound reply failed: ${(error as Error).message}`);
      }
    }
  }

  private async sendText(chatId: string, text: string, context: LarkSendContext = {}, options: LarkSendOptions = {}): Promise<any> {
    const cardPayload = buildLarkCardPayload(text, options);
    if (cardPayload) {
      try {
        return await this.sendPayload(chatId, cardPayload, context);
      } catch (error) {
        console.warn(`[lark] send card failed, falling back to text: ${(error as Error).message}`);
      }
    }
    return this.sendPayload(chatId, textPayload(text), context);
  }

  private async sendPayload(chatId: string, payload: LarkPayload, context: LarkSendContext = {}): Promise<any> {
    if (context.replyToMessageId) {
      try {
        return await this.client.im.v1.message.reply({
          path: { message_id: context.replyToMessageId },
          data: {
            msg_type: payload.msg_type,
            content: payload.content,
            ...(context.replyInThread ? { reply_in_thread: true } : {})
          }
        });
      } catch (error) {
        if (!context.replyInThread || larkErrorCode(error) !== "230071") throw error;
        console.warn(`[lark] reply_in_thread unsupported for ${context.replyToMessageId}; falling back to chat message`);
      }
    }
    return this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: payload.msg_type,
        content: payload.content
      }
    });
  }

  private async reactToMessage(messageId: string): Promise<void> {
    await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: {
          emoji_type: randomAckEmoji()
        }
      }
    });
  }
}

const LARK_CARD_CONTENT_LIMIT_BYTES = 28_000;
const LARK_ACK_EMOJIS = [
  "Get",
  "OK",
  "THUMBSUP",
  "THANKS",
  "JIAYI",
  "CheckMark",
  "Yes",
  "OnIt",
  "LGTM",
  "SALUTE",
  "FISTBUMP",
  "HIGHFIVE",
  "SMILE",
  "WINK",
  "WITTY"
] as const;

function textPayload(text: string): LarkPayload {
  return {
    msg_type: "text",
    content: JSON.stringify({ text })
  };
}

function buildLarkCardPayload(text: string, options: LarkSendOptions = {}): LarkPayload | null {
  const markdown = normalizeCardMarkdown(text);
  if (!markdown) return null;
  const card = {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      title: {
        tag: "plain_text",
        content: truncateCardTitle(options.title || "iTeam")
      },
      template: options.cardTemplate || "wathet"
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: markdown
        }
      ]
    }
  };
  const content = JSON.stringify(card);
  if (Buffer.byteLength(content, "utf8") > LARK_CARD_CONTENT_LIMIT_BYTES) return null;
  return { msg_type: "interactive", content };
}

function normalizeCardMarkdown(text: string): string {
  return fenceMarkdownTables(String(text || "").trim());
}

function fenceMarkdownTables(markdown: string): string {
  if (!markdown.includes("|")) return markdown;
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && isMarkdownTableStart(lines, i)) {
      out.push("```text");
      while (i < lines.length && isMarkdownTableLine(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      out.push("```");
      i--;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const current = lines[index];
  const next = lines[index + 1];
  return isMarkdownTableLine(current) && isMarkdownTableSeparator(next);
}

function isMarkdownTableLine(line: string | undefined): boolean {
  const text = String(line || "").trim();
  return text.includes("|") && text.replace(/\|/g, "").trim().length > 0;
}

function isMarkdownTableSeparator(line: string | undefined): boolean {
  const text = String(line || "").trim();
  if (!text.includes("|")) return false;
  return /^[|:\-\s]+$/.test(text) && text.includes("-");
}

function truncateCardTitle(title: string): string {
  const normalized = String(title || "iTeam").replace(/\s+/g, " ").trim() || "iTeam";
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function randomAckEmoji(): string {
  return LARK_ACK_EMOJIS[Math.floor(Math.random() * LARK_ACK_EMOJIS.length)] || "Get";
}

export function readLarkBotConfig(env: NodeJS.ProcessEnv = process.env, stored?: ExternalBotConfig | null): LarkBotConfig {
  const appId = String(env.ITEAM_LARK_APP_ID || env.ITEAM_FEISHU_APP_ID || stored?.appId || "").trim();
  const appSecret = String(env.ITEAM_LARK_APP_SECRET || env.ITEAM_FEISHU_APP_SECRET || stored?.appSecret || "").trim();
  const enabledRaw = String(env.ITEAM_LARK_ENABLED || env.ITEAM_FEISHU_ENABLED || "").trim().toLowerCase();
  const enabledByEnv = !["0", "false", "no", "off"].includes(enabledRaw);
  const enabled = Boolean(appId && appSecret && isLikelyLarkAppId(appId) && enabledByEnv && (stored?.enabled ?? true));
  return {
    provider: stored?.provider || providerKeyForLarkApp(appId),
    spaceId: stored?.spaceId || "space_default",
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
    return {
      kind: "task",
      target: routed.target,
      agentHandle: routed.agentHandle,
      text: routed.text || task[1].trim()
    };
  }
  const bind = text.match(/^\/iteam\s+(?:bind|use)\s+([^\s]+)(?:\s+([A-Za-z0-9_-]{1,40}))?\s*$/i);
  if (bind) {
    return {
      kind: "bind",
      target: normalizeChannelSelector(bind[1]),
      agentHandle: bind[2] ? bind[2].toLowerCase() : null
    };
  }
  if (/^\/iteam\s+current\s*$/i.test(text)) return { kind: "current" };
  const route = text.match(/^(?:\/|#)([A-Za-z0-9_-]+)\s+([\s\S]+)$/);
  if (route && route[1].toLowerCase() !== "iteam") {
    const rest = route[2].trim();
    const withAgent = matchAgentHandlePrefix(rest);
    if (withAgent) {
      return { kind: "message", target: `#${route[1]}`, agentHandle: withAgent.handle, text: withAgent.text };
    }
    return { kind: "message", target: `#${route[1]}`, text: rest };
  }
  // Bare `<handle>: <text>` — no channel prefix, keep target null so the
  // caller can fall back to the bound default channel.
  const bareAgent = matchAgentHandlePrefix(text);
  if (bareAgent) {
    return { kind: "message", agentHandle: bareAgent.handle, text: bareAgent.text };
  }
  return { kind: "message", text };
}

/**
 * Match a leading `<handle>:<text>` router. `<handle>` follows the iTeam
 * agent handle format (letters/digits/`_-`, 1-40 chars). The colon may be
 * followed by whitespace or plain text (`aiden:hi` is valid, matching
 *飞书用户习惯). URL-like schemes (`http`, `https`, `mailto`, ...) are
 * excluded so `https://example.com` and `mailto:a@b` aren't misparsed as
 * agent selectors.
 */
function matchAgentHandlePrefix(input: string): { handle: string; text: string } | null {
  const match = input.match(/^([A-Za-z0-9_-]{1,40}):\s*([\s\S]+)$/);
  if (!match) return null;
  const handle = match[1];
  const rest = match[2].trim();
  if (!rest) return null;
  if (isUrlLikeScheme(handle, rest)) return null;
  return { handle: handle.toLowerCase(), text: rest };
}

const URL_LIKE_SCHEMES = new Set([
  "http", "https", "ftp", "ftps", "sftp", "ws", "wss",
  "mailto", "tel", "sms", "git", "ssh", "file",
  "data", "javascript", "chrome", "about"
]);

function isUrlLikeScheme(handle: string, rest: string): boolean {
  if (URL_LIKE_SCHEMES.has(handle.toLowerCase())) return true;
  // `foo://bar` is almost always a URL, whatever the scheme name.
  return rest.startsWith("//");
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

function larkSendContext(message: NonNullable<LarkMessageEvent["message"]>): LarkSendContext {
  return message.thread_id
    ? { replyToMessageId: message.message_id, replyInThread: true }
    : {};
}

function larkSendContextForLink(link: ExternalMessageLink): LarkSendContext {
  return link.externalThreadId && link.externalReplyToMessageId
    ? { replyToMessageId: link.externalReplyToMessageId, replyInThread: true }
    : {};
}

function larkErrorCode(error: unknown): string | null {
  const candidate = error as {
    code?: unknown;
    response?: { data?: { code?: unknown } };
    data?: { code?: unknown };
  };
  const code = candidate?.response?.data?.code ?? candidate?.data?.code ?? candidate?.code;
  return code === undefined || code === null ? null : String(code);
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
