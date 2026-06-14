// CodexDriver — long-lived JSON-RPC 2.0 client for `codex app-server`.
//
// Spawns `codex app-server --listen stdio://`, performs the initialize/
// thread/start handshake once, and reuses the same thread for every
// deliver() call. Uses `turn/steer` for busy-delivery (direct mode) so
// new prompts can interleave on top of an existing turn.
//
// Protocol reference: codex app-server generate-json-schema

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { nowIso } from "../lib.js";
import { agentEnv, prepareAgentWorkspace, type AgentWorkspaceLayout } from "../workspace.js";
import type { Agent, DeliveryWithContext } from "../types.js";
import { deliveryAffinityIndex, type AgentDriver, type AgentEventListener, type DeliverResult, type DeliveryMode, type DriverCapabilities } from "./driver.js";
import type { AgentEvent } from "./events.js";
import { JsonRpcStdioClient } from "./jsonrpc.js";

const TURN_IDLE_TIMEOUT_MS = readPositiveMs("ITEAM_AGENT_IDLE_TIMEOUT_MS", 6 * 60 * 60 * 1000);
const PROCESS_POOL_SIZE = 3;

export interface CodexDriverOptions {
  serverUrl: string;
  launchId: string;
  computerId?: string;
  connectToken?: string;
}

interface ProcessState {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcStdioClient;
  threadId: string;
  activeTurnId: string | null;
  workspace: AgentWorkspaceLayout;
  inflight: Promise<unknown>;
  streamedMessageIds: Set<string>;
  streamedReasoningIds: Set<string>;
  touchTurn?: () => void;
  activeDelivery?: Pick<DeliveryWithContext, "id" | "target">;
}

export class CodexDriver implements AgentDriver {
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

  constructor(runtime: string, opts: CodexDriverOptions) {
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
    if (this.processes.length === 0 && this.startPromises.length === 0) return false;
    return this.processes.some(p => p.child.exitCode === null && p.child.signalCode === null);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async start(agent: Agent): Promise<void> {
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
    const child = spawn("codex", [
      "app-server",
      "--listen", "stdio://",
      "-c", `mcp_servers.chat.command=${JSON.stringify(workspace.bridgeCommand)}`,
      "-c", `mcp_servers.chat.args=${JSON.stringify(workspace.bridgeArgs)}`,
      "-c", "mcp_servers.chat.startup_timeout_sec=30",
      "-c", "mcp_servers.chat.tool_timeout_sec=300",
      "-c", "mcp_servers.chat.enabled=true",
      "-c", "mcp_servers.chat.required=true"
    ], {
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
        sessionId: processState?.threadId,
        at: nowIso(),
        code,
        signal
      });
      this.processes = this.processes.filter(p => p !== processState);
    });

    const rpc = new JsonRpcStdioClient(child, {
      onRequest: () => Promise.resolve({}),
      onNotification: (method, params) => this.handleNotification(agent, method, params, processState)
    });

    // 1) initialize
    await rpc.request("initialize", {
      clientInfo: { name: "iteam-daemon", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });

    // 2) initialized notification
    rpc.notify("initialized", {});

    // 3) thread/start
    const threadResult = await rpc.request<{ thread: { id: string } }>("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: { model_reasoning_effort: "high" }
    });

    const threadId = threadResult.thread.id;

    processState = {
      child,
      rpc,
      threadId,
      activeTurnId: null,
      workspace,
      inflight: Promise.resolve(),
      streamedMessageIds: new Set(),
      streamedReasoningIds: new Set()
    };

    this.processes.push(processState);

    this.emit({
      type: "session_started",
      agentId: agent.id,
      launchId: this.launchId,
      sessionId: threadId,
      at: nowIso()
    });
  }

  async deliver(agent: Agent, delivery: DeliveryWithContext, prompt: string): Promise<DeliverResult> {
    await this.start(agent);
    if (this.processes.length === 0) throw new Error("codex processes not initialized");

    const processState = this.processes[deliveryAffinityIndex(delivery, this.processes.length)];

    const turn = processState.inflight.then(() => this.runTurn(agent, processState, prompt, delivery));
    processState.inflight = turn.catch(() => {});
    return turn;
  }

  private async runTurn(
    agent: Agent,
    ps: ProcessState,
    prompt: string,
    delivery?: DeliveryWithContext
  ): Promise<DeliverResult> {
    const { rpc, threadId } = ps;
    const accumulator: string[] = [];
    const offEvent = this.on(event => {
      if (event.type !== "message_chunk") return;
      if (event.sessionId && event.sessionId !== threadId) return;
      if (event.text) accumulator.push(event.text);
    });

    const MAX_PROMPT_BYTES = 64000;
    let finalPrompt = prompt;
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
      const truncated = Buffer.from(prompt.slice(0, Math.floor(MAX_PROMPT_BYTES * 0.8)), "utf8")
        .toString("utf8")
        .slice(0, Math.floor(MAX_PROMPT_BYTES * 0.8));
      finalPrompt = truncated + "\n\n[Note: prompt was truncated due to length limits]";
    }

    try {
      ps.activeDelivery = delivery ? { id: delivery.id, target: delivery.target } : undefined;
      // If there's an active turn, use turn/steer; otherwise turn/start
      if (ps.activeTurnId) {
        const steerResult = await rpc.request<{ turn?: { id: string }; turnId?: string }>("turn/steer", {
          threadId,
          expectedTurnId: ps.activeTurnId,
          input: [{ type: "text", text: finalPrompt }]
        });
        // turn/steer may return a new turn id
        const newTurnId = steerResult.turn?.id || steerResult.turnId;
        if (newTurnId) ps.activeTurnId = newTurnId;
      } else {
        const turnResult = await rpc.request<{ turn?: { id: string }; turnId?: string }>("turn/start", {
          threadId,
          input: [{ type: "text", text: finalPrompt }]
        });
        ps.activeTurnId = turnResult.turn?.id || turnResult.turnId || null;
      }

      // Wait for turn/completed
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout;
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            cleanup();
            reject(new Error("codex response idle timeout"));
          }, TURN_IDLE_TIMEOUT_MS);
        };
        const cleanup = () => {
          clearTimeout(timer);
          off();
          if (ps.touchTurn === touch) ps.touchTurn = undefined;
        };
        const off = this.on(event => {
          if (event.type === "turn_end" && event.sessionId === threadId) {
            cleanup();
            resolve();
          }
          if (event.type === "error" && event.sessionId === threadId) {
            cleanup();
            reject(new Error((event as { message: string }).message));
          }
        });
        ps.touchTurn = touch;
        touch();
      });

      const text = accumulator.join("").trim() || "(No response)";
      return { ok: true, text };
    } catch (error) {
      const err = error as Error;
      this.emit({
        type: "error",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: threadId,
        at: nowIso(),
        message: err.message
      });
      if (err.message.includes("idle timeout")) {
        try { ps.child.kill("SIGTERM"); } catch {}
        this.processes = this.processes.filter(p => p !== ps);
      }
      throw err;
    } finally {
      ps.activeDelivery = undefined;
      offEvent();
    }
  }

  private handleNotification(
    agent: Agent,
    method: string,
    params: unknown,
    ps: ProcessState | null
  ): void {
    const p = (params || {}) as Record<string, unknown>;
    if (ps && !notificationBelongsToThread(p, ps.threadId)) {
      return;
    }
    ps?.touchTurn?.();
    const deliveryContext = ps?.activeDelivery
      ? { deliveryId: ps.activeDelivery.id, target: ps.activeDelivery.target }
      : {};

    switch (method) {
      case "turn/started": {
        const turn = p.turn as { id?: string } | undefined;
        if (turn?.id) {
          if (ps) ps.activeTurnId = turn.id;
        }
        this.emit({
          type: "thinking",
          agentId: agent.id,
          launchId: this.launchId,
          sessionId: ps?.threadId,
          at: nowIso(),
          text: ""
        });
        return;
      }

      case "item/agentMessage/delta": {
        const delta = p.delta;
        const itemId = p.itemId;
        if (typeof itemId === "string" && ps) {
          ps.streamedMessageIds.add(itemId);
        }
        if (typeof delta === "string" && delta.length > 0) {
          this.emit({
            type: "message_chunk",
            agentId: agent.id,
            launchId: this.launchId,
            sessionId: ps?.threadId,
            at: nowIso(),
            final: false,
            text: delta
          });
        }
        return;
      }

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = p.delta;
        const itemId = p.itemId;
        if (typeof itemId === "string" && ps) {
          ps.streamedReasoningIds.add(itemId);
        }
        if (typeof delta === "string" && delta.length > 0) {
          this.emit({
            type: "thinking",
            agentId: agent.id,
            launchId: this.launchId,
            sessionId: ps?.threadId,
            at: nowIso(),
            text: delta
          });
        }
        return;
      }

      case "item/started":
      case "item/completed": {
        const item = p.item as Record<string, unknown> | undefined;
        if (!item || typeof item.type !== "string") return;
        const isStarted = method === "item/started";
        const isCompleted = method === "item/completed";

        switch (item.type) {
          case "agentMessage": {
            if (isCompleted && typeof item.id === "string" && ps && !ps.streamedMessageIds.has(item.id)) {
              if (typeof item.text === "string" && item.text.length > 0) {
                this.emit({
                  type: "message_chunk",
                  agentId: agent.id,
                  launchId: this.launchId,
                  sessionId: ps.threadId,
                  at: nowIso(),
                  final: false,
                  text: item.text
                });
              }
            }
            if (isCompleted && typeof item.id === "string" && ps) {
              ps.streamedMessageIds.delete(item.id);
            }
            return;
          }
          case "reasoning": {
            if (isCompleted && typeof item.id === "string" && ps && !ps.streamedReasoningIds.has(item.id)) {
              const summary = Array.isArray(item.summary) ? item.summary.filter((e: unknown) => typeof e === "string").join("\n") : "";
              const content = Array.isArray(item.content) ? item.content.filter((e: unknown) => typeof e === "string").join("\n") : "";
              const text = [summary, content].filter(Boolean).join("\n").trim();
              if (text) {
                this.emit({
                  type: "thinking",
                  agentId: agent.id,
                  launchId: this.launchId,
                  sessionId: ps.threadId,
                  at: nowIso(),
                  text
                });
              }
            }
            if (isCompleted && typeof item.id === "string" && ps) {
              ps.streamedReasoningIds.delete(item.id);
            }
            return;
          }
          case "commandExecution": {
            if (isStarted && typeof item.command === "string") {
              this.emit({
                type: "tool_call",
                agentId: agent.id,
                launchId: this.launchId,
                sessionId: ps?.threadId,
                at: nowIso(),
                ...deliveryContext,
                toolName: "shell",
                toolCallId: item.id as string || "",
                arguments: { command: item.command }
              });
            }
            return;
          }
          case "fileChange": {
            if (isStarted && Array.isArray(item.changes)) {
              for (const change of item.changes as Array<{ path?: string; kind?: string }>) {
                this.emit({
                  type: "tool_call",
                  agentId: agent.id,
                  launchId: this.launchId,
                  sessionId: ps?.threadId,
                  at: nowIso(),
                  ...deliveryContext,
                  toolName: "file_change",
                  toolCallId: item.id as string || "",
                  arguments: { path: change.path, kind: change.kind }
                });
              }
            }
            return;
          }
          case "mcpToolCall": {
            if (isStarted) {
              const toolName = item.server === "chat"
                ? `mcp_chat_${item.tool}`
                : `mcp_${item.server}_${item.tool}`;
              this.emit({
                type: "tool_call",
                agentId: agent.id,
                launchId: this.launchId,
                sessionId: ps?.threadId,
                at: nowIso(),
                ...deliveryContext,
                toolName,
                toolCallId: item.id as string || "",
                arguments: item.arguments
              });
            }
            return;
          }
          case "webSearch": {
            if (isStarted) {
              this.emit({
                type: "tool_call",
                agentId: agent.id,
                launchId: this.launchId,
                sessionId: ps?.threadId,
                at: nowIso(),
                ...deliveryContext,
                toolName: "web_search",
                toolCallId: item.id as string || "",
                arguments: { query: item.query }
              });
            }
            return;
          }
          case "collabAgentToolCall": {
            const toolName = `subagent_${String(item.tool || "unknown")}`;
            if (isStarted) {
              this.emit({
                type: "tool_call",
                agentId: agent.id,
                launchId: this.launchId,
                sessionId: ps?.threadId,
                at: nowIso(),
                ...deliveryContext,
                toolName,
                toolCallId: item.id as string || "",
                arguments: {
                  prompt: item.prompt,
                  model: item.model,
                  receiverThreadIds: item.receiverThreadIds,
                  status: item.status
                }
              });
            }
            if (isCompleted) {
              const status = String(item.status || "");
              this.emit({
                type: "tool_result",
                agentId: agent.id,
                launchId: this.launchId,
                sessionId: ps?.threadId,
                at: nowIso(),
                ...deliveryContext,
                toolCallId: item.id as string || "",
                ok: status !== "failed",
                output: {
                  tool: item.tool,
                  status,
                  agentsStates: item.agentsStates
                }
              });
            }
            return;
          }
        }
        return;
      }

      case "turn/completed": {
        const turn = p.turn as { status?: string; error?: { message?: string } } | undefined;
        if (turn?.status === "failed" && turn?.error?.message) {
          this.emit({
            type: "error",
            agentId: agent.id,
            launchId: this.launchId,
            sessionId: ps?.threadId,
            at: nowIso(),
            message: turn.error.message
          });
        }
        if (ps) {
          ps.activeTurnId = null;
          ps.streamedMessageIds.clear();
          ps.streamedReasoningIds.clear();
        }
        this.emit({
          type: "turn_end",
          agentId: agent.id,
          launchId: this.launchId,
          sessionId: ps?.threadId,
          at: nowIso(),
          text: ""
        });
        return;
      }

      case "error": {
        const msg = typeof p.message === "string" ? p.message
          : (p.error as { message?: string })?.message;
        if (msg) {
          this.emit({
            type: "error",
            agentId: agent.id,
            launchId: this.launchId,
            sessionId: ps?.threadId,
            at: nowIso(),
            message: msg
          });
        }
        return;
      }
    }
  }

  async stop(_agent: Agent): Promise<void> {
    for (const ps of this.processes) {
      try { ps.rpc.stop(); } catch {}
      if (!ps.child.killed) {
        try { ps.child.kill("SIGTERM"); } catch {}
      }
    }
    this.processes = [];
    this.startPromises = [];
  }
}

function readPositiveMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function notificationBelongsToThread(params: Record<string, unknown>, threadId: string): boolean {
  return typeof params.threadId !== "string" || params.threadId === threadId;
}
