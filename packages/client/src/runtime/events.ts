// Unified agent event envelope.
//
// Inspired by https://blog.openviking.ai/post/agent-runtime/?lang=zh
//
// Each runtime CLI (Claude stream-json, Codex/Trae ACP JSON-RPC, custom JSON
// emitters like Copilot/Gemini) is wrapped by an AgentDriver that translates
// runtime-specific events into this single envelope. Upstream code (UI,
// chat-bridge, message router) consumes only `AgentEvent` and never needs to
// know which runtime produced it.

export type AgentEventType =
  | "session_started"
  | "delivery_queued"
  | "delivery_running"
  | "message_chunk"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "plan"
  | "turn_end"
  | "error"
  | "exited";

export interface AgentEventBase {
  type: AgentEventType;
  agentId: string;
  launchId: string;
  /** Provider-side session identifier (ACP session id, codex session id, ...). */
  sessionId?: string;
  /** iTeam delivery currently producing this event, when inside a turn. */
  deliveryId?: string;
  /** Reply target for the active delivery, typically a task thread. */
  target?: string;
  /** Wall-clock timestamp the event was observed. */
  at: string;
}

export interface SessionStartedEvent extends AgentEventBase {
  type: "session_started";
  sessionId: string;
}

export interface DeliveryQueuedEvent extends AgentEventBase {
  type: "delivery_queued";
  deliveryId: string;
  target: string;
  queuePosition: number;
  sessionKey: string;
  processSlot: number;
}

export interface DeliveryRunningEvent extends AgentEventBase {
  type: "delivery_running";
  deliveryId: string;
  target: string;
  sessionKey: string;
  processSlot: number;
}

export interface MessageChunkEvent extends AgentEventBase {
  type: "message_chunk";
  /** Whether this chunk completes the assistant turn. */
  final: boolean;
  text: string;
}

export interface ToolCallEvent extends AgentEventBase {
  type: "tool_call";
  toolName: string;
  toolCallId: string;
  /** Raw arguments forwarded by the runtime; opaque to the daemon. */
  arguments: unknown;
}

export interface ToolResultEvent extends AgentEventBase {
  type: "tool_result";
  toolCallId: string;
  ok: boolean;
  /** Either stringified output or runtime-specific structured payload. */
  output: unknown;
}

export interface ThinkingEvent extends AgentEventBase {
  type: "thinking";
  text: string;
}

export interface PlanEvent extends AgentEventBase {
  type: "plan";
  items: Array<{
    id: string;
    content: string;
    status?: string;
    priority?: string;
  }>;
}

export interface TurnEndEvent extends AgentEventBase {
  type: "turn_end";
  /** Final accumulated assistant reply, if available. */
  text: string;
  /** Reason reported by the runtime (e.g. "stop", "tool_use"). */
  reason?: string;
}

export interface ErrorEvent extends AgentEventBase {
  type: "error";
  message: string;
  /** Runtime-specific error code (rpc code, exit code, ...). */
  code?: string | number;
}

export interface ExitedEvent extends AgentEventBase {
  type: "exited";
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type AgentEvent =
  | SessionStartedEvent
  | DeliveryQueuedEvent
  | DeliveryRunningEvent
  | MessageChunkEvent
  | ToolCallEvent
  | ToolResultEvent
  | ThinkingEvent
  | PlanEvent
  | TurnEndEvent
  | ErrorEvent
  | ExitedEvent;
