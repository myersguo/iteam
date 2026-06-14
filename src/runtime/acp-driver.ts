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
import { deliveryAffinityIndex, type AgentDriver, type AgentEventListener, type DeliverResult, type DeliveryMode, type DriverCapabilities } from "./driver.js";
import type { AgentEvent } from "./events.js";
import { JsonRpcStdioClient } from "./jsonrpc.js";

/** ACP protocol version this client speaks. Negotiated down on initialize. */
const PROTOCOL_VERSION = 1;
const TURN_IDLE_TIMEOUT_MS = readPositiveMs("ITEAM_AGENT_IDLE_TIMEOUT_MS", 6 * 60 * 60 * 1000);
const PROCESS_POOL_SIZE = 3;

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

interface ProcessState {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcStdioClient;
  sessionId: string;
  workspace: AgentWorkspaceLayout;
  inflight: Promise<unknown>;
  touchTurn?: () => void;
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
  private nextProcessIndex = 0;
  private startPromises: Promise<void>[] = [];

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
    // Start up to PROCESS_POOL_SIZE processes
    while (this.processes.length + this.startPromises.length < PROCESS_POOL_SIZE) {
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
      cwd,
      env: agentEnv({ agent, serverUrl: this.serverUrl, workspace }),
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;

    let processState: ProcessState | null = null;

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.emit({
        type: "exited",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: processState?.sessionId,
        at: nowIso(),
        code,
        signal
      });
      this.processes = this.processes.filter(p => p !== processState);
    });

    const rpc = new JsonRpcStdioClient(child, {
      onRequest: (method, params) => this.handleAgentRequest(method, params),
      onNotification: (method, params) => this.handleAgentNotification(agent, method, params, processState?.sessionId)
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

    processState = {
      child,
      rpc,
      sessionId: sessionResult.sessionId,
      workspace,
      inflight: Promise.resolve()
    };
    
    this.processes.push(processState);

    // Remove from startPromises since it's fully started
    // (the filter logic in start() handles this indirectly, but we can't easily access `p` here)

    this.emit({
      type: "session_started",
      agentId: agent.id,
      launchId: this.launchId,
      sessionId: processState.sessionId,
      at: nowIso()
    });
  }

  async deliver(agent: Agent, delivery: DeliveryWithContext, prompt: string): Promise<DeliverResult> {
    await this.start(agent);
    if (this.processes.length === 0) throw new Error("acp processes not initialized");

    const processState = this.processes[deliveryAffinityIndex(delivery, this.processes.length)];

    const turn = processState.inflight.then(() => this.runTurn(agent, processState, prompt));
    processState.inflight = turn.catch(() => {});
    return turn;
  }

  private async runTurn(
    agent: Agent,
    processState: ProcessState,
    prompt: string
  ): Promise<DeliverResult> {
    const { rpc, sessionId } = processState;
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
      console.log(`[${nowIso()}] [AcpDriver] session/prompt (session=${sessionId}, prompt-bytes=${Buffer.byteLength(finalPrompt, "utf8")})`);
      const result = await withIdleTimeout(
        rpc.request<{ stopReason: string }>("session/prompt", {
          sessionId: sessionId,
          prompt: [{ type: "text", text: finalPrompt }]
        }),
        TURN_IDLE_TIMEOUT_MS,
        `${agent.runtime} response idle timeout`,
        touch => {
          processState.touchTurn = touch;
        }
      );
      const text = accumulator.join("").trim() || "(No response)";
      this.emit({
        type: "turn_end",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: sessionId,
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
      processState.touchTurn = undefined;
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
    const processState = this.processes.find(item => item.sessionId === boundSessionId);
    processState?.touchTurn?.();
    const payload = (params || {}) as {
      sessionId?: string;
      update?: Record<string, unknown>;
    };
    const update = payload.update || {};
    const kind = String(update.sessionUpdate || "");
    const sessionId = payload.sessionId || boundSessionId;

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
        return;
    }
  }

  async stop(_agent: Agent): Promise<void> {
    for (const processState of this.processes) {
      try {
        processState.rpc.notify("session/cancel", { sessionId: processState.sessionId });
      } catch {}
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
  if (agent.runtime === "gemini") {
    const args = ["--acp", "--yolo", "--skip-trust", "--include-directories", workspace.dir];
    if (agent.model) args.unshift("-m", agent.model);
    return { command: "gemini", args };
  }
  // Codex's `app-server` speaks a proprietary dialect (Initialize/TurnStart/
  // AgentMessageDelta), not ACP — see `codex app-server generate-json-schema`.
  // Claude has its own stream-json wire format and lives in ClaudeDriver.
  // AcpDriver is currently only used for trae and gemini.
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
}

function extractContentText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  const block = content as ContentBlockText;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  return "";
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
