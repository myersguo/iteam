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
import { join } from "node:path";
import { defaultHome, nowIso } from "../lib.js";
import { agentEnv, prepareAgentWorkspace, type AgentWorkspaceLayout } from "../workspace.js";
import type { Agent, DeliveryWithContext } from "../types.js";
import type { AgentDriver, AgentEventListener, DeliverResult, DeliveryMode, DriverCapabilities } from "./driver.js";
import type { AgentEvent } from "./events.js";
import { JsonRpcStdioClient } from "./jsonrpc.js";

/** ACP protocol version this client speaks. Negotiated down on initialize. */
const PROTOCOL_VERSION = 1;
const TURN_TIMEOUT_MS = 120000;

interface AcpRuntimeSpec {
  command: string;
  args: string[];
}

export interface AcpDriverOptions {
  serverUrl: string;
  launchId: string;
  computerId?: string;
  connectToken?: string;
}

interface SessionState {
  sessionId: string;
  workspace: AgentWorkspaceLayout;
}

export class AcpDriver implements AgentDriver {
  readonly runtime: string;
  /** ACP holds a long-lived session, so new prompts deliver directly. */
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
  private child: ChildProcessWithoutNullStreams | null = null;
  private rpc: JsonRpcStdioClient | null = null;
  private session: SessionState | null = null;
  private startPromise: Promise<void> | null = null;
  /** One concurrent prompt at a time per session — direct delivery mode. */
  private inflight: Promise<unknown> = Promise.resolve();

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
    if (!this.child) return false;
    if (this.child.exitCode !== null) return false;
    if (this.child.signalCode !== null) return false;
    return true;
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async start(agent: Agent): Promise<void> {
    if (this.session) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart(agent).catch(error => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  private async doStart(agent: Agent): Promise<void> {
    const cwd = agent.workspacePath || join(defaultHome(), "agents", agent.id);
    const workspace = prepareAgentWorkspace({
      agent,
      serverUrl: this.serverUrl,
      launchId: this.launchId,
      computerId: this.computerId,
      connectToken: this.connectToken
    });
    const spec = buildAcpSpec(agent, workspace);
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: agentEnv({ agent, serverUrl: this.serverUrl, workspace }),
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.emit({
        type: "exited",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: this.session?.sessionId,
        at: nowIso(),
        code,
        signal
      });
      this.session = null;
      this.rpc = null;
      this.child = null;
      this.startPromise = null;
    });

    const rpc = new JsonRpcStdioClient(child, {
      onRequest: (method, params) => this.handleAgentRequest(method, params),
      onNotification: (method, params) => this.handleAgentNotification(agent, method, params)
    });
    this.rpc = rpc;

    // 1) initialize
    await rpc.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: { name: "iteam-daemon", version: "0.1.0" }
    });

    // 2) session/new — ACP needs absolute cwd + mcpServers (chat bridge).
    const sessionResult = await rpc.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: buildMcpServers(workspace)
    });
    this.session = { sessionId: sessionResult.sessionId, workspace };

    this.emit({
      type: "session_started",
      agentId: agent.id,
      launchId: this.launchId,
      sessionId: sessionResult.sessionId,
      at: nowIso()
    });
  }

  async deliver(agent: Agent, _delivery: DeliveryWithContext, prompt: string): Promise<DeliverResult> {
    await this.start(agent);
    if (!this.rpc || !this.session) throw new Error("acp session not initialized");
    const session = this.session;
    const rpc = this.rpc;

    // Serialize prompts on this session to match the ACP "one turn at a time"
    // contract. Each prompt waits for the previous turn to fully complete.
    const turn = this.inflight.then(() => this.runTurn(agent, rpc, session, prompt));
    this.inflight = turn.catch(() => {});
    return turn;
  }

  private async runTurn(
    agent: Agent,
    rpc: JsonRpcStdioClient,
    session: SessionState,
    prompt: string
  ): Promise<DeliverResult> {
    const accumulator: string[] = [];
    const offEvent = this.on(event => {
      if (event.type !== "message_chunk") return;
      if (event.sessionId && event.sessionId !== session.sessionId) return;
      if (event.text) accumulator.push(event.text);
    });

    try {
      const result = await withTimeout(
        rpc.request<{ stopReason: string }>("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: prompt }]
        }),
        TURN_TIMEOUT_MS,
        `${agent.runtime} response timed out`
      );
      const text = accumulator.join("").trim() || "(No response)";
      this.emit({
        type: "turn_end",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: session.sessionId,
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
        sessionId: session.sessionId,
        at: nowIso(),
        message: err.message
      });
      if (err.message.includes("timed out")) {
        this.stop(agent).catch(() => {});
      }
      throw err;
    } finally {
      offEvent();
    }
  }

  private async handleAgentRequest(method: string, params: unknown): Promise<unknown> {
    // ACP servers may ask the client for permission before running tools. We
    // run in autonomous-daemon mode, so always approve the first option.
    if (method === "session/request_permission") {
      const opts = (params as { options?: { optionId: string }[] } | null)?.options || [];
      const choice = opts[0]?.optionId;
      return {
        outcome: choice
          ? { outcome: "selected", optionId: choice }
          : { outcome: "cancelled" }
      };
    }
    // Filesystem / terminal / unhandled request — not supported in v1.
    throw new Error(`unsupported acp request: ${method}`);
  }

  private handleAgentNotification(agent: Agent, method: string, params: unknown): void {
    if (method !== "session/update") return;
    const payload = (params || {}) as {
      sessionId?: string;
      update?: Record<string, unknown>;
    };
    const update = payload.update || {};
    const kind = String(update.sessionUpdate || "");
    const sessionId = payload.sessionId || this.session?.sessionId;

    switch (kind) {
      case "agent_message_chunk": {
        const text = extractContentText(update.content);
        if (!text) return;
        this.emit({
          type: "message_chunk",
          agentId: agent.id,
          launchId: this.launchId,
          sessionId,
          at: nowIso(),
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
          agentId: agent.id,
          launchId: this.launchId,
          sessionId,
          at: nowIso(),
          text
        });
        return;
      }
      case "tool_call": {
        const toolCallId = String(update.toolCallId || "");
        if (!toolCallId) return;
        this.emit({
          type: "tool_call",
          agentId: agent.id,
          launchId: this.launchId,
          sessionId,
          at: nowIso(),
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
          agentId: agent.id,
          launchId: this.launchId,
          sessionId,
          at: nowIso(),
          toolCallId,
          ok: status === "completed",
          output: update.rawOutput ?? update.content
        });
        return;
      }
      default:
        // plan / available_commands_update / mode updates are not modeled yet.
        return;
    }
  }

  async stop(_agent: Agent): Promise<void> {
    if (this.session && this.rpc) {
      try {
        this.rpc.notify("session/cancel", { sessionId: this.session.sessionId });
      } catch {
        // Best effort — child may already be closing.
      }
    }
    this.rpc?.stop();
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Best effort.
      }
    }
    this.session = null;
    this.rpc = null;
    this.child = null;
    this.startPromise = null;
  }
}

function buildAcpSpec(agent: Agent, workspace: AgentWorkspaceLayout): AcpRuntimeSpec {
  if (agent.runtime === "trae") {
    return {
      command: "traecli",
      args: [
        "acp", "serve",
        "--add-dir", workspace.dir,
        "--yolo",
        "--disallowed-tool", "EnterPlanMode",
        "--disallowed-tool", "ExitPlanMode"
      ]
    };
  }
  // Codex's `app-server` speaks a proprietary dialect (Initialize/TurnStart/
  // AgentMessageDelta), not ACP — see `codex app-server generate-json-schema`.
  // It stays on OneshotDriver until we write a dedicated CodexAppServerDriver.
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
      command: "npx",
      args: ["tsx", ...workspace.bridgeArgs]
    }
  ];
}

interface ContentBlockText {
  type: "text";
  text?: string;
}

function extractContentText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  const block = content as ContentBlockText;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  return "";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
