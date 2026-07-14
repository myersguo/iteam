// AcpDriver — long-lived JSON-RPC 2.0 client for ACP-compatible runtimes.
//
// Spawns the agent CLI in ACP server mode (e.g. `traecli acp serve`,
// `codex app-server --listen stdio://`), performs the initialize/session_new
// handshake once, and reuses the same session for every deliver() call. Per
// https://blog.openviking.ai/post/agent-runtime/?lang=zh this matches the
// "direct" busy-delivery mode — new prompts can interleave on top of an
// existing session as long as the previous turn has finished.
//
// Wire details follow the ACP spec at https://agentclientprotocol.com/.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { nowIso } from "../lib.js";
import { agentEnv, prepareAgentWorkspace, type AgentWorkspaceLayout } from "../workspace.js";
import type { Agent, DeliveryWithContext } from "../types.js";
import { type AgentDriver, type AgentEventListener, type DeliverResult, type DeliveryMode, type DriverCapabilities } from "./driver.js";
import type { AgentEvent } from "./events.js";
import { JsonRpcStdioClient } from "./jsonrpc.js";
import {
  renderAcpProfileArgs,
  renderAcpProfileCwd,
  renderAcpProfileEnv,
  resolveAcpRuntimeProfile
} from "./acp-profiles.js";

/** ACP protocol version this client speaks. Negotiated down on initialize. */
const PROTOCOL_VERSION = 1;
const TURN_IDLE_TIMEOUT_MS = readPositiveMs("ITEAM_AGENT_IDLE_TIMEOUT_MS", 6 * 60 * 60 * 1000);
const DEFAULT_PROCESS_POOL_SIZE = readPositiveMs("ITEAM_ACP_PROCESS_POOL_SIZE", 3);
const DEFAULT_SESSION_KEY = "__default__";

interface AcpRuntimeSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface AcpDriverOptions {
  serverUrl: string;
  launchId: string;
  computerId?: string;
  connectToken?: string;
}

interface ProcessState {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcStdioClient;
  defaultSessionId: string;
  workspace: AgentWorkspaceLayout;
  sessions: Map<string, AcpSessionState>;
}

interface AcpSessionState {
  key: string;
  sessionId: string;
  inflight: Promise<unknown>;
  touchTurn?: () => void;
  activeDeliveryId?: string;
  activeTarget?: string;
}

export class AcpDriver implements AgentDriver {
  readonly runtime: string;
  readonly deliveryMode: DeliveryMode = "direct";
  readonly capabilities: DriverCapabilities = {
    lifecycle: "persistent",
    inFlightWake: "direct",
    supportsResume: true
  };

  private listeners: Set<AgentEventListener> = new Set();
  private serverUrl: string;
  private launchId: string;
  private computerId?: string;
  private connectToken?: string;
  
  private processes: ProcessState[] = [];
  private startPromises: Promise<void>[] = [];
  private cancelledDeliveryIds: Set<string> = new Set();

  constructor(runtime: string, opts: AcpDriverOptions) {
    this.runtime = runtime;
    this.serverUrl = opts.serverUrl;
    this.launchId = opts.launchId;
    this.computerId = opts.computerId;
    this.connectToken = opts.connectToken;
  }

  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isAlive(): boolean {
    // Alive if at least one process in the pool is alive
    if (this.processes.length === 0 && this.startPromises.length === 0) return false;
    return this.processes.some(p => p.child.exitCode === null && p.child.signalCode === null);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async start(agent: Agent): Promise<void> {
    const profile = resolveAcpRuntimeProfile(agent.runtime);
    const poolSize = Math.max(1, Math.floor(profile?.poolSize || DEFAULT_PROCESS_POOL_SIZE));
    // Start up to the configured process pool size. Each process can host
    // multiple ACP sessions, keyed by delivery.sessionKey.
    while (this.processes.length + this.startPromises.length < poolSize) {
      const processIndex = this.processes.length + this.startPromises.length;
      const p = this.doStart(agent, processIndex).finally(() => {
        this.startPromises = this.startPromises.filter(x => x !== p);
      });
      this.startPromises.push(p);
    }
    if (this.startPromises.length > 0) {
      await Promise.all(this.startPromises);
    }
  }

  private async doStart(agent: Agent, processIndex: number): Promise<void> {
    const poolAgent = { ...agent };
    const path = await import("node:path");
    const lib = await import("../lib.js");
    const baseLocalDir = path.join(lib.defaultHome(), "agents", agent.id);
    const baseRequestedDir = agent.workspacePath || baseLocalDir;
    poolAgent.workspacePath = `${baseRequestedDir}-pool-${processIndex}`;

    const workspace = prepareAgentWorkspace({
      agent: poolAgent,
      serverUrl: this.serverUrl,
      launchId: this.launchId,
      computerId: this.computerId,
      connectToken: this.connectToken
    });
    
    // Restore the original agent ID in bridgeArgs so the chat bridge authenticates correctly
    workspace.bridgeArgs = workspace.bridgeArgs.map(arg => 
      arg === poolAgent.id ? agent.id : arg
    );
    
    const cwd = workspace.dir;
    const spec = buildAcpSpec(agent, workspace);
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd || cwd,
      env: {
        ...agentEnv({ agent, serverUrl: this.serverUrl, workspace }),
        ...(spec.env || {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;

    let processState: ProcessState | null = null;

    // Turn spawn errors (ENOENT for missing binary, EACCES, ...) into agent
    // events instead of unhandled 'error' events that would kill the daemon
    // and take every other agent down with it.
    child.on("error", (error: Error) => {
      this.emit({
        type: "error",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: processState?.defaultSessionId,
        at: nowIso(),
        message: `${spec.command} spawn error: ${error.message}`
      });
      this.processes = this.processes.filter(p => p !== processState);
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.emit({
        type: "exited",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: processState?.defaultSessionId,
        at: nowIso(),
        code,
        signal
      });
      this.processes = this.processes.filter(p => p !== processState);
    });

    const rpc = new JsonRpcStdioClient(child, {
      onRequest: (method, params) => this.handleAgentRequest(method, params),
      onNotification: (method, params) => this.handleAgentNotification(agent, method, params, processState?.defaultSessionId)
    });

    // 1) initialize
    await rpc.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: { name: "iteam-daemon", version: "0.1.0" }
    });

    // 2) session/new
    const sessionResult = await rpc.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: buildMcpServers(workspace)
    });

    const defaultSession: AcpSessionState = {
      key: DEFAULT_SESSION_KEY,
      sessionId: sessionResult.sessionId,
      inflight: Promise.resolve()
    };
    processState = {
      child,
      rpc,
      defaultSessionId: sessionResult.sessionId,
      workspace,
      sessions: new Map([[DEFAULT_SESSION_KEY, defaultSession]])
    };
    
    this.processes.push(processState);

    // Remove from startPromises since it's fully started
    // (the filter logic in start() handles this indirectly, but we can't easily access `p` here)

    this.emit({
      type: "session_started",
      agentId: agent.id,
      launchId: this.launchId,
      sessionId: processState.defaultSessionId,
      at: nowIso()
    });
  }

  async deliver(agent: Agent, delivery: DeliveryWithContext, prompt: string): Promise<DeliverResult> {
    await this.start(agent);
    if (this.processes.length === 0) throw new Error("acp processes not initialized");

    if (this.cancelledDeliveryIds.has(delivery.id)) {
      throw new Error(`delivery ${delivery.id} was cancelled`);
    }

    const sessionKey = sessionKeyForDelivery(delivery);
    const processState = this.processes[hashIndex(sessionKey, this.processes.length)];
    const sessionState = await this.ensureSession(agent, processState, sessionKey);

    const turn = sessionState.inflight.then(() => this.runTurn(agent, processState, sessionState, delivery, prompt));
    sessionState.inflight = turn.catch(() => {});
    return turn;
  }

  async cancelDelivery(deliveryId: string): Promise<void> {
    this.cancelledDeliveryIds.add(deliveryId);
    for (const processState of this.processes) {
      for (const sessionState of processState.sessions.values()) {
        if (sessionState.activeDeliveryId !== deliveryId) continue;
        try {
          processState.rpc.notify("session/cancel", { sessionId: sessionState.sessionId });
        } catch {}
      }
    }
  }

  private async ensureSession(agent: Agent, processState: ProcessState, sessionKey: string): Promise<AcpSessionState> {
    const existing = processState.sessions.get(sessionKey);
    if (existing) return existing;

    const sessionResult = await processState.rpc.request<{ sessionId: string }>("session/new", {
      cwd: processState.workspace.dir,
      mcpServers: buildMcpServers(processState.workspace)
    });
    const sessionState: AcpSessionState = {
      key: sessionKey,
      sessionId: sessionResult.sessionId,
      inflight: Promise.resolve()
    };
    processState.sessions.set(sessionKey, sessionState);
    this.emit({
      type: "session_started",
      agentId: agent.id,
      launchId: this.launchId,
      sessionId: sessionState.sessionId,
      at: nowIso()
    });
    return sessionState;
  }

  private async runTurn(
    agent: Agent,
    processState: ProcessState,
    sessionState: AcpSessionState,
    delivery: DeliveryWithContext,
    prompt: string
  ): Promise<DeliverResult> {
    const { rpc } = processState;
    const { sessionId } = sessionState;
    const accumulator: string[] = [];
    const offEvent = this.on(event => {
      if (event.type !== "message_chunk") return;
      if (event.sessionId && event.sessionId !== sessionId) return;
      if (event.text) accumulator.push(event.text);
    });

    const MAX_PROMPT_BYTES = 64000;
    let finalPrompt = prompt;
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
      const truncated = Buffer.from(prompt.slice(0, Math.floor(MAX_PROMPT_BYTES * 0.8)), "utf8")
        .toString("utf8")
        .slice(0, Math.floor(MAX_PROMPT_BYTES * 0.8));
      finalPrompt = truncated + "\n\n[Note: prompt was truncated due to length limits]";
      console.log(`[${nowIso()}] [AcpDriver] prompt truncated: ${Buffer.byteLength(prompt, "utf8")} -> ${Buffer.byteLength(finalPrompt, "utf8")} bytes (session=${sessionId})`);
    }

    try {
      if (this.cancelledDeliveryIds.has(delivery.id)) {
        throw new Error(`delivery ${delivery.id} was cancelled`);
      }
      sessionState.activeDeliveryId = delivery.id;
      sessionState.activeTarget = delivery.target;
      console.log(`[${nowIso()}] [AcpDriver] session/prompt (session=${sessionId}, prompt-bytes=${Buffer.byteLength(finalPrompt, "utf8")})`);
      const result = await withIdleTimeout(
        rpc.request<{ stopReason: string }>("session/prompt", {
          sessionId: sessionId,
          prompt: [{ type: "text", text: finalPrompt }]
        }),
        TURN_IDLE_TIMEOUT_MS,
        `${agent.runtime} response idle timeout`,
        touch => {
          sessionState.touchTurn = touch;
        }
      );
      if (this.cancelledDeliveryIds.has(delivery.id)) {
        throw new Error(`delivery ${delivery.id} was cancelled`);
      }
      const text = accumulator.join("").trim() || "(No response)";
      this.emit({
        type: "turn_end",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: sessionId,
        deliveryId: delivery.id,
        target: delivery.target,
        at: nowIso(),
        text,
        reason: result.stopReason
      });
      return { ok: true, text };
    } catch (error) {
      const err = error as Error;
      this.emit({
        type: "error",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: sessionId,
        deliveryId: delivery.id,
        target: delivery.target,
        at: nowIso(),
        message: err.message
      });
      if (err.message.includes("idle timeout")) {
        try {
          rpc.notify("session/cancel", { sessionId: sessionId });
        } catch {}
        // Kill just this specific process
        try {
          processState.child.kill("SIGTERM");
        } catch {}
        this.processes = this.processes.filter(p => p !== processState);
      }
      throw err;
    } finally {
      sessionState.touchTurn = undefined;
      sessionState.activeDeliveryId = undefined;
      sessionState.activeTarget = undefined;
      offEvent();
    }
  }

  private async handleAgentRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      const opts = (params as { options?: { optionId: string }[] } | null)?.options || [];
      const choice = opts[0]?.optionId;
      return {
        outcome: choice
          ? { outcome: "selected", optionId: choice }
          : { outcome: "cancelled" }
      };
    }
    throw new Error(`unsupported acp request: ${method}`);
  }

  private handleAgentNotification(agent: Agent, method: string, params: unknown, boundSessionId?: string): void {
    if (method !== "session/update") return;
    const payload = (params || {}) as {
      sessionId?: string;
      update?: Record<string, unknown>;
    };
    const update = payload.update || {};
    const kind = String(update.sessionUpdate || "");
    const sessionId = payload.sessionId || boundSessionId;
    const sessionState = this.findSessionState(sessionId);
    sessionState?.touchTurn?.();
    const common = {
      agentId: agent.id,
      launchId: this.launchId,
      sessionId,
      deliveryId: sessionState?.activeDeliveryId,
      target: sessionState?.activeTarget,
      at: nowIso()
    };

    switch (kind) {
      case "agent_message_chunk": {
        const text = extractContentText(update.content);
        if (!text) return;
        this.emit({
          type: "message_chunk",
          ...common,
          final: false,
          text
        });
        return;
      }
      case "agent_thought_chunk": {
        const text = extractContentText(update.content);
        if (!text) return;
        this.emit({
          type: "thinking",
          ...common,
          text
        });
        return;
      }
      case "tool_call": {
        const toolCallId = String(update.toolCallId || "");
        if (!toolCallId) return;
        this.emit({
          type: "tool_call",
          ...common,
          toolName: String(update.title || update.kind || "tool"),
          toolCallId,
          arguments: update.rawInput
        });
        return;
      }
      case "tool_call_update": {
        const toolCallId = String(update.toolCallId || "");
        if (!toolCallId) return;
        const status = String(update.status || "");
        if (status !== "completed" && status !== "failed") return;
        this.emit({
          type: "tool_result",
          ...common,
          toolCallId,
          ok: status === "completed",
          output: update.rawOutput ?? update.content
        });
        return;
      }
      case "plan": {
        const items = extractPlanEntries(update.entries);
        if (items.length === 0) return;
        this.emit({
          type: "plan",
          ...common,
          items
        });
        return;
      }
      default:
        return;
    }
  }

  private findSessionState(sessionId: string | undefined): AcpSessionState | undefined {
    if (!sessionId) return undefined;
    for (const processState of this.processes) {
      for (const sessionState of processState.sessions.values()) {
        if (sessionState.sessionId === sessionId) return sessionState;
      }
    }
    return undefined;
  }

  async stop(_agent: Agent): Promise<void> {
    for (const processState of this.processes) {
      for (const sessionState of processState.sessions.values()) {
        try {
          processState.rpc.notify("session/cancel", { sessionId: sessionState.sessionId });
        } catch {}
      }
      processState.rpc.stop();
      if (!processState.child.killed) {
        try {
          processState.child.kill("SIGTERM");
        } catch {}
      }
    }
    this.processes = [];
    this.startPromises = [];
  }
}

function buildAcpSpec(agent: Agent, workspace: AgentWorkspaceLayout): AcpRuntimeSpec {
  const profile = resolveAcpRuntimeProfile(agent.runtime);
  if (profile) {
    const params = { agent, workspace, timeoutMs: TURN_IDLE_TIMEOUT_MS };
    return {
      command: profile.command,
      args: renderAcpProfileArgs(profile, params),
      cwd: renderAcpProfileCwd(profile, params),
      env: renderAcpProfileEnv(profile, params)
    };
  }
  // Codex's `app-server` speaks a proprietary dialect (Initialize/TurnStart/
  // AgentMessageDelta), not ACP — see `codex app-server generate-json-schema`.
  // Claude has its own stream-json wire format and lives in ClaudeDriver.
  // Other ACP runtimes can be configured with ITEAM_ACP_RUNTIMES.
  throw new Error(`acp driver does not support runtime: ${agent.runtime}`);
}

interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: { name: string; value: string }[];
}

function buildMcpServers(workspace: AgentWorkspaceLayout): AcpMcpServer[] {
  return [
    {
      name: "chat",
      command: workspace.bridgeCommand,
      args: workspace.bridgeArgs,
      env: []
    }
  ];
}

interface ContentBlockText {
  type: "text";
  text?: string;
  thinking?: string;
  resource?: { text?: string };
}

function extractContentText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(item => extractContentText(item)).join("");
  const block = content as ContentBlockText;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (typeof block.text === "string") return block.text;
  if (typeof block.thinking === "string") return block.thinking;
  if (typeof block.resource?.text === "string") return block.resource.text;
  return "";
}

function extractPlanEntries(value: unknown): Array<{ id: string; content: string; status?: string; priority?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) return [];
    return [{
      id: typeof record.id === "string" && record.id ? record.id : `plan-${index + 1}`,
      content,
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      ...(typeof record.priority === "string" ? { priority: record.priority } : {})
    }];
  });
}

function sessionKeyForDelivery(delivery: DeliveryWithContext): string {
  const explicit = delivery.sessionKey?.trim();
  if (explicit) return safeSessionKey(explicit);
  if (delivery.target.includes(":msg_")) return safeSessionKey(delivery.target);
  return DEFAULT_SESSION_KEY;
}

function safeSessionKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96) || DEFAULT_SESSION_KEY;
}

function hashIndex(key: string, poolSize: number): number {
  if (poolSize <= 1) return 0;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % poolSize;
}

function withIdleTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  bindTouch: (touch: () => void) => void
): Promise<T> {
  let timer: NodeJS.Timeout;
  let rejectTimeout: (error: Error) => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
  };
  bindTouch(touch);
  touch();
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readPositiveMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
