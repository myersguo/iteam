// ClaudeDriver — long-lived `claude` CLI client speaking stream-json.
//
// Spawns `claude -p --input-format stream-json --output-format stream-json
// --verbose`, keeps the process around across deliveries, and feeds it one
// user message at a time. Translates stream-json events into the unified
// AgentEvent envelope so the launcher and UI never see the wire format.
//
// Why our own driver instead of `@agentclientprotocol/claude-agent-acp`?
//  - The ACP wrapper depends on resolving an npm bin via npx/node_modules,
//    which is fragile in production daemon environments (PATH gaps, cache
//    misses, exit 127 with no diagnostic).
//  - stream-json is Anthropic's documented headless protocol — same surface
//    iteam's legacy `--append-system-prompt-file` path already used.
//  - Pattern mirrors CodexDriver: persistent pool, round-robin delivery,
//    per-process inflight chain for in-flight queuing.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { nowIso, defaultHome } from "../lib.js";
import { agentEnv, prepareAgentWorkspace, type AgentWorkspaceLayout } from "../workspace.js";
import type { Agent, DeliveryWithContext } from "../types.js";
import type { AgentDriver, AgentEventListener, DeliverResult, DeliveryMode, DriverCapabilities } from "./driver.js";
import type { AgentEvent } from "./events.js";

const TURN_TIMEOUT_MS = 300000;
const PROCESS_POOL_SIZE = 3;

export interface ClaudeDriverOptions {
  serverUrl: string;
  launchId: string;
  computerId?: string;
  connectToken?: string;
}

interface PendingTurn {
  resolve: (result: DeliverResult) => void;
  reject: (err: Error) => void;
  accumulator: string[];
  timer: ReturnType<typeof setTimeout>;
}

interface ProcessState {
  child: ChildProcessWithoutNullStreams;
  workspace: AgentWorkspaceLayout;
  sessionId: string | null;
  // Single in-flight turn per process. claude stream-json reads one user
  // message at a time and emits a terminal `result` event before becoming
  // ready for the next prompt. Serialise here so deliveries don't race.
  pending: PendingTurn | null;
  // Outstanding deliveries waiting for their turn on this process.
  inflight: Promise<unknown>;
  stdoutBuf: string;
  // Tool calls in progress: track partial input JSON deltas keyed by block index.
  toolBlocks: Map<number, { id: string; name: string; inputJson: string }>;
}

export class ClaudeDriver implements AgentDriver {
  readonly runtime: string;
  readonly deliveryMode: DeliveryMode = "direct";
  readonly capabilities: DriverCapabilities = {
    lifecycle: "persistent",
    inFlightWake: "queue",
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

  constructor(runtime: string, opts: ClaudeDriverOptions) {
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
      const p = this.doStart(agent, processIndex).catch(error => {
        this.startPromises = this.startPromises.filter(x => x !== p);
        throw error;
      });
      this.startPromises.push(p);
    }
    if (this.startPromises.length > 0) {
      await Promise.all(this.startPromises);
    }
  }

  private async doStart(agent: Agent, processIndex: number): Promise<void> {
    const poolAgent = { ...agent };
    const baseLocalDir = join(defaultHome(), "agents", agent.id);
    const baseRequestedDir = agent.workspacePath || baseLocalDir;
    poolAgent.workspacePath = `${baseRequestedDir}-pool-${processIndex}`;

    const workspace = prepareAgentWorkspace({
      agent: poolAgent,
      serverUrl: this.serverUrl,
      launchId: this.launchId,
      computerId: this.computerId,
      connectToken: this.connectToken
    });
    workspace.bridgeArgs = workspace.bridgeArgs.map(arg =>
      arg === poolAgent.id ? agent.id : arg
    );

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--disallowed-tools", "EnterPlanMode,ExitPlanMode,ScheduleWakeup,CronCreate,CronList,CronDelete",
      "--append-system-prompt-file", workspace.systemPromptPath,
      "--mcp-config", workspace.claudeMcpConfigPath,
      "--strict-mcp-config"
    ];
    if (agent.model) args.push("--model", agent.model);

    const child = spawn("claude", args, {
      cwd: workspace.dir,
      env: agentEnv({ agent, serverUrl: this.serverUrl, workspace }),
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;

    const state: ProcessState = {
      child,
      workspace,
      sessionId: null,
      pending: null,
      inflight: Promise.resolve(),
      stdoutBuf: "",
      toolBlocks: new Map()
    };

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(agent, state, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.emit({
        type: "error",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: state.sessionId || undefined,
        at: nowIso(),
        message: `[claude stderr] ${text.trim()}`
      });
    });
    child.on("exit", (code, signal) => {
      this.emit({
        type: "exited",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: state.sessionId || undefined,
        at: nowIso(),
        code,
        signal
      });
      if (state.pending) {
        const err = new Error(`claude exited code=${code} signal=${signal} mid-turn`);
        clearTimeout(state.pending.timer);
        state.pending.reject(err);
        state.pending = null;
      }
      this.processes = this.processes.filter(p => p !== state);
    });

    // claude in stream-json mode doesn't emit `system/init` until the first
    // user message triggers turn setup, so there's no upfront handshake to
    // await. Wait only for the `spawn` event (or an early exit) so callers
    // know the process actually launched. The session id is captured on the
    // first deliver()'s init event and flows into AgentEvents from then on.
    await new Promise<void>((resolve, reject) => {
      const startTimer = setTimeout(() => {
        cleanup();
        reject(new Error("claude did not spawn within 10s"));
      }, 10000);
      const onSpawn = () => { cleanup(); resolve(); };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`claude exited code=${code} before spawn`));
      };
      const cleanup = () => {
        clearTimeout(startTimer);
        child.off("spawn", onSpawn);
        child.off("exit", onExit);
      };
      child.once("spawn", onSpawn);
      child.once("exit", onExit);
    });

    this.processes.push(state);
  }

  async deliver(agent: Agent, _delivery: DeliveryWithContext, prompt: string): Promise<DeliverResult> {
    await this.start(agent);
    if (this.processes.length === 0) throw new Error("claude processes not initialized");

    const state = this.processes[this.nextProcessIndex % this.processes.length];
    this.nextProcessIndex++;

    const turn = state.inflight.then(() => this.runTurn(agent, state, prompt));
    state.inflight = turn.catch(() => {});
    return turn;
  }

  private runTurn(agent: Agent, state: ProcessState, prompt: string): Promise<DeliverResult> {
    return new Promise<DeliverResult>((resolve, reject) => {
      if (state.pending) {
        reject(new Error("claude process already has a pending turn"));
        return;
      }

      const MAX_PROMPT_BYTES = 64000;
      let finalPrompt = prompt;
      if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
        const truncated = Buffer.from(prompt.slice(0, Math.floor(MAX_PROMPT_BYTES * 0.8)), "utf8")
          .toString("utf8")
          .slice(0, Math.floor(MAX_PROMPT_BYTES * 0.8));
        finalPrompt = truncated + "\n\n[Note: prompt was truncated due to length limits]";
      }

      const timer = setTimeout(() => {
        if (state.pending) {
          state.pending = null;
          try { state.child.kill("SIGTERM"); } catch {}
          this.processes = this.processes.filter(p => p !== state);
          reject(new Error("claude response timed out"));
        }
      }, TURN_TIMEOUT_MS);

      state.pending = { resolve, reject, accumulator: [], timer };

      const userMessage = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: finalPrompt }]
        }
      };
      try {
        state.child.stdin.write(JSON.stringify(userMessage) + "\n");
      } catch (error) {
        clearTimeout(timer);
        state.pending = null;
        reject(error as Error);
      }
    });
  }

  private handleStdout(agent: Agent, state: ProcessState, chunk: Buffer): void {
    state.stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = state.stdoutBuf.indexOf("\n")) !== -1) {
      const line = state.stdoutBuf.slice(0, nl).trim();
      state.stdoutBuf = state.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Non-JSON line — claude shouldn't emit any in stream-json mode, but
        // surface them as stderr so a regression doesn't disappear silently.
        this.emit({
          type: "error",
          agentId: agent.id,
          launchId: this.launchId,
          sessionId: state.sessionId || undefined,
          at: nowIso(),
          message: `[claude non-json] ${line.slice(0, 500)}`
        });
        continue;
      }
      this.handleStreamEvent(agent, state, ev);
    }
  }

  private handleStreamEvent(agent: Agent, state: ProcessState, ev: Record<string, unknown>): void {
    const type = String(ev.type || "");
    const subtype = String(ev.subtype || "");

    if (type === "system" && subtype === "init") {
      const sessionId = String(ev.session_id || "");
      if (sessionId && !state.sessionId) {
        state.sessionId = sessionId;
        this.emit({
          type: "session_started",
          agentId: agent.id,
          launchId: this.launchId,
          sessionId,
          at: nowIso()
        });
      }
      return;
    }

    if (type === "stream_event") {
      const innerEv = (ev.event || {}) as Record<string, unknown>;
      const innerType = String(innerEv.type || "");
      const index = Number(innerEv.index ?? -1);

      if (innerType === "content_block_start") {
        const block = (innerEv.content_block || {}) as Record<string, unknown>;
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          state.toolBlocks.set(index, { id: block.id, name: block.name, inputJson: "" });
          this.emit({
            type: "tool_call",
            agentId: agent.id,
            launchId: this.launchId,
            sessionId: state.sessionId || undefined,
            at: nowIso(),
            toolName: block.name,
            toolCallId: block.id,
            arguments: block.input ?? null
          });
        }
        return;
      }

      if (innerType === "content_block_delta") {
        const delta = (innerEv.delta || {}) as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          state.pending?.accumulator.push(delta.text);
          this.emit({
            type: "message_chunk",
            agentId: agent.id,
            launchId: this.launchId,
            sessionId: state.sessionId || undefined,
            at: nowIso(),
            final: false,
            text: delta.text
          });
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const tool = state.toolBlocks.get(index);
          if (tool) tool.inputJson += delta.partial_json;
        }
        return;
      }

      if (innerType === "content_block_stop") {
        state.toolBlocks.delete(index);
        return;
      }

      // message_start / message_delta / message_stop: handled via `result`
      return;
    }

    if (type === "user") {
      // Tool result coming back from one of our MCP tools.
      const msg = (ev.message || {}) as Record<string, unknown>;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          this.emit({
            type: "tool_result",
            agentId: agent.id,
            launchId: this.launchId,
            sessionId: state.sessionId || undefined,
            at: nowIso(),
            toolCallId: b.tool_use_id,
            ok: b.is_error !== true,
            output: b.content ?? null
          });
        }
      }
      return;
    }

    if (type === "result") {
      const stopReason = String(ev.stop_reason || ev.subtype || "");
      const isError = ev.is_error === true || subtype === "error";
      const finalText = String(ev.result || "");
      this.emit({
        type: "turn_end",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: state.sessionId || undefined,
        at: nowIso(),
        text: finalText,
        reason: stopReason
      });
      const pending = state.pending;
      if (pending) {
        clearTimeout(pending.timer);
        state.pending = null;
        if (isError) {
          pending.reject(new Error(finalText || `claude turn failed (${subtype})`));
        } else {
          const text = (finalText || pending.accumulator.join("")).trim() || "(No response)";
          pending.resolve({ ok: true, text });
        }
      }
      return;
    }

    // system/status, system/hook_*, rate_limit_event, assistant (post-stream
    // aggregate), etc. — informational only; the stream_event deltas and the
    // terminal `result` already cover everything the launcher needs.
  }

  async stop(_agent: Agent): Promise<void> {
    for (const state of this.processes) {
      if (state.pending) {
        clearTimeout(state.pending.timer);
        state.pending.reject(new Error("claude driver stopping"));
        state.pending = null;
      }
      try { state.child.stdin.end(); } catch {}
      if (!state.child.killed) {
        try { state.child.kill("SIGTERM"); } catch {}
      }
    }
    this.processes = [];
    this.startPromises = [];
  }
}
