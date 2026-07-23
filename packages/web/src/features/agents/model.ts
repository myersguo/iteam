import type { Agent } from "../../types";

export function agentRuntimeError(agent: Agent): string {
  return typeof agent.lastRuntimeStatus?.error === "string" ? agent.lastRuntimeStatus.error : "";
}

export function isAgentStopped(agent: Agent): boolean {
  return (
    ["offline", "stopped", "exited", "launch_failed"].includes(agent.status) ||
    agent.desiredStatus === "stopped"
  );
}
