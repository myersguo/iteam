// AgentDriver — runtime-agnostic interface for executing one delivery turn.
//
// A driver wraps a specific CLI/protocol family (ACP JSON-RPC, stream-json,
// custom JSON oneshot) and emits unified AgentEvent envelopes. AgentLauncher
// selects a driver per agent runtime and never inspects the underlying wire
// protocol.
//
// Three "busy delivery modes" are recognised so the upper layer can decide
// whether to interleave new messages, queue them, or restart a session — see
// https://blog.openviking.ai/post/agent-runtime/?lang=zh.

import type { Agent, DeliveryWithContext } from "../types.js";
import type { AgentEvent } from "./events.js";

export type DeliveryMode = "direct" | "notification" | "none";

/**
 * Declarative capability matrix for a runtime. The launcher consults this
 * instead of branching on `agent.runtime` strings — adding a new runtime is a
 * matter of registering capabilities, not editing scheduler internals. Inspired
 * by zouk-daemon's per-driver feature descriptors.
 */
export interface DriverCapabilities {
  /**
   * `persistent` — driver keeps a long-lived process alive across deliveries
   *   (ACP/stream-json). The launcher calls start()/stop() and reuses the same
   *   driver instance for every deliver().
   * `ephemeral` — driver spawns a fresh CLI per delivery turn. start()/stop()
   *   are no-ops.
   */
  lifecycle: "persistent" | "ephemeral";
  /**
   * What to do when a new delivery arrives while a previous turn is still
   * executing. Maps directly to https://blog.openviking.ai/post/agent-runtime/
   * busy-delivery modes.
   * - `direct`: send through the existing session (ACP-style).
   * - `queue`: serialise new prompts behind the in-flight one.
   * - `spawn_new`: start a separate process per delivery.
   */
  inFlightWake: "direct" | "queue" | "spawn_new";
  /**
   * Whether the driver can resume the same conversation across multiple
   * deliveries. Persistent drivers usually can; ephemeral ones cannot unless
   * they pass a session id through the CLI.
   */
  supportsResume: boolean;
}

export interface AgentDriverContext {
  serverUrl: string;
  /**
   * Launch identifier — stable for the duration the driver instance lives.
   * Re-used as launchId on every emitted event for correlation.
   */
  launchId: string;
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface DeliverResult {
  ok: true;
  text: string;
}

export interface AgentDriver {
  /** Static descriptor consumed by AgentLauncher and observability. */
  readonly runtime: string;
  readonly deliveryMode: DeliveryMode;
  /**
   * Declarative capability flags. The launcher branches on these instead of
   * the runtime id. Default values are provided by `defaultCapabilities()` in
   * registry.ts when a driver does not override them.
   */
  readonly capabilities: DriverCapabilities;

  /**
   * Subscribe to the driver's unified event stream. Drivers may emit
   * events synchronously during deliver() or asynchronously between turns.
   */
  on(listener: AgentEventListener): () => void;

  /**
   * Optional warm-up. Drivers that hold a long-lived process (ACP, stream-json)
   * should spawn here. One-shot drivers may treat this as a no-op.
   */
  start?(agent: Agent): Promise<void>;

  /**
   * Run a single delivery turn. Returns the final assistant text once the turn
   * completes; intermediate chunks are observable via on().
   */
  deliver(agent: Agent, delivery: DeliveryWithContext, prompt: string): Promise<DeliverResult>;

  /** Cancel an active delivery if the driver can map it to a runtime turn. */
  cancelDelivery?(deliveryId: string): Promise<void>;

  /** Tear down any long-lived resources. Idempotent. */
  stop?(agent: Agent): Promise<void>;

  /**
   * Liveness probe used by the watchdog. Persistent drivers should return
   * false once their underlying process has exited so the launcher can drop
   * stale entries on the next reconnect.
   */
  isAlive?(): boolean;
}

/**
 * Keep every delivery in the same iTeam thread on the same persistent
 * runtime session. Non-thread deliveries stay distributed by delivery id.
 */
export function deliveryAffinityIndex(delivery: DeliveryWithContext, poolSize: number): number {
  if (poolSize <= 1) return 0;
  const key = delivery.sessionKey || (delivery.target.includes(":msg_") ? delivery.target : delivery.id);
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % poolSize;
}
