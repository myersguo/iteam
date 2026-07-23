import type { Agent, AppState, Channel } from "./types";

export function slugHandle(value: string): string {
  return (
    String(value || "member")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "member"
  );
}

export function isProtectedChannel(channel: Channel): boolean {
  return channel.target === "#all" || channel.name === "all";
}

export function agentForDm(state: AppState, channel: Channel): Agent | null {
  if (channel.kind !== "dm") return null;
  return state.agents.find(agent =>
    channel.memberIds?.includes(agent.id) ||
    channel.target === `dm:${agent.id}`
  ) || null;
}

export function channelMessageCount(state: AppState, channel: Channel, selectedTarget: string): number {
  if (typeof channel.messageCount === "number") return channel.messageCount;
  if (channel.target !== selectedTarget) return 0;
  return state.messages.filter(message => message.target === channel.target && !message.threadId).length;
}

export interface AgentComputerGroup {
  id: string;
  name: string;
  status: string;
  agents: Agent[];
}

export function groupAgentsByComputer(state: AppState): AgentComputerGroup[] {
  const groups: AgentComputerGroup[] = state.computers.map(computer => ({
    id: computer.id,
    name: computer.name,
    status: computer.status,
    agents: state.agents.filter(agent => agent.computerId === computer.id)
  }));
  const knownComputerIds = new Set(state.computers.map(computer => computer.id));
  const unassigned = state.agents.filter(agent => !agent.computerId || !knownComputerIds.has(agent.computerId));
  if (unassigned.length) {
    groups.push({
      id: "unassigned",
      name: "Unassigned",
      status: "offline",
      agents: unassigned
    });
  }
  return groups.filter(group => group.agents.length > 0);
}
