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
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
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
const MAX_PROCESS_POOL_SIZE = 50;
const DEFAULT_PROCESS_POOL_SIZE = Math.min(
  MAX_PROCESS_POOL_SIZE,
  readPositiveMs("ITEAM_ACP_PROCESS_POOL_SIZE", MAX_PROCESS_POOL_SIZE)
);
const INITIAL_PROCESS_POOL_SIZE = readPositiveMs("ITEAM_ACP_INITIAL_PROCESS_POOL_SIZE", 2);
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
  slot: number;
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcStdioClient;
  defaultSessionId: string;
  workspace: AgentWorkspaceLayout;
  sessions: Map<string, AcpSessionState>;
  inflight: Promise<unknown>;
  queuedTurns: number;
  activeTurns: number;
  assignmentReservations: number;
  sessionReservations: number;
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
  private sessionPromises: Map<string, Promise<{ processState: ProcessState; sessionState: AcpSessionState }>> = new Map();
  private cancelledDeliveryIds: Set<string> = new Set();
  private maxProcessPoolSize = DEFAULT_PROCESS_POOL_SIZE;
  private nextProcessSlot = 0;

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
    this.maxProcessPoolSize = Math.min(
      MAX_PROCESS_POOL_SIZE,
      Math.max(1, Math.floor(profile?.poolSize || DEFAULT_PROCESS_POOL_SIZE))
    );
    const initialSize = Math.min(
      this.maxProcessPoolSize,
      Math.max(1, Math.floor(INITIAL_PROCESS_POOL_SIZE))
    );
    this.ensureProcessCount(agent, initialSize);
    if (this.startPromises.length > 0) {
      await Promise.all(this.startPromises);
    }
  }

  private ensureProcessCount(agent: Agent, desiredSize: number): void {
    const target = Math.min(this.maxProcessPoolSize, Math.max(1, desiredSize));
    while (this.processes.length + this.startPromises.length < target) {
      const processIndex = this.nextProcessSlot++;
      const promise = this.doStart(agent, processIndex).finally(() => {
        this.startPromises = this.startPromises.filter(item => item !== promise);
      });
      this.startPromises.push(promise);
    }
  }

  private async ensureAvailableProcess(agent: Agent): Promise<void> {
    const available = this.processes.some(processState =>
      processState.child.exitCode === null &&
      processState.child.signalCode === null &&
      processState.activeTurns === 0 &&
      processState.queuedTurns === 0 &&
      processState.assignmentReservations === 0 &&
      processState.sessionReservations === 0
    );
    if (available || this.processes.length + this.startPromises.length >= this.maxProcessPoolSize) {
      return;
    }
    const target = this.processes.length + this.startPromises.length + 1;
    this.ensureProcessCount(agent, target);
    await Promise.all(this.startPromises);
  }

  private async doStart(agent: Agent, processIndex: number): Promise<void> {
    const workspace = prepareAgentWorkspace({
      agent,
      serverUrl: this.serverUrl,
      launchId: this.launchId,
      stateSuffix: `-pool-${processIndex}`,
      computerId: this.computerId,
      connectToken: this.connectToken
    });
    
    const profile = resolveAcpRuntimeProfile(agent.runtime);
    if (!profile) {
      throw new Error(`acp driver does not support runtime: ${agent.runtime}`);
    }
    const initialParams = { agent, workspace, timeoutMs: TURN_IDLE_TIMEOUT_MS };
    const cwd = resolveEffectiveCwd(renderAcpProfileCwd(profile, initialParams), workspace.runtimeCwd);
    workspace.runtimeCwd = cwd;
    const spec = buildAcpSpec(agent, workspace, profile);
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: {
        ...agentEnv({ agent, serverUrl: this.serverUrl, workspace }),
        ...(spec.env || {}),
        ITEAM_RUNTIME_CWD: cwd,
        PWD: cwd
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
      this.processes = this.processes.filter(p => p !== processState);
      if (this.processes.some(p => p.child.exitCode === null && p.child.signalCode === null)) return;
      this.emit({
        type: "exited",
        agentId: agent.id,
        launchId: this.launchId,
        sessionId: processState?.defaultSessionId,
        at: nowIso(),
        code,
        signal
      });
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
      slot: processIndex,
      child,
      rpc,
      defaultSessionId: sessionResult.sessionId,
      workspace,
      sessions: new Map([[DEFAULT_SESSION_KEY, defaultSession]]),
      inflight: Promise.resolve(),
      queuedTurns: 0,
      activeTurns: 0,
      assignmentReservations: 0,
      sessionReservations: 0
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

    const requestedSessionKey = sessionKeyForDelivery(delivery);
    const resolved = isChannelRootDelivery(delivery)
      ? await this.resolveChannelLane(agent, delivery.target)
      : {
          ...(await this.resolveSession(agent, requestedSessionKey)),
          sessionKey: requestedSessionKey
        };
    const { processState, sessionState, sessionKey } = resolved;
    const queuePosition = processState.activeTurns + processState.queuedTurns +
      Math.max(0, processState.assignmentReservations - 1);
    processState.queuedTurns += 1;
    this.releaseProcessReservation(processState);
    this.emit({
      type: "delivery_queued",
      agentId: agent.id,
      launchId: this.launchId,
      deliveryId: delivery.id,
      target: delivery.target,
      at: nowIso(),
      queuePosition,
      sessionKey,
      processSlot: processState.slot
    });

    const turn = Promise.all([sessionState.inflight, processState.inflight]).then(async () => {
      processState.queuedTurns = Math.max(0, processState.queuedTurns - 1);
      processState.activeTurns += 1;
      this.emit({
        type: "delivery_running",
        agentId: agent.id,
        launchId: this.launchId,
        deliveryId: delivery.id,
        target: delivery.target,
        at: nowIso(),
        sessionKey,
        processSlot: processState.slot
      });
      try {
        return await this.runTurn(agent, processState, sessionState, delivery, prompt);
      } finally {
        processState.activeTurns = Math.max(0, processState.activeTurns - 1);
      }
    });
    const settledTurn = turn.catch(() => {});
    sessionState.inflight = settledTurn;
    processState.inflight = settledTurn;
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

  private async resolveSession(
    agent: Agent,
    sessionKey: string
  ): Promise<{ processState: ProcessState; sessionState: AcpSessionState }> {
    for (const processState of this.processes) {
      const existing = processState.sessions.get(sessionKey);
      if (existing) {
        this.reserveProcess(processState);
        return { processState, sessionState: existing };
      }
    }
    const pending = this.sessionPromises.get(sessionKey);
    if (pending) {
      const resolved = await pending;
      this.reserveProcess(resolved.processState);
      return resolved;
    }

    await this.ensureAvailableProcess(agent);
    const processState = this.selectAndReserveProcess();
    const promise = this.createSession(agent, sessionKey, processState).catch(error => {
      this.releaseProcessReservation(processState);
      throw error;
    }).finally(() => {
      this.sessionPromises.delete(sessionKey);
    });
    this.sessionPromises.set(sessionKey, promise);
    return promise;
  }

  private async resolveChannelLane(
    agent: Agent,
    target: string
  ): Promise<{ processState: ProcessState; sessionState: AcpSessionState; sessionKey: string }> {
    const lanePrefix = `channel:${safeSessionKey(target)}:slot:`;
    const existingLane = this.processes
      .map(processState => ({
        processState,
        sessionKey: `${lanePrefix}${processState.slot}`,
        sessionState: processState.sessions.get(`${lanePrefix}${processState.slot}`)
      }))
      .filter((lane): lane is { processState: ProcessState; sessionKey: string; sessionState: AcpSessionState } =>
        Boolean(lane.sessionState)
      )
      .sort((left, right) => {
        const leftLoad = left.processState.activeTurns + left.processState.queuedTurns + left.processState.assignmentReservations;
        const rightLoad = right.processState.activeTurns + right.processState.queuedTurns + right.processState.assignmentReservations;
        return leftLoad - rightLoad;
      })[0];
    const existingLaneLoad = existingLane
      ? existingLane.processState.activeTurns +
        existingLane.processState.queuedTurns +
        existingLane.processState.assignmentReservations
      : 0;
    if (existingLane && existingLaneLoad === 0) {
      this.reserveProcess(existingLane.processState);
      return existingLane;
    }
    if (this.processes.length + this.startPromises.length < this.maxProcessPoolSize) {
      await this.ensureAvailableProcess(agent);
      const processState = this.selectAndReserveProcess();
      const sessionKey = `${lanePrefix}${processState.slot}`;
      const pending = this.sessionPromises.get(sessionKey);
      if (pending) {
        this.releaseProcessReservation(processState);
        const resolved = await pending;
        this.reserveProcess(resolved.processState);
        return { ...resolved, sessionKey };
      }
      const promise = this.createSession(agent, sessionKey, processState).catch(error => {
        this.releaseProcessReservation(processState);
        throw error;
      }).finally(() => {
        this.sessionPromises.delete(sessionKey);
      });
      this.sessionPromises.set(sessionKey, promise);
      const resolved = await promise;
      return { ...resolved, sessionKey };
    }
    if (existingLane) {
      this.reserveProcess(existingLane.processState);
      return existingLane;
    }
    await this.ensureAvailableProcess(agent);
    const processState = this.selectAndReserveProcess();
    const sessionKey = `${lanePrefix}${processState.slot}`;
    const existing = processState.sessions.get(sessionKey);
    if (existing) return { processState, sessionState: existing, sessionKey };

    const pending = this.sessionPromises.get(sessionKey);
    if (pending) {
      this.releaseProcessReservation(processState);
      const resolved = await pending;
      this.reserveProcess(resolved.processState);
      return { ...resolved, sessionKey };
    }
    const promise = this.createSession(agent, sessionKey, processState).catch(error => {
      this.releaseProcessReservation(processState);
      throw error;
    }).finally(() => {
      this.sessionPromises.delete(sessionKey);
    });
    this.sessionPromises.set(sessionKey, promise);
    const resolved = await promise;
    return { ...resolved, sessionKey };
  }

  private async createSession(
    agent: Agent,
    sessionKey: string,
    selectedProcess?: ProcessState
  ): Promise<{ processState: ProcessState; sessionState: AcpSessionState }> {
    const processState = selectedProcess || this.selectProcess();
    if (sessionKey === DEFAULT_SESSION_KEY) {
      const existing = processState.sessions.get(DEFAULT_SESSION_KEY);
      if (existing) return { processState, sessionState: existing };
    }

    processState.sessionReservations += 1;
    let sessionResult: { sessionId: string };
    try {
      sessionResult = await processState.rpc.request<{ sessionId: string }>("session/new", {
        cwd: processState.workspace.runtimeCwd,
        mcpServers: buildMcpServers(processState.workspace)
      });
    } finally {
      processState.sessionReservations = Math.max(0, processState.sessionReservations - 1);
    }
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
    return { processState, sessionState };
  }

  private selectProcess(): ProcessState {
    const healthy = this.processes.filter(
      processState => processState.child.exitCode === null && processState.child.signalCode === null
    );
    if (!healthy.length) throw new Error("acp processes not initialized");
    return healthy.reduce((best, current) => {
      const bestLoad =
        best.activeTurns * 1000 +
        best.queuedTurns * 100 +
        best.assignmentReservations * 10 +
        best.sessionReservations * 10 +
        best.sessions.size;
      const currentLoad =
        current.activeTurns * 1000 +
        current.queuedTurns * 100 +
        current.assignmentReservations * 10 +
        current.sessionReservations * 10 +
        current.sessions.size;
      return currentLoad < bestLoad ? current : best;
    });
  }

  private selectAndReserveProcess(): ProcessState {
    const processState = this.selectProcess();
    this.reserveProcess(processState);
    return processState;
  }

  private reserveProcess(processState: ProcessState): void {
    processState.assignmentReservations += 1;
  }

  private releaseProcessReservation(processState: ProcessState): void {
    processState.assignmentReservations = Math.max(0, processState.assignmentReservations - 1);
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
      if (event.sessionId && event.sessionId !== sessionId) return;
      if (event.type === "tool_call") {
        accumulator.length = 0;
        return;
      }
      if (event.type === "message_chunk" && event.text) accumulator.push(event.text);
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

function buildAcpSpec(
  agent: Agent,
  workspace: AgentWorkspaceLayout,
  profile = resolveAcpRuntimeProfile(agent.runtime)
): AcpRuntimeSpec {
  if (!profile) throw new Error(`acp driver does not support runtime: ${agent.runtime}`);
  const params = { agent, workspace, timeoutMs: TURN_IDLE_TIMEOUT_MS };
  return {
    command: profile.command,
    args: renderAcpProfileArgs(profile, params),
    env: renderAcpProfileEnv(profile, params)
  };
}

function resolveEffectiveCwd(profileCwd: string | undefined, fallback: string): string {
  const candidate = resolve(profileCwd || fallback);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`ACP runtime profile cwd must be an existing directory: ${candidate}`);
  }
  return candidate;
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
      env: Object.entries(workspace.runtimeAuthEnv)
        .map(([name, value]) => ({ name, value }))
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
  return safeSessionKey(delivery.target);
}

function isChannelRootDelivery(delivery: DeliveryWithContext): boolean {
  return delivery.target.startsWith("#") &&
    !delivery.target.includes(":msg_") &&
    String(delivery.sessionKey || "").startsWith("channel-root:");
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
