import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { clone, createId, nowIso } from "../lib.js";
import type {
  Agent,
  Channel,
  Computer,
  Delivery,
  DeliveryArtifact,
  DeliveryEvent,
  ExternalBotBinding,
  ExternalBotConfig,
  ExternalIngressPairing,
  ExternalIngressPolicy,
  ExternalMessageLink,
  Message,
  PendingComputerConnection,
  ScheduledTask,
  Space,
  State,
  StoreEvent,
  Task
} from "../types.js";
import type { IStore, StateListener, StateMutator } from "./types.js";

export const DEFAULT_SPACE_ID = "space_default";

function defaultSpace(now = nowIso()): Space {
  return {
    id: DEFAULT_SPACE_ID,
    name: "Default",
    slug: "default",
    description: "Default iTeam space",
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Creates the seed/default state for a brand new iTeam home.
 * Includes the local human and the canonical #all channel.
 */
export function initialState(): State {
  const now = nowIso();
  return {
    meta: {
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    },
    spaces: [defaultSpace(now)],
    computers: [],
    pendingComputerConnections: [],
    humans: [{
      id: "human-local",
      name: "Local Human",
      handle: "you",
      role: "owner"
    }],
    agents: [],
    channels: [{
      id: "chan_all",
      spaceId: DEFAULT_SPACE_ID,
      name: "all",
      target: "#all",
      kind: "channel",
      description: "General channel for all members",
      memberIds: ["human-local"],
      defaultAgentId: null,
      createdAt: now
    }],
    messages: [],
    deliveries: [],
    deliveryEvents: [],
    deliveryArtifacts: [],
    tasks: [],
    scheduledTasks: [],
    externalIngressPairings: [],
    externalIngressPolicies: [],
    externalBotConfigs: [],
    externalBotBindings: [],
    externalMessageLinks: [],
    events: []
  };
}

/**
 * Cleans up legacy/invalid entries before the state goes live. Used by every
 * backend right after loading.
 */
export function sanitizeState(state: State): State {
  state.spaces = normalizeSpaces(state.spaces);
  const validSpaceIds = new Set(state.spaces.map(space => space.id));
  const ensureSpaceId = (value: string | undefined | null) =>
    value && validSpaceIds.has(value) ? value : DEFAULT_SPACE_ID;
  state.pendingComputerConnections ||= [];
  state.computers = (state.computers || [])
    .filter((computer: Computer) => computer.connectionId)
    .map((computer: Computer) => ({
      ...computer,
      spaceId: ensureSpaceId(computer.spaceId),
      runtimes: (computer.runtimes || []).filter(runtime => runtime.id !== "mock")
    }));
  state.agents = (state.agents || []).filter((agent: Agent) =>
    (agent.runtime as string) !== "mock" && agent.desiredStatus
  ).map((agent: Agent) => ({ ...agent, spaceId: ensureSpaceId(agent.spaceId) }));
  state.pendingComputerConnections = state.pendingComputerConnections.map((pending: PendingComputerConnection) => ({
    ...pending,
    spaceId: ensureSpaceId(pending.spaceId)
  }));
  const validMemberIds = new Set<string>([
    ...(state.humans || []).map(human => human.id),
    ...state.agents.map(agent => agent.id)
  ]);
  const validAgentIds = new Set(state.agents.map(agent => agent.id));
  state.channels = (state.channels || []).map((channel: Channel) => ({
    ...channel,
    spaceId: ensureSpaceId(channel.spaceId),
    memberIds: (channel.memberIds || []).filter(id => validMemberIds.has(id)),
    defaultAgentId: channel.defaultAgentId && validAgentIds.has(channel.defaultAgentId)
      ? channel.defaultAgentId
      : null
  }));
  state.messages = (state.messages || []).filter((message: Message) => {
    const text = message.text || "";
    return !text.includes("iTeam daemon initialized") && !text.includes("mock runtime");
  }).map((message: Message) => ({ ...message, spaceId: ensureSpaceId(message.spaceId) }));
  state.tasks = (state.tasks || []).map((task: Task, index: number) => {
    const messageId = task.messageId || createId("msg");
    const status = task.status === "open" ? "todo" : (task.status || "todo");
    const target = task.target || "#all";
    const spaceId = ensureSpaceId(task.spaceId);
    const normalized: Task = {
      ...task,
      spaceId,
      number: task.number || index + 1,
      status,
      target,
      messageId,
      threadTarget: task.threadTarget || `${target}:${messageId}`,
      createdAt: task.createdAt || nowIso(),
      updatedAt: task.updatedAt || nowIso()
    };
    if (!state.messages.some(message => message.id === messageId)) {
      state.messages.push({
        id: messageId,
        spaceId,
        target,
        authorId: normalized.createdBy || "human-local",
        type: "task",
        text: normalized.title,
        taskId: normalized.id,
        mentions: [],
        createdAt: normalized.createdAt,
        threadId: null
      });
    }
    return normalized;
  });
  state.scheduledTasks = (state.scheduledTasks || []).map((task: ScheduledTask) => ({
    ...task,
    spaceId: ensureSpaceId(task.spaceId),
    sessionKey: task.sessionKey ?? null,
    intervalMs: task.cronExpression ? null : Number(task.intervalMs) || 10 * 60 * 1000,
    cronExpression: task.cronExpression || null,
    timezone: task.timezone || null,
    status: task.status || "active",
    runCount: Number(task.runCount) || 0,
    lastRunAt: task.lastRunAt ?? null,
    lastMessageId: task.lastMessageId ?? null,
    createdBy: task.createdBy || "human-local",
    createdAt: task.createdAt || nowIso(),
    updatedAt: task.updatedAt || nowIso()
  }));
  state.deliveries = (state.deliveries || []).map((delivery: Delivery) => ({
    ...delivery,
    spaceId: ensureSpaceId(delivery.spaceId),
    rootMessageId: delivery.rootMessageId || delivery.messageId,
    parentDeliveryId: delivery.parentDeliveryId ?? null,
    depth: delivery.depth ?? 0,
    sessionKey: delivery.sessionKey ?? null,
    source: delivery.source ?? null,
    attempts: delivery.attempts ?? 0,
    error: delivery.error ?? null,
    lifecycle: delivery.lifecycle ?? []
  }));
  const deliverySpaceIds = new Map(state.deliveries.map(delivery => [delivery.id, delivery.spaceId]));
  state.deliveryEvents = (state.deliveryEvents || []).map((event: DeliveryEvent, index: number) => ({
    ...event,
    spaceId: deliverySpaceIds.get(event.deliveryId) || ensureSpaceId(event.spaceId),
    title: event.title ?? null,
    text: event.text ?? null,
    toolName: event.toolName ?? null,
    toolCallId: event.toolCallId ?? null,
    status: event.status ?? null,
    sequence: Number(event.sequence) || index + 1,
    payload: event.payload ?? null
  }));
  state.deliveryArtifacts = (state.deliveryArtifacts || []).map((artifact: DeliveryArtifact) => ({
    ...artifact,
    spaceId: deliverySpaceIds.get(artifact.deliveryId) || ensureSpaceId(artifact.spaceId),
    eventId: artifact.eventId ?? null,
    summary: artifact.summary ?? null,
    size: Number(artifact.size) || 0,
    sha256: artifact.sha256 ?? null,
    storage: artifact.storage || "db",
    path: artifact.path ?? null,
    relativePath: artifact.relativePath ?? null,
    content: artifact.content ?? null,
    metadata: artifact.metadata ?? null
  }));
  state.externalIngressPairings = (state.externalIngressPairings || []).map((pairing: ExternalIngressPairing) => ({
    ...pairing,
    spaceId: ensureSpaceId(pairing.spaceId),
    status: pairing.status || "waiting",
    contextRules: normalizeContextRules(pairing.contextRules),
    consumedAt: pairing.consumedAt ?? null,
    policyId: pairing.policyId ?? null
  }));
  state.externalIngressPolicies = (state.externalIngressPolicies || []).map((policy: ExternalIngressPolicy) => ({
    ...policy,
    spaceId: ensureSpaceId(policy.spaceId),
    status: policy.status || "active",
    contextRules: normalizeContextRules(policy.contextRules),
    updatedAt: policy.updatedAt || policy.createdAt || nowIso()
  }));
  const providerMigration = new Map<string, string>();
  state.externalBotConfigs = (state.externalBotConfigs || []).map((config: ExternalBotConfig) => {
    const oldProvider = String(config.provider || "").toLowerCase();
    const provider = normalizeExternalBotConfigProvider(oldProvider, config.appId);
    if (oldProvider && oldProvider !== provider) providerMigration.set(oldProvider, provider);
    return {
      ...config,
      spaceId: ensureSpaceId(config.spaceId),
      provider,
      alias: config.alias ?? null,
      appSecret: config.appSecret ?? null,
      domain: config.domain ?? null,
      enabled: !!config.enabled,
      status: config.status || (!config.enabled ? "disabled" : "pending"),
      statusMessage: config.statusMessage ?? null,
      lastConnectedAt: config.lastConnectedAt ?? null,
      updatedAt: config.updatedAt || config.createdAt || nowIso()
    };
  }).filter(config => config.provider && config.appId);
  state.externalBotBindings = (state.externalBotBindings || []).map((binding: ExternalBotBinding) => ({
    ...binding,
    spaceId: ensureSpaceId(binding.spaceId),
    provider: providerMigration.get(String(binding.provider || "").toLowerCase()) || String(binding.provider || "").toLowerCase(),
    chatType: binding.chatType ?? null,
    defaultTarget: binding.defaultTarget ?? null,
    defaultAgentId: binding.defaultAgentId ?? null,
    status: binding.status || "active",
    updatedAt: binding.updatedAt || binding.createdAt || nowIso()
  }));
  state.externalMessageLinks = (state.externalMessageLinks || []).map((link: ExternalMessageLink) => ({
    ...link,
    spaceId: ensureSpaceId(link.spaceId),
    provider: providerMigration.get(String(link.provider || "").toLowerCase()) || String(link.provider || "").toLowerCase(),
    externalMessageId: link.externalMessageId ?? null,
    rootMessageId: link.rootMessageId ?? null
  }));
  state.events = (state.events || []).filter(event => !String(event.type || "").startsWith("agent:"));
  return state;
}

function normalizeSpaces(spaces: Space[] | undefined): Space[] {
  const now = nowIso();
  const byId = new Map<string, Space>();
  for (const space of spaces || []) {
    const id = String(space.id || "").trim();
    if (!id) continue;
    byId.set(id, {
      id,
      name: String(space.name || space.slug || id).trim(),
      slug: String(space.slug || id).trim(),
      description: space.description || "",
      createdAt: space.createdAt || now,
      updatedAt: space.updatedAt || space.createdAt || now
    });
  }
  if (!byId.has(DEFAULT_SPACE_ID)) byId.set(DEFAULT_SPACE_ID, defaultSpace(now));
  return [...byId.values()];
}

function normalizeExternalBotConfigProvider(provider: string, appId: string): string {
  const normalized = String(provider || "").trim().toLowerCase();
  const app = String(appId || "").trim().toLowerCase();
  const baseProvider = normalized.split(":")[0];
  if ((baseProvider === "lark" || baseProvider === "feishu") && app) return `${baseProvider}:${app}`;
  return normalized;
}

function normalizeContextRules(value: Record<string, string[]> | undefined): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value)
    .map(([key, values]) => [
      String(key).trim(),
      Array.isArray(values) ? values.map(item => String(item).trim()).filter(Boolean) : []
    ] as const)
    .filter(([key, values]) => key && values.length > 0);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Base class with the in-memory state machine. Concrete backends only need to
 * provide load/persist hooks.
 */
export abstract class BaseStore implements IStore {
  readonly home: string;
  readonly agentRoot: string;
  protected state!: State;
  protected listeners: Set<StateListener> = new Set();

  constructor(home: string) {
    this.home = home;
    this.agentRoot = join(home, "agents");
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.agentRoot, { recursive: true });
  }

  protected setStateAfterLoad(state: State): void {
    this.state = sanitizeState(state);
    // Persist sanitized state so the cleanup is durable.
    this.persist(this.state);
  }

  snapshot(): State {
    return clone(this.state);
  }

  mutate<T>(fn: StateMutator<T>): T {
    const result = fn(this.state);
    this.state.meta.updatedAt = nowIso();
    this.persist(this.state);
    this.emit("state:changed", { at: this.state.meta.updatedAt });
    return result;
  }

  emit(type: string, payload: unknown): void {
    const event: StoreEvent = {
      id: createId("evt"),
      type,
      payload,
      createdAt: nowIso()
    };
    this.state.events.push(event);
    if (this.state.events.length > 500) {
      this.state.events.splice(0, this.state.events.length - 500);
    }
    this.persist(this.state);
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Persist the entire state. Backends are free to keep an in-memory copy and
   * write through; the JSON backend writes the whole file, SQL backends write
   * a single row in a `state` table for now (matches existing semantics —
   * full-state coarse persistence).
   */
  protected abstract persist(state: State): void;

  /** Optional. Called by the factory; subclasses can release resources. */
  close(): void | Promise<void> {}
}
