import type {
  AppState,
  AuthInfo,
  Channel,
  Delivery,
  DeliveryArtifact,
  DeliveryEvent,
  Message,
  Space,
  Task
} from "../types";
import { resolveChannel, offTargetDeliveryIds } from "../features/chat/model";
import { apiFetch, getActiveSpaceId, setActiveSpaceId } from "./session";

export interface TaskFilter {
  target?: string;
  status?: string;
  assigneeId?: string;
  createdBy?: string;
  q?: string;
}

export interface ChannelViewState {
  channels: Channel[];
  messages: Message[];
  deliveries: Delivery[];
  deliveryEvents: DeliveryEvent[];
  deliveryArtifacts: DeliveryArtifact[];
}

export const api = {
  async getAuth(): Promise<AuthInfo> {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const res = await apiFetch(`/api/me?return_to=${encodeURIComponent(returnTo)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 401) throw new Error(data.error || "Failed to load auth state");
    return data as AuthInfo;
  },

  async fetchTasks(filter: TaskFilter = {}): Promise<Task[]> {
    const params = new URLSearchParams();
    if (filter.target) params.set("target", filter.target);
    if (filter.status) params.set("status", filter.status);
    if (filter.assigneeId) params.set("assigneeId", filter.assigneeId);
    if (filter.createdBy) params.set("createdBy", filter.createdBy);
    if (filter.q) params.set("q", filter.q);
    const qs = params.toString();
    return apiFetch(`/api/tasks${qs ? `?${qs}` : ""}`).then(r => r.json());
  },

  async fetchMessages(channelTarget: string, before?: string, limit = 10): Promise<Message[]> {
    const selectedChannel = resolveChannel(
      await apiFetch("/api/channels").then(r => r.json()),
      channelTarget
    );
    if (!selectedChannel) return [];
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before);
    return apiFetch(`/api/messages/channel/${encodeURIComponent(selectedChannel.id)}?${params}`).then(r => r.json());
  },

  async fetchTargetMessages(target: string, limit = 50): Promise<Message[]> {
    return apiFetch(`/api/messages?target=${encodeURIComponent(target)}&limit=${limit}`).then(r => r.json());
  },

  async getState(channelTarget = "#all"): Promise<AppState> {
    // If the currently-active space is unknown to the backend, fall back to the
    // default space instead of surfacing a page-wide error.
    const spaces = await apiFetch("/api/spaces").then(r => r.json()).catch(() => [] as Space[]);
    const currentSpaceId = getActiveSpaceId();
    const known = (spaces as Space[]).find(space => space.id === currentSpaceId || space.slug === currentSpaceId);
    if (!known && currentSpaceId !== "space_default") {
      setActiveSpaceId("space_default");
    } else if (known && known.id !== currentSpaceId) {
      setActiveSpaceId(known.id);
    }

    const [humans, agents, channels, tasks, scheduledTasks, computers, externalBotConfigs, externalBotBindings, deliveries] = await Promise.all([
      apiFetch("/api/humans").then(r => r.json()),
      apiFetch("/api/agents").then(r => r.json()),
      apiFetch("/api/channels").then(r => r.json()),
      api.fetchTasks(),
      apiFetch("/api/scheduled-tasks").then(r => r.json()),
      apiFetch("/api/computers").then(r => r.json()),
      apiFetch("/api/external/bot-configs").then(r => r.json()),
      apiFetch("/api/external/bot-bindings").then(r => r.json()),
      apiFetch("/api/deliveries").then(r => r.json())
    ]);
    const selectedChannel = resolveChannel(channels, channelTarget);
    const messages = selectedChannel
      ? await apiFetch(`/api/messages/channel/${encodeURIComponent(selectedChannel.id)}?limit=10`)
          .then(r => (r.ok ? r.json() : []))
          .catch(() => [])
      : [];
    const deliveryEvents = await fetchDeliveryEventsForMessages(deliveries, messages, selectedChannel?.target);
    const deliveryArtifacts = await fetchDeliveryArtifactsForMessages(deliveries, messages, selectedChannel?.target);
    return { humans, agents, channels, messages, tasks, scheduledTasks, computers, externalBotConfigs, externalBotBindings, deliveries, deliveryEvents, deliveryArtifacts, events: [], spaces };
  },

  /**
   * Lightweight refresh for the active channel only: messages + this channel's
   * deliveries/events/artifacts.
   */
  async getChannelView(channelTarget: string): Promise<ChannelViewState> {
    const [channels, deliveries] = await Promise.all([
      apiFetch("/api/channels").then(r => r.json()),
      apiFetch("/api/deliveries").then(r => r.json())
    ]);
    const selectedChannel = resolveChannel(channels, channelTarget);
    const messages = selectedChannel
      ? await apiFetch(`/api/messages/channel/${encodeURIComponent(selectedChannel.id)}?limit=10`)
          .then(r => (r.ok ? r.json() : []))
          .catch(() => [])
      : [];
    const deliveryEvents = await fetchDeliveryEventsForMessages(deliveries, messages, selectedChannel?.target);
    const deliveryArtifacts = await fetchDeliveryArtifactsForMessages(deliveries, messages, selectedChannel?.target);
    return { channels, messages, deliveries, deliveryEvents, deliveryArtifacts };
  },

  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error);
    return res.json();
  },

  async patch<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await apiFetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error);
    return res.json();
  },

  async del<T = unknown>(path: string): Promise<T> {
    const res = await apiFetch(path, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error);
    return res.json();
  }
};

async function fetchDeliveryEventsForMessages(
  deliveries: Delivery[],
  messages: Message[],
  target?: string
): Promise<DeliveryEvent[]> {
  const offTargetIds = offTargetDeliveryIds(deliveries, messages, target);
  if (offTargetIds.length === 0 && !target) return [];

  const eventGroups = await Promise.all([
    target
      ? apiFetch(`/api/delivery-events?target=${encodeURIComponent(target)}&limit=300`).then(r => r.json())
      : Promise.resolve([]),
    ...offTargetIds.map(deliveryId =>
      apiFetch(`/api/delivery-events?deliveryId=${encodeURIComponent(deliveryId)}&limit=300`).then(r => r.json())
    )
  ]);
  const byId = new Map<string, DeliveryEvent>();
  for (const group of eventGroups) {
    for (const event of group as DeliveryEvent[]) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()];
}

async function fetchDeliveryArtifactsForMessages(
  deliveries: Delivery[],
  messages: Message[],
  target?: string
): Promise<DeliveryArtifact[]> {
  const offTargetIds = offTargetDeliveryIds(deliveries, messages, target);
  if (offTargetIds.length === 0 && !target) return [];

  const artifactGroups = await Promise.all([
    target
      ? apiFetch(`/api/delivery-artifacts?target=${encodeURIComponent(target)}&limit=300`).then(r => r.json())
      : Promise.resolve([]),
    ...offTargetIds.map(deliveryId =>
      apiFetch(`/api/delivery-artifacts?deliveryId=${encodeURIComponent(deliveryId)}&limit=300`).then(r => r.json())
    )
  ]);
  const byId = new Map<string, DeliveryArtifact>();
  for (const group of artifactGroups) {
    for (const artifact of group as DeliveryArtifact[]) {
      byId.set(artifact.id, artifact);
    }
  }
  return [...byId.values()];
}
