import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { clone, createId, nowIso } from "../lib.js";
import type {
  Agent,
  Channel,
  Computer,
  Delivery,
  Message,
  ScheduledTask,
  State,
  StoreEvent,
  Task
} from "../types.js";
import type { IStore, StateListener, StateMutator } from "./types.js";

/**
 * Creates the seed/default state for a brand new iTeam home.
 * Includes the local human and the canonical #all channel.
 */
export function initialState(): State {
  return {
    meta: {
      createdAt: nowIso(),
      updatedAt: nowIso(),
      schemaVersion: 1
    },
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
      name: "all",
      target: "#all",
      kind: "channel",
      description: "General channel for all members",
      memberIds: ["human-local"],
      createdAt: nowIso()
    }],
    messages: [],
    deliveries: [],
    tasks: [],
    scheduledTasks: [],
    events: []
  };
}

/**
 * Cleans up legacy/invalid entries before the state goes live. Used by every
 * backend right after loading.
 */
export function sanitizeState(state: State): State {
  state.pendingComputerConnections ||= [];
  state.computers = (state.computers || [])
    .filter((computer: Computer) => computer.connectionId)
    .map((computer: Computer) => ({
      ...computer,
      runtimes: (computer.runtimes || []).filter(runtime => runtime.id !== "mock")
    }));
  state.agents = (state.agents || []).filter((agent: Agent) =>
    (agent.runtime as string) !== "mock" && agent.desiredStatus
  );
  const validMemberIds = new Set<string>([
    ...(state.humans || []).map(human => human.id),
    ...state.agents.map(agent => agent.id)
  ]);
  state.channels = (state.channels || []).map((channel: Channel) => ({
    ...channel,
    memberIds: (channel.memberIds || []).filter(id => validMemberIds.has(id))
  }));
  state.messages = (state.messages || []).filter((message: Message) => {
    const text = message.text || "";
    return !text.includes("iTeam daemon initialized") && !text.includes("mock runtime");
  });
  state.tasks = (state.tasks || []).map((task: Task, index: number) => {
    const messageId = task.messageId || createId("msg");
    const status = task.status === "open" ? "todo" : (task.status || "todo");
    const target = task.target || "#all";
    const normalized: Task = {
      ...task,
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
    rootMessageId: delivery.rootMessageId || delivery.messageId,
    parentDeliveryId: delivery.parentDeliveryId ?? null,
    depth: delivery.depth ?? 0,
    attempts: delivery.attempts ?? 0,
    error: delivery.error ?? null
  }));
  state.events = (state.events || []).filter(event => !String(event.type || "").startsWith("agent:"));
  return state;
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
