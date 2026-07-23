import type { AppState, Channel, Message } from "../../types";
import { agentForDm, slugHandle } from "../../utils";

export function resolveChannel(channels: Channel[], channelIdOrTarget: string): Channel | null {
  return channels.find(channel =>
    channel.id === channelIdOrTarget ||
    channel.target === channelIdOrTarget ||
    channel.target === `#${channelIdOrTarget.replace(/^#/, "")}`
  ) || null;
}

export function formatChatTitle(state: AppState, target: string): string {
  const channel = resolveChannel(state.channels, target);
  if (channel?.kind === "dm") {
    const agent = agentForDm(state, channel);
    return `@${agent?.handle || slugHandle(agent?.name || channel.name)}`;
  }
  if (channel) return `#${channel.name}`;
  return target.startsWith("#") ? target : `#${target}`;
}

export function resolveChatSubtitle(state: AppState, target: string): string {
  const channel = resolveChannel(state.channels, target);
  if (channel?.description?.trim()) return channel.description;
  if (target.startsWith("dm:") || channel?.kind === "dm") {
    return "A private working thread between you and this agent.";
  }
  return "A shared canvas for humans and agents to think out loud.";
}

export function offTargetDeliveryIds(
  deliveries: AppState["deliveries"],
  messages: Message[],
  target?: string
): string[] {
  const messageIds = new Set(messages.map(message => message.id));
  return deliveries
    .filter(delivery => messageIds.has(delivery.messageId || "") && delivery.target && delivery.target !== target)
    .map(delivery => delivery.id);
}
