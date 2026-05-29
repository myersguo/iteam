// Driver registry — declarative runtime → capabilities map.
//
// AgentLauncher consults this to decide whether a runtime needs a long-lived
// process (persistent lifecycle), how to handle new deliveries arriving while
// a turn is in flight, and which factory to use for constructing the driver.
// Adding a new runtime is a single entry here, not a switch statement edit.

import type { AgentRuntime } from "../types.js";
import type { AgentDriver, DriverCapabilities } from "./driver.js";
import { AcpDriver, type AcpDriverOptions } from "./acp-driver.js";
import { CodexDriver, type CodexDriverOptions } from "./codex-driver.js";
import { OneshotDriver, type OneshotDriverOptions } from "./oneshot-driver.js";

export interface DriverFactoryContext {
  serverUrl: string;
  launchId: string;
  /** Pass-through credentials so drivers can give them to the chat-bridge. */
  computerId?: string;
  connectToken?: string;
}

export type DriverFactory = (runtime: string, ctx: DriverFactoryContext) => AgentDriver;

export interface RuntimeDescriptor {
  capabilities: DriverCapabilities;
  factory: DriverFactory;
}

/**
 * Capability table. Update when a runtime moves between driver families
 * (e.g. when codex is migrated from oneshot CLI to ACP server mode).
 */
const RUNTIME_TABLE: Record<string, RuntimeDescriptor> = {
  trae: {
    capabilities: { lifecycle: "persistent", inFlightWake: "direct", supportsResume: true },
    factory: (runtime, ctx) => new AcpDriver(runtime, ctx as AcpDriverOptions)
  },
  codex: {
    capabilities: { lifecycle: "persistent", inFlightWake: "direct", supportsResume: true },
    factory: (runtime, ctx) => new CodexDriver(runtime, ctx as CodexDriverOptions)
  },
  claude: {
    capabilities: { lifecycle: "ephemeral", inFlightWake: "spawn_new", supportsResume: false },
    factory: (runtime, ctx) => new OneshotDriver(runtime, ctx as OneshotDriverOptions)
  },
  gemini: {
    capabilities: { lifecycle: "ephemeral", inFlightWake: "spawn_new", supportsResume: false },
    factory: (runtime, ctx) => new OneshotDriver(runtime, ctx as OneshotDriverOptions)
  }
};

const FALLBACK: RuntimeDescriptor = {
  capabilities: { lifecycle: "ephemeral", inFlightWake: "spawn_new", supportsResume: false },
  factory: (runtime, ctx) => new OneshotDriver(runtime, ctx as OneshotDriverOptions)
};

export function getRuntimeDescriptor(runtime: string): RuntimeDescriptor {
  return RUNTIME_TABLE[runtime] ?? FALLBACK;
}

export function getCapabilities(runtime: string): DriverCapabilities {
  return getRuntimeDescriptor(runtime).capabilities;
}

export function isPersistentRuntime(runtime: string): boolean {
  return getCapabilities(runtime).lifecycle === "persistent";
}

export function listKnownRuntimes(): AgentRuntime[] {
  return Object.keys(RUNTIME_TABLE) as AgentRuntime[];
}
