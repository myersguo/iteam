// IteamCore — domain logic separated from HTTP transport.
//
// Mirrors zouk-daemon's DaemonCore pattern: the HTTP layer (http-server.ts)
// only translates wire protocol; this class owns all state mutations, message
// dispatch, and delivery enqueueing. Dependencies (store, runtime manager,
// clock, id generator) are injectable so the class is library-friendly and
// testable without booting an HTTP server.

import { CronExpressionParser } from "cron-parser";
import { createHash } from "node:crypto";
import {
  createId as defaultCreateId,
  deriveAgentAuthToken,
  nowIso as defaultNowIso,
  safeTokenEqual,
  DAEMON_VERSION
} from "./lib.js";
import { createStore } from "./store/index.js";
import { DEFAULT_SPACE_ID } from "./store/base.js";
import { RuntimeManager } from "./runtime.js";
import type { IStore, StateListener } from "./store/types.js";
import type {
  ActiveDeliveryContext,
  Agent,
  Channel,
  ConnectComputerResult,
  ContextMessage,
  Delivery,
  DeliveryArtifact,
  DeliveryEvent,
  DeliveryEventKind,
  DeliveryLifecycleIntent,
  DeliveryLifecycleRecord,
  DeliveryWithContext,
  ExternalBotBinding,
  ExternalBotConfig,
  ExternalIngressPairing,
  ExternalIngressPolicy,
  ExternalMessageLink,
  Fingerprint,
  MentionRef,
  Message,
  PendingComputerConnection,
  RuntimeInfo,
  ScheduledTask,
  Space,
  State,
  StoreEvent,
  Task,
  Human
} from "./types.js";

/**
 * Resolves the active space for a request. Accepts either a space id
 * (`space_abc`) or a slug (`growth`); missing/empty values fall back to the
 * built-in default space so pre-space callers continue to work.
 */
export function resolveSpaceId(state: State, spaceId: string | null | undefined): string {
  const raw = String(spaceId || "").trim();
  if (!raw) return DEFAULT_SPACE_ID;
  const spaces = state.spaces || [];
  const byId = spaces.find(space => space.id === raw);
  if (byId) return byId.id;
  const bySlug = spaces.find(space => space.slug === raw);
  if (bySlug) return bySlug.id;
  throw new HttpError(404, `space not found: ${raw}`);
}

export { DEFAULT_SPACE_ID };

const MAX_DELIVERY_DEPTH = 10;
const DEFAULT_INGRESS_PAIRING_TTL_MS = 5 * 60 * 1000;

/** Options every space-scoped mutation accepts. */
export interface SpaceContext {
  spaceId?: string | null;
}

/** A typed error so the HTTP layer can map domain failures to status codes. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export interface IteamCoreOptions {
  store?: IStore;
  runtimes?: RuntimeManager;
  clock?: () => string;
  idGenerator?: (prefix: string) => string;
}

export interface MessageCreateInput extends SpaceContext {
  target: string;
  text: string;
  authorId?: string;
  type?: string;
  mentions?: MentionRef[];
  createdAt?: string;
  threadId?: string | null;
  defaultAgentId?: string | null;
  sessionKey?: string | null;
  source?: string;
}

export interface AgentCreateInput extends SpaceContext {
  name: string;
  description?: string;
  runtime?: string;
  computerId: string;
  model?: string;
  reasoning?: string;
  env?: Record<string, string>;
}

export interface AgentPatchInput {
  name?: string;
  description?: string;
  model?: string | null;
}

export interface HumanPatchInput {
  name?: string;
}

export interface ChannelCreateInput extends SpaceContext {
  name: string;
  description?: string;
  private?: boolean;
  defaultAgentId?: string | null;
}

export interface ChannelPatchInput {
  name?: string;
  description?: string;
  defaultAgentId?: string | null;
}

export interface TaskCreateInput extends SpaceContext {
  target: string;
  title: string;
  description?: string;
  status?: string;
  assigneeId?: string;
  createdBy?: string;
}

export interface TaskPatchInput {
  status?: string;
  assigneeId?: string | null;
  title?: string;
  description?: string;
}

export interface ScheduledTaskCreateInput extends SpaceContext {
  target: string;
  agentId: string;
  prompt: string;
  sessionKey?: string | null;
  intervalMs?: number | string;
  cronExpression?: string;
  timezone?: string;
  nextRunAt?: string;
  createdBy?: string;
}

export interface ScheduledTaskPatchInput {
  target?: string;
  agentId?: string;
  prompt?: string;
  sessionKey?: string | null;
  intervalMs?: number | string;
  cronExpression?: string | null;
  timezone?: string | null;
  status?: string;
  nextRunAt?: string;
}

export interface ConnectInviteInput extends SpaceContext {
  serverUrl?: string;
  label?: string;
}

export interface ConnectInviteResult extends PendingComputerConnection {
  command: string;
  serverUrl: string;
}

export interface ConnectComputerInput {
  /**
   * Persistent connect token. On first connect this matches a pending invite;
   * the server then binds the token to the new Computer record forever. On
   * subsequent connects the client replays the same token.
   */
  token: string;
  name?: string;
  fingerprint: Fingerprint;
  daemonVersion?: string;
  runtimes?: RuntimeInfo[];
}

export interface DeliveryResultInput {
  ok?: boolean;
  text?: string;
  error?: string;
  threadId?: string;
}

export interface DeliveryProgressInput {
  text?: string;
  elapsedMs?: number;
}

export interface DeliveryRuntimeStateInput {
  phase?: "queued" | "running";
  queuePosition?: number;
  sessionKey?: string;
  processSlot?: number;
}

export interface DeliveryHelpNeededInput {
  text?: string;
  reason?: string;
}

export interface IngressPairingCreateInput extends SpaceContext {
  target: string;
  agentId: string;
  label?: string;
  expiresInMs?: number;
  contextRules?: Record<string, string[]>;
}

export interface IngressPairInput {
  pairCode: string;
  source?: string;
  contextRules?: Record<string, string[]>;
}

export interface IngressMessageInput {
  policyId?: string;
  token?: string;
  target?: string;
  agentId?: string;
  text: string;
  source?: string;
  context?: Record<string, string>;
  sessionKey?: string;
}

export interface ExternalBindingUpsertInput extends SpaceContext {
  provider: string;
  tenantKey: string;
  chatId: string;
  chatType?: string | null;
  defaultTarget?: string | null;
  defaultAgentId?: string | null;
}

export interface ExternalBotConfigUpsertInput extends SpaceContext {
  provider?: string;
  alias?: string | null;
  appId: string;
  appSecret?: string | null;
  domain?: string | null;
  enabled?: boolean;
}

export interface ExternalRoutedMessageInput extends SpaceContext {
  provider: string;
  tenantKey: string;
  chatId: string;
  chatType?: string | null;
  senderId?: string | null;
  externalMessageId?: string | null;
  text: string;
  target?: string | null;
  defaultAgentId?: string | null;
  sessionKey?: string | null;
  asTask?: boolean;
}

export interface ExternalRoutedMessageResult {
  ok: boolean;
  message?: Message;
  task?: Task;
  binding?: ExternalBotBinding | null;
  replyText?: string;
}

export interface RuntimeStatusInput {
  status?: string;
  details?: Record<string, unknown> & { launchId?: string; pid?: number | null };
}

export interface RuntimeEventInput {
  event?: string;
  payload?: unknown;
  details?: Record<string, unknown>;
  runtime?: string;
  launchId?: string;
  createdAt?: string;
}

export interface DeliveryEventCreateInput {
  deliveryId: string;
  kind: DeliveryEventKind;
  title?: string | null;
  text?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  status?: string | null;
  payload?: unknown;
  createdAt?: string;
}

export interface MessageQuery extends SpaceContext {
  target?: string;
  limit?: number | string | null;
  before?: string | null;
}

export interface ChannelMessageQuery extends SpaceContext {
  channelId: string;
  limit?: number | string | null;
  before?: string | null;
}

/**
 * Core domain object. One instance per daemon process owns the live store and
 * dispatches every incoming command, regardless of transport (HTTP today,
 * potentially other transports later).
 */
/**
 * Command messages pushed from backend to a connected client (agent-daemon).
 * Distinct from `StoreEvent` (which is fanned out to web UIs); these tell the
 * client what to *do* — launch an agent, stop one, deliver a message.
 *
 * Phase 4 replaces 5s heartbeat polling with SSE delivery of these events; a
 * `ping` event is also sent periodically as a keepalive.
 */
export type ComputerPushEvent =
  | { type: "launch"; payload: Agent }
  | { type: "stop"; payload: Agent }
  | { type: "delivery"; payload: DeliveryWithContext }
  | { type: "cancel_delivery"; payload: { deliveryId: string; agentId: string; reason: string } }
  | { type: "ping"; payload: { now: string } };

export type ComputerPushListener = (event: ComputerPushEvent) => void;

export class IteamCore {
  readonly store: IStore;
  readonly runtimes: RuntimeManager;
  private readonly clock: () => string;
  private readonly newId: (prefix: string) => string;
  private readonly serverInviteRoot: string;
  /**
   * Per-computer command listeners. Map keys are computerId; values are the
   * set of currently subscribed listeners (typically one SSE writer each).
   */
  private readonly computerListeners = new Map<string, Set<ComputerPushListener>>();
  private readonly computerEvictors = new Map<ComputerPushListener, () => void>();

  static async create(options: IteamCoreOptions & { serverInviteRoot: string }): Promise<IteamCore> {
    const store = options.store ?? (await createStore());
    return new IteamCore(store, options);
  }

  private constructor(store: IStore, options: IteamCoreOptions & { serverInviteRoot: string }) {
    this.store = store;
    this.runtimes = options.runtimes ?? new RuntimeManager(store);
    this.clock = options.clock ?? defaultNowIso;
    this.newId = options.idGenerator ?? defaultCreateId;
    this.serverInviteRoot = options.serverInviteRoot;
    this.resetRuntimeStateOnBoot();
  }

  // ---------------------------------------------------------------------------
  // boot / lifecycle

  /** Mirrors zouk-daemon's reconnect cleanup: agents/computers come back from
   *  whatever the previous process believed about them. Computers go offline
   *  until they re-heartbeat, agents fall back to registered/stopped, and any
   *  in-flight deliveries are requeued so a freshly reconnected computer can
   *  pick them up. */
  private resetRuntimeStateOnBoot(): void {
    this.store.mutate(s => {
      const now = this.clock();
      for (const computer of s.computers || []) {
        if (computer.status === "online") computer.status = "offline";
      }
      for (const agent of s.agents || []) {
        if (["online", "starting", "idle"].includes(agent.status)) {
          agent.status = agent.desiredStatus === "running" ? "registered" : "stopped";
        }
        agent.pid = null;
        agent.updatedAt = now;
      }
      for (const delivery of s.deliveries || []) {
        if (delivery.status === "delivering") {
          delivery.status = "pending";
          delivery.updatedAt = now;
          pushDeliveryLifecycle(delivery, "delivery.dispatch", now, "Delivery requeued after daemon restart");
        }
      }
    });
  }

  subscribe(listener: StateListener): () => void {
    return this.store.subscribe(listener);
  }

  /**
   * Periodic safety net: any delivery that has been in `delivering` longer
   * than `staleAfterMs` is treated as silently lost (daemon crashed, network
   * partitioned the result POST, runtime hung past its own timeout, etc.) —
   * mark it failed and post a system message so the user always sees *some*
   * feedback in the channel.
   */
  sweepStuckDeliveries(staleAfterMs: number): number {
    const cutoff = Date.now() - staleAfterMs;
    const cancellations: Array<{
      deliveryId: string;
      agentId: string;
      computerId: string;
      reason: string;
    }> = [];
    let swept = 0;
    this.store.mutate<void>(s => {
      const now = this.clock();
      for (const delivery of s.deliveries || []) {
        if (delivery.status !== "delivering") continue;
        const startedAt = Date.parse(delivery.updatedAt || delivery.createdAt || "");
        if (!Number.isFinite(startedAt) || startedAt > cutoff) continue;
        delivery.status = "failed";
        delivery.error = delivery.error || "delivery timed out without a result";
        delivery.updatedAt = now;
        pushDeliveryLifecycle(delivery, "delivery.result", now, "Delivery timed out", { ok: false, reason: delivery.error });
        createDeliveryEventRecord(s, {
          newId: this.newId,
          clock: this.clock,
          delivery,
          kind: "error",
          title: "Delivery timed out",
          text: delivery.error,
          status: "failed",
          payload: { reason: delivery.error },
          createdAt: now
        });
        cancellations.push({
          deliveryId: delivery.id,
          agentId: delivery.agentId,
          computerId: delivery.computerId,
          reason: delivery.error
        });
        const agent = s.agents.find(a => a.id === delivery.agentId);
        const label = agent ? `@${agent.handle || slugHandle(agent.name)}` : delivery.agentId;
        s.messages.push({
          id: this.newId("msg"),
          spaceId: delivery.spaceId,
          target: delivery.target,
          authorId: "system",
          type: "system",
          text: `${label} delivery timed out without a result (delivery=${delivery.id}). The agent may have crashed or its result callback was rejected.`,
          mentions: [],
          createdAt: now,
          threadId: threadRootFromTarget(delivery.target)
        });
        swept++;
      }
    });
    for (const cancellation of cancellations) {
      this.publishComputerPush(cancellation.computerId, {
        type: "cancel_delivery",
        payload: {
          deliveryId: cancellation.deliveryId,
          agentId: cancellation.agentId,
          reason: cancellation.reason
        }
      });
    }
    if (swept > 0) {
      console.log(`[core] sweepStuckDeliveries: marked ${swept} stuck delivery(ies) as failed`);
    }
    return swept;
  }

  // ---------------------------------------------------------------------------
  // health / state read

  health(): { ok: true; version: string; home: string; now: string } {
    return { ok: true, version: DAEMON_VERSION, home: this.store.home, now: this.clock() };
  }

  snapshot(): State {
    return this.store.snapshot();
  }

  // ---------------------------------------------------------------------------
  // spaces

  listSpaces(): Space[] {
    return this.store.snapshot().spaces || [];
  }

  createSpace(input: { name: string; slug?: string; description?: string }): Space {
    const rawName = validateSpaceName(input.name);
    const slug = slugSpaceName(input.slug || rawName);
    return this.store.mutate<Space>(s => {
      s.spaces ||= [];
      if (s.spaces.some(space => space.slug === slug)) {
        throw new HttpError(409, "space slug already exists");
      }
      const now = this.clock();
      const created: Space = {
        id: this.newId("space"),
        name: rawName,
        slug,
        description: String(input.description || "").trim() || undefined,
        createdAt: now,
        updatedAt: now
      };
      s.spaces.push(created);
      s.channels ||= [];
      if (!s.channels.some(ch => ch.spaceId === created.id && ch.target === "#all")) {
        s.channels.push({
          id: this.newId("chan"),
          spaceId: created.id,
          name: "all",
          target: "#all",
          kind: "channel",
          description: "General channel for all members",
          memberIds: ["human-local"],
          defaultAgentId: null,
          createdAt: now
        });
      }
      return created;
    });
  }

  deleteSpace(spaceId: string): void {
    if (spaceId === DEFAULT_SPACE_ID) {
      throw new HttpError(400, "cannot delete the default space");
    }
    this.store.mutate<void>(s => {
      const exists = (s.spaces || []).some(space => space.id === spaceId);
      if (!exists) throw new HttpError(404, "space not found");
      s.spaces = (s.spaces || []).filter(space => space.id !== spaceId);
      s.channels = (s.channels || []).filter(channel => channel.spaceId !== spaceId);
      s.agents = (s.agents || []).filter(agent => agent.spaceId !== spaceId);
      s.computers = (s.computers || []).filter(computer => computer.spaceId !== spaceId);
      s.pendingComputerConnections = (s.pendingComputerConnections || []).filter(p => p.spaceId !== spaceId);
      s.messages = (s.messages || []).filter(m => m.spaceId !== spaceId);
      s.deliveries = (s.deliveries || []).filter(d => d.spaceId !== spaceId);
      s.deliveryEvents = (s.deliveryEvents || []).filter(e => e.spaceId !== spaceId);
      s.deliveryArtifacts = (s.deliveryArtifacts || []).filter(e => e.spaceId !== spaceId);
      s.tasks = (s.tasks || []).filter(t => t.spaceId !== spaceId);
      s.scheduledTasks = (s.scheduledTasks || []).filter(t => t.spaceId !== spaceId);
      s.externalIngressPairings = (s.externalIngressPairings || []).filter(p => p.spaceId !== spaceId);
      s.externalIngressPolicies = (s.externalIngressPolicies || []).filter(p => p.spaceId !== spaceId);
      s.externalBotConfigs = (s.externalBotConfigs || []).filter(c => c.spaceId !== spaceId);
      s.externalBotBindings = (s.externalBotBindings || []).filter(b => b.spaceId !== spaceId);
      s.externalMessageLinks = (s.externalMessageLinks || []).filter(l => l.spaceId !== spaceId);
    });
  }

  /**
   * Snapshot pre-filtered to a single space; humans and the spaces list are
   * global. Every space-owned collection is scoped to the resolved space id.
   */
  snapshotForSpace(spaceIdInput: string | null | undefined): State {
    const raw = this.store.snapshot();
    const spaceId = resolveSpaceId(raw, spaceIdInput);
    return {
      ...raw,
      spaces: raw.spaces,
      humans: raw.humans,
      computers: (raw.computers || []).filter(item => item.spaceId === spaceId),
      pendingComputerConnections: (raw.pendingComputerConnections || []).filter(item => item.spaceId === spaceId),
      agents: (raw.agents || []).filter(item => item.spaceId === spaceId),
      channels: (raw.channels || []).filter(item => item.spaceId === spaceId),
      messages: (raw.messages || []).filter(item => item.spaceId === spaceId),
      deliveries: (raw.deliveries || []).filter(item => item.spaceId === spaceId),
      deliveryEvents: (raw.deliveryEvents || []).filter(item => item.spaceId === spaceId),
      deliveryArtifacts: (raw.deliveryArtifacts || []).filter(item => item.spaceId === spaceId),
      tasks: (raw.tasks || []).filter(item => item.spaceId === spaceId),
      scheduledTasks: (raw.scheduledTasks || []).filter(item => item.spaceId === spaceId),
      externalIngressPairings: (raw.externalIngressPairings || []).filter(item => item.spaceId === spaceId),
      externalIngressPolicies: (raw.externalIngressPolicies || []).filter(item => item.spaceId === spaceId),
      externalBotConfigs: (raw.externalBotConfigs || []).filter(item => item.spaceId === spaceId),
      externalBotBindings: (raw.externalBotBindings || []).filter(item => item.spaceId === spaceId),
      externalMessageLinks: (raw.externalMessageLinks || []).filter(item => item.spaceId === spaceId),
      events: raw.events
    };
  }

  /**
   * Resolve a caller-provided space selector against the current store. Used
   * by every mutation entry point that accepts a `SpaceContext`.
   */
  private resolveSpaceId(spaceId: string | null | undefined): string {
    return resolveSpaceId(this.store.snapshot(), spaceId);
  }

  listChannels(spaceId?: string | null) {
    const state = this.snapshotForSpace(spaceId);
    const messages = state.messages || [];
    return (state.channels || []).map(channel => ({
      ...channel,
      messageCount: messages.filter(message => parentTargetFromThread(message.target) === channel.target).length
    }));
  }

  listAgents(spaceId?: string | null) {
    return this.snapshotForSpace(spaceId).agents || [];
  }

  listComputers(spaceId?: string | null) {
    return this.snapshotForSpace(spaceId).computers || [];
  }

  listHumans() {
    return this.store.snapshot().humans || [];
  }

  patchHuman(humanId: string, input: HumanPatchInput): Human {
    return this.store.mutate<Human>(s => {
      const current = (s.humans || []).find(human => human.id === humanId);
      if (!current) throw new HttpError(404, "human not found");
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw new HttpError(400, "name is required");
        current.name = name;
      }
      return current;
    });
  }

  listDeliveries(spaceId?: string | null) {
    return this.snapshotForSpace(spaceId).deliveries || [];
  }

  listDeliveryEvents(filter: {
    spaceId?: string | null;
    target?: string | null;
    deliveryId?: string | null;
    limit?: number | string | null;
  } = {}): DeliveryEvent[] {
    let events = this.store.snapshot().deliveryEvents || [];
    if (filter.spaceId !== undefined) {
      const spaceId = this.resolveSpaceId(filter.spaceId);
      events = events.filter(event => event.spaceId === spaceId);
    }
    if (filter.target) events = events.filter(event => event.target === filter.target);
    if (filter.deliveryId) events = events.filter(event => event.deliveryId === filter.deliveryId);
    const limit = parseMessageLimit(filter.limit);
    return [...events]
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.sequence - right.sequence ||
        left.id.localeCompare(right.id)
      )
      .slice(-limit);
  }

  listDeliveryArtifacts(filter: {
    spaceId?: string | null;
    target?: string | null;
    deliveryId?: string | null;
    eventId?: string | null;
    limit?: number | string | null;
  } = {}): DeliveryArtifact[] {
    let artifacts = this.store.snapshot().deliveryArtifacts || [];
    if (filter.spaceId !== undefined) {
      const spaceId = this.resolveSpaceId(filter.spaceId);
      artifacts = artifacts.filter(artifact => artifact.spaceId === spaceId);
    }
    if (filter.target) artifacts = artifacts.filter(artifact => artifact.target === filter.target);
    if (filter.deliveryId) artifacts = artifacts.filter(artifact => artifact.deliveryId === filter.deliveryId);
    if (filter.eventId) artifacts = artifacts.filter(artifact => artifact.eventId === filter.eventId);
    const limit = parseMessageLimit(filter.limit);
    return [...artifacts]
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
      )
      .slice(-limit);
  }

  getDeliveryArtifact(artifactId: string, spaceId?: string | null): DeliveryArtifact {
    const resolved = spaceId !== undefined ? this.resolveSpaceId(spaceId) : null;
    const artifact = (this.store.snapshot({ includeArtifactContent: true }).deliveryArtifacts || []).find(item =>
      item.id === artifactId && (!resolved || item.spaceId === resolved)
    );
    if (!artifact) throw new HttpError(404, "delivery artifact not found");
    return artifact;
  }

  listIngressPairings(spaceId?: string | null) {
    return this.snapshotForSpace(spaceId).externalIngressPairings || [];
  }

  listIngressPolicies(spaceId?: string | null) {
    return (this.snapshotForSpace(spaceId).externalIngressPolicies || []).map(policy => ({
      ...policy,
      token: maskToken(policy.token)
    }));
  }

  listExternalBotConfigs(spaceId?: string | null) {
    return (this.snapshotForSpace(spaceId).externalBotConfigs || []).map(config => ({
      ...config,
      appSecret: maskToken(config.appSecret)
    }));
  }

  /**
   * Return every stored bot config across all spaces, with secrets intact.
   * Used exclusively by the daemon's bot runtime to enumerate WS clients at
   * boot; regular HTTP responses must go through `listExternalBotConfigs` so
   * secrets stay masked and results stay space-scoped.
   */
  listAllExternalBotConfigsRaw(): ExternalBotConfig[] {
    return (this.store.snapshot().externalBotConfigs || []).map(config => ({ ...config }));
  }

  getExternalBotConfig(provider: string, spaceId?: string | null): ExternalBotConfig | null {
    const normalized = normalizeProvider(provider);
    const resolved = this.resolveSpaceId(spaceId);
    return (this.store.snapshot().externalBotConfigs || []).find(config =>
      config.provider === normalized && config.spaceId === resolved
    ) || null;
  }

  /**
   * Direct id-based lookup used by the bot runtime when it already knows a
   * specific `(provider, spaceId)` tuple — bypasses space resolution so the
   * runtime can operate across every space regardless of the daemon's "active
   * space" for API reads.
   */
  getExternalBotConfigInSpace(provider: string, spaceId: string): ExternalBotConfig | null {
    const normalized = normalizeProvider(provider);
    const target = String(spaceId || "").trim() || DEFAULT_SPACE_ID;
    return (this.store.snapshot().externalBotConfigs || []).find(config =>
      config.provider === normalized && config.spaceId === target
    ) || null;
  }

  listExternalBotBindings(spaceId?: string | null) {
    return this.snapshotForSpace(spaceId).externalBotBindings || [];
  }

  listExternalMessageLinks(spaceId?: string | null) {
    return this.snapshotForSpace(spaceId).externalMessageLinks || [];
  }

  listPendingConnections(spaceId?: string | null) {
    return this.snapshotForSpace(spaceId).pendingComputerConnections || [];
  }

  listTasks(filter: {
    target?: string | null;
    status?: string | null;
    assigneeId?: string | null;
    createdBy?: string | null;
    q?: string | null;
    includeDone?: boolean;
    spaceId?: string | null;
  } = {}) {
    const snapshot = this.store.snapshot();
    const spaceId = filter.spaceId !== undefined ? this.resolveSpaceId(filter.spaceId) : null;
    const replyCounts = new Map<string, number>();
    for (const message of snapshot.messages || []) {
      const threadId = threadRootFromTarget(message.target);
      if (!threadId) continue;
      replyCounts.set(threadId, (replyCounts.get(threadId) || 0) + 1);
    }
    let tasks = snapshot.tasks || [];
    if (spaceId) tasks = tasks.filter(task => task.spaceId === spaceId);
    if (filter.target) tasks = tasks.filter(task => task.target === filter.target);
    const status = normalizeOptionalString(filter.status);
    if (status && status !== "all") {
      tasks = status === "open"
        ? tasks.filter(task => isOpenTaskStatus(task.status))
        : tasks.filter(task => task.status === status);
    } else if (status !== "all" && !filter.includeDone) {
      tasks = tasks.filter(task => isOpenTaskStatus(task.status));
    }
    if (filter.assigneeId) tasks = tasks.filter(task => task.assigneeId === filter.assigneeId);
    if (filter.createdBy) tasks = tasks.filter(task => task.createdBy === filter.createdBy);
    const query = normalizeOptionalString(filter.q)?.toLowerCase();
    if (query) {
      tasks = tasks.filter(task =>
        task.title.toLowerCase().includes(query) ||
        task.description.toLowerCase().includes(query)
      );
    }
    return tasks.map(task => ({
      ...task,
      replyCount: replyCounts.get(task.messageId) || 0
    }));
  }

  listScheduledTasks(filter: { target?: string | null; status?: string | null; agentId?: string | null; spaceId?: string | null } = {}) {
    let tasks = this.store.snapshot().scheduledTasks || [];
    if (filter.spaceId !== undefined) {
      const spaceId = this.resolveSpaceId(filter.spaceId);
      tasks = tasks.filter(task => task.spaceId === spaceId);
    }
    if (filter.target) tasks = tasks.filter(task => task.target === filter.target);
    if (filter.status) tasks = tasks.filter(task => task.status === filter.status);
    if (filter.agentId) tasks = tasks.filter(task => task.agentId === filter.agentId);
    return tasks;
  }

  listMessagesByTarget(query: MessageQuery): Message[] {
    if (!query.target) {
      throw new HttpError(400, "target is required; use /api/messages/channel/:channelId for channel messages");
    }
    const snapshot = this.store.snapshot();
    const spaceId = query.spaceId !== undefined ? this.resolveSpaceId(query.spaceId) : null;
    const limit = parseMessageLimit(query.limit);
    const filtered = (snapshot.messages || []).filter(message =>
      message.target === query.target && (!spaceId || message.spaceId === spaceId)
    );
    return paginateMessages(filtered, { limit, before: query.before ?? null });
  }

  listMessagesByChannel(query: ChannelMessageQuery): Array<Message & { replyCount: number; depth?: number }> {
    const snapshot = this.store.snapshot();
    const spaceId = query.spaceId !== undefined ? this.resolveSpaceId(query.spaceId) : null;
    const channel = findChannel(snapshot, query.channelId, spaceId);
    if (!channel) throw new HttpError(404, "channel not found");
    const limit = parseMessageLimit(query.limit);
    const messages = (snapshot.messages || []).filter(message =>
      message.target === channel.target &&
      !message.threadId &&
      (!spaceId || message.spaceId === spaceId)
    );
    const paginated = paginateMessages(messages, { limit, before: query.before ?? null });
    const withReplies = withReplyCounts(snapshot.messages || [], paginated);
    return withDeliveryDepth(snapshot.deliveries || [], withReplies);
  }

  // ---------------------------------------------------------------------------
  // channels

  createChannel(input: ChannelCreateInput) {
    if (!input.name?.trim()) throw new HttpError(400, "name is required");
    const spaceId = this.resolveSpaceId(input.spaceId);
    return this.store.mutate(s => {
      const now = this.clock();
      const name = slugChannelName(input.name);
      const target = `#${name}`;
      if (s.channels.some(channel => channel.spaceId === spaceId && channel.target === target)) {
        throw new HttpError(409, "channel already exists");
      }
      const defaultAgentId = normalizeOptionalString(input.defaultAgentId);
      if (defaultAgentId && !s.agents.some(agent => agent.id === defaultAgentId && agent.spaceId === spaceId)) {
        throw new HttpError(404, "defaultAgentId does not exist in this space");
      }
      const created = {
        id: this.newId("chan"),
        spaceId,
        name,
        target,
        kind: input.private ? "private" : "channel",
        description: input.description?.trim() || `Channel for ${name}`,
        memberIds: [
          ...(s.humans || []).map(human => human.id),
          ...(s.agents || []).filter(agent => agent.spaceId === spaceId).map(agent => agent.id)
        ],
        defaultAgentId: defaultAgentId || null,
        createdAt: now
      };
      s.channels.push(created);
      s.messages.push({
        id: this.newId("msg"),
        spaceId,
        target,
        authorId: "system",
        type: "system",
        text: `Channel #${name} created`,
        mentions: [],
        createdAt: now,
        threadId: null
      });
      return created;
    });
  }

  patchChannel(channelId: string, input: ChannelPatchInput) {
    return this.store.mutate(s => {
      const current = s.channels.find(channel => channel.id === channelId);
      if (!current) throw new HttpError(404, "channel not found");

      const oldTarget = current.target;
      if (input.name?.trim()) {
        const name = slugChannelName(input.name);
        const target = `#${name}`;
        if (oldTarget === "#all" && target !== oldTarget) {
          throw new HttpError(400, "cannot rename the default #all channel");
        }
        if (target !== oldTarget && s.channels.some(channel =>
          channel.id !== current.id && channel.spaceId === current.spaceId && channel.target === target
        )) {
          throw new HttpError(409, "channel already exists");
        }
        current.name = name;
        current.target = target;
        migrateChannelTarget(s, oldTarget, target, this.clock);
      }
      if (input.description !== undefined) current.description = input.description.trim();
      if (input.defaultAgentId !== undefined) {
        const next = normalizeOptionalString(input.defaultAgentId);
        if (next && !s.agents.some(agent => agent.id === next && agent.spaceId === current.spaceId)) {
          throw new HttpError(404, "defaultAgentId does not exist in this space");
        }
        current.defaultAgentId = next || null;
      }
      return current;
    });
  }

  deleteChannel(channelId: string): Channel {
    const result = this.store.mutate<{
      channel: Channel;
      cancellations: Array<{ deliveryId: string; agentId: string; computerId: string }>;
    }>(s => {
      const current = (s.channels || []).find(channel => channel.id === channelId);
      if (!current) throw new HttpError(404, "channel not found");
      if (current.target === "#all") throw new HttpError(400, "cannot delete the default #all channel");
      if (current.kind === "dm") {
        throw new HttpError(400, "direct message channels can only be removed by deleting their agent");
      }

      const removed = { ...current };
      const spaceId = current.spaceId;
      const target = current.target;
      const threadPrefix = `${target}:`;
      const belongsToChannel = (candidate: string | null | undefined) =>
        candidate === target || Boolean(candidate?.startsWith(threadPrefix));
      const removedMessageIds = new Set(
        (s.messages || [])
          .filter(message => message.spaceId === spaceId && belongsToChannel(message.target))
          .map(message => message.id)
      );

      for (const task of s.tasks || []) {
        if (
          task.spaceId === spaceId &&
          (belongsToChannel(task.target) || belongsToChannel(task.threadTarget))
        ) {
          removedMessageIds.add(task.messageId);
        }
      }
      for (const delivery of s.deliveries || []) {
        if (delivery.spaceId === spaceId && belongsToChannel(delivery.target)) {
          removedMessageIds.add(delivery.messageId);
          removedMessageIds.add(delivery.rootMessageId);
        }
      }

      const cancellations = (s.deliveries || [])
        .filter(delivery =>
          delivery.spaceId === spaceId &&
          belongsToChannel(delivery.target) &&
          !["done", "failed", "cancelled"].includes(delivery.status)
        )
        .map(delivery => ({
          deliveryId: delivery.id,
          agentId: delivery.agentId,
          computerId: delivery.computerId
        }));
      const now = this.clock();

      s.channels = (s.channels || []).filter(channel => channel.id !== channelId);
      s.messages = (s.messages || []).filter(message =>
        !(message.spaceId === spaceId && belongsToChannel(message.target))
      );
      s.tasks = (s.tasks || []).filter(task =>
        !(
          task.spaceId === spaceId &&
          (belongsToChannel(task.target) || belongsToChannel(task.threadTarget))
        )
      );
      s.deliveryEvents = (s.deliveryEvents || []).filter(event =>
        !(event.spaceId === spaceId && belongsToChannel(event.target))
      );
      s.deliveryArtifacts = (s.deliveryArtifacts || []).filter(artifact =>
        !(artifact.spaceId === spaceId && belongsToChannel(artifact.target))
      );
      s.scheduledTasks = (s.scheduledTasks || []).filter(task =>
        !(task.spaceId === spaceId && belongsToChannel(task.target))
      );
      s.deliveries = (s.deliveries || []).filter(delivery =>
        !(delivery.spaceId === spaceId && belongsToChannel(delivery.target))
      );
      s.externalIngressPairings = (s.externalIngressPairings || []).filter(pairing =>
        !(pairing.spaceId === spaceId && belongsToChannel(pairing.target))
      );
      s.externalIngressPolicies = (s.externalIngressPolicies || []).filter(policy =>
        !(policy.spaceId === spaceId && belongsToChannel(policy.target))
      );
      for (const binding of s.externalBotBindings || []) {
        if (binding.spaceId === spaceId && belongsToChannel(binding.defaultTarget)) {
          binding.defaultTarget = null;
          binding.updatedAt = now;
        }
      }
      s.externalMessageLinks = (s.externalMessageLinks || []).filter(link =>
        !(
          link.spaceId === spaceId &&
          (
            removedMessageIds.has(link.messageId) ||
            Boolean(link.rootMessageId && removedMessageIds.has(link.rootMessageId))
          )
        )
      );

      return { channel: removed, cancellations };
    });

    for (const cancellation of result.cancellations) {
      this.publishComputerPush(cancellation.computerId, {
        type: "cancel_delivery",
        payload: {
          deliveryId: cancellation.deliveryId,
          agentId: cancellation.agentId,
          reason: `channel ${result.channel.target} was deleted`
        }
      });
    }
    return result.channel;
  }

  ensureAgentDmChannel(agentId: string) {
    return this.store.mutate(s => {
      const now = this.clock();
      return this.ensureAgentDmChannelInState(s, agentId, now);
    });
  }

  // ---------------------------------------------------------------------------
  // computers / connect flow

  createConnectInvite(input: ConnectInviteInput, originFromHost: string): ConnectInviteResult {
    const origin = input.serverUrl || originFromHost;
    const spaceId = this.resolveSpaceId(input.spaceId);
    const token = this.newId("connect");
    const invite = this.store.mutate<PendingComputerConnection>(s => {
      const now = this.clock();
      const created: PendingComputerConnection = {
        id: this.newId("computer_invite"),
        spaceId,
        token,
        status: "waiting",
        createdAt: now,
        connectedComputerId: null,
        label: input.label || "New computer"
      };
      s.pendingComputerConnections ||= [];
      s.pendingComputerConnections.push(created);
      return created;
    });
    const command = [
      "npx",
      "-y",
      "@myersguo/iteam@latest",
      "daemon",
      "connect",
      "--server-url",
      shellQuote(origin),
      "--connect-token",
      shellQuote(token),
      "--space-id",
      shellQuote(spaceId)
    ].join(" ");
    return { ...invite, command, serverUrl: origin };
  }

  connectComputer(input: ConnectComputerInput): ConnectComputerResult {
    if (!input.fingerprint?.id) throw new HttpError(400, "fingerprint is required");
    if (!input.token) throw new HttpError(400, "token is required");

    const result = this.store.mutate<ConnectComputerResult>(s => {
      const now = this.clock();
      const fingerprint = input.fingerprint;
      s.pendingComputerConnections ||= [];

      // Token is the sole identity. Each computer is bound to exactly one
      // server-issued connect token at first registration; the same token
      // is used forever after for heartbeats / runtime callbacks. This means
      // two physical machines that happen to share a fingerprint (rare, but
      // possible — e.g. two clones of a VM image) are still distinct
      // computers because they hold distinct tokens.
      let current: typeof s.computers[number] | undefined = s.computers.find(
        c => c.connectToken && c.connectToken === input.token
      );
      let invite: PendingComputerConnection | undefined;

      if (!current) {
        // No computer owns this token yet → must be first-time onboarding
        // via a `waiting` invite. Reject anything else so a leaked / guessed
        // token cannot register a brand new computer.
        //
        // Invites are one-shot: once status leaves "waiting" the same token
        // must NOT mint another computer, otherwise an old invite could be
        // replayed forever.
        invite = s.pendingComputerConnections.find(item =>
          item.token === input.token && (item.status || "waiting") === "waiting"
        );
        if (!invite) throw new HttpError(401, "invalid connect token");
        // First connect for this token: create a brand-new computer record.
        // Identity is `computer_<invite-id-suffix>` rather than fingerprint
        // so two daemons with the same fingerprint but different tokens
        // get two distinct computers.
        current = {
          id: `computer_${invite.id.replace(/^computer_invite_/, "").slice(0, 16)}`,
          spaceId: invite.spaceId || DEFAULT_SPACE_ID,
          name: input.name || fingerprint.hostname,
          fingerprint,
          status: "online",
          daemonVersion: input.daemonVersion || "unknown",
          runtimes: input.runtimes || [],
          agentIds: [],
          connectionId: invite.id,
          connectToken: input.token,
          createdAt: now,
          firstConnectedAt: now
        };
        s.computers.push(current);
      }

      current.name = input.name || current.name;
      current.status = "online";
      current.daemonVersion = input.daemonVersion || current.daemonVersion;
      current.runtimes = input.runtimes || current.runtimes;
      current.fingerprint = fingerprint;
      if (invite) {
        current.connectionId = invite.id;
        invite.status = "connected";
        invite.connectedComputerId = current.id;
        invite.connectedAt = invite.connectedAt || now;
      }
      current.lastSeenAt = now;

      // Daemon reconnect (no live SSE listener) means any agent still marked
      // online/starting is a ghost from the previous daemon process — the
      // driver never emitted an `exited` event because the daemon crashed
      // or was killed. Reset those agents so the launchAgents filter below
      // picks them up and re-spawns them on this heartbeat.
      if (!this.computerListeners.get(current.id)?.size) {
        for (const agent of s.agents) {
          if (
            agent.computerId === current.id &&
            agent.desiredStatus === "running" &&
            ["online", "starting", "idle"].includes(agent.status)
          ) {
            agent.status = "registered";
            agent.pid = null;
            agent.updatedAt = now;
          }
        }
      }

      const launchAgents = s.agents
        .filter(agent =>
          agent.computerId === current!.id &&
          agent.desiredStatus === "running" &&
          !["online", "starting"].includes(agent.status)
        )
        .map(agent => ({ ...agent }));
      const stopAgents = s.agents
        .filter(agent => agent.computerId === current!.id && agent.desiredStatus === "stopped" && agent.pid)
        .map(agent => ({ ...agent }));
      const deliveries = (s.deliveries || [])
        .filter(delivery => delivery.computerId === current!.id && delivery.status === "pending")
        .map<DeliveryWithContext>(delivery => {
          delivery.status = "delivering";
          delivery.updatedAt = now;
          pushDeliveryLifecycle(delivery, "delivery.ack", now, "Delivery claimed by computer heartbeat");
          const message = s.messages.find(message => message.id === delivery.messageId);
          const author = findMember(s, message?.authorId);
          return {
            ...delivery,
            agent: s.agents.find(agent => agent.id === delivery.agentId),
            message,
            author,
            contextMessages: buildConversationContext(s, message),
            activeDeliveries: buildActiveDeliveryContext(s, delivery),
            members: listMembers(s)
          };
        })
        .filter(delivery => delivery.agent && delivery.message);
      return { ...current, launchAgents, stopAgents, deliveries };
    });
    if (result.launchAgents.length || result.stopAgents.length || result.deliveries.length) {
      console.log(
        `[core] computer ${result.id} (${result.name}) heartbeat: launch=${result.launchAgents.length} stop=${result.stopAgents.length} deliveries=${result.deliveries.length}`
      );
    }
    return result;
  }

  /**
   * Removes a computer and everything that hangs off it: its agents, their DM
   * channels, queued/finished deliveries, and any pending connect invite that
   * was bound to this computer. Active SSE listeners are dropped from the
   * router map; any still-running daemon will get HTTP 401 from
   * `authenticateComputer` on its next callback and exit on its own.
   */
  deleteComputer(computerId: string): void {
    this.store.mutate(s => {
      const exists = (s.computers || []).some(c => c.id === computerId);
      if (!exists) throw new HttpError(404, "computer not found");
      const removedAgentIds = (s.agents || [])
        .filter(a => a.computerId === computerId)
        .map(a => a.id);
      s.computers = (s.computers || []).filter(c => c.id !== computerId);
      s.agents = (s.agents || []).filter(a => a.computerId !== computerId);
      s.deliveries = (s.deliveries || []).filter(d => d.computerId !== computerId);
      s.deliveryEvents = (s.deliveryEvents || []).filter(event =>
        !removedAgentIds.includes(event.agentId)
      );
      s.deliveryArtifacts = (s.deliveryArtifacts || []).filter(artifact =>
        !removedAgentIds.includes(artifact.agentId)
      );
      s.pendingComputerConnections = (s.pendingComputerConnections || [])
        .filter(p => p.connectedComputerId !== computerId);
      if (removedAgentIds.length > 0) {
        const dropped = new Set(removedAgentIds);
        s.channels = (s.channels || []).filter(ch =>
          !(ch.kind === "dm" && typeof ch.target === "string" && ch.target.startsWith("dm:") && dropped.has(ch.target.slice(3)))
        );
      }
    });
    const stale = this.computerListeners.get(computerId);
    if (stale) {
      for (const fn of stale) this.computerEvictors.delete(fn);
    }
    this.computerListeners.delete(computerId);
  }

  /**
   * Validates `<computerId>:<token>` credentials presented in a header. Returns
   * the resolved Computer or throws HttpError(401). The HTTP layer uses this to
   * gate runtime-status / runtime-event / delivery-result callbacks so that a
   * leaked agent id alone is not enough to spoof updates.
   */
  authenticateComputer(computerId: string, token: string) {
    const state = this.store.snapshot();
    const computer = state.computers.find(c => c.id === computerId);
    if (!computer) {
      console.warn(`[auth] reject ${computerId}: computer not found (presented token ${maskToken(token)})`);
      throw new HttpError(401, "invalid connection credentials");
    }
    if (!computer.connectToken) {
      console.warn(`[auth] reject ${computerId}: computer has no bound token (presented ${maskToken(token)})`);
      throw new HttpError(401, "invalid connection credentials");
    }
    if (computer.connectToken !== token) {
      console.warn(
        `[auth] reject ${computerId}: token mismatch ` +
        `(presented=${maskToken(token)} expected=${maskToken(computer.connectToken)})`
      );
      throw new HttpError(401, "invalid connection credentials");
    }
    return computer;
  }

  authenticateAgent(computerId: string, agentId: string, token: string): Agent {
    const state = this.store.snapshot();
    const computer = state.computers.find(item => item.id === computerId);
    const agent = state.agents.find(item => item.id === agentId);
    if (!computer?.connectToken || !agent || agent.computerId !== computerId) {
      throw new HttpError(401, "invalid agent connection credentials");
    }
    const expected = deriveAgentAuthToken(computer.connectToken, agentId);
    if (!safeTokenEqual(expected, token)) {
      throw new HttpError(401, "invalid agent connection credentials");
    }
    return agent;
  }

  /**
   * Subscribe a listener for backend → client push commands targeting one
   * computer. Returns an unsubscribe function. The HTTP layer wraps each SSE
   * connection in one of these listeners.
   */
  subscribeComputerPush(computerId: string, listener: ComputerPushListener, onEvicted?: () => void): () => void {
    let set = this.computerListeners.get(computerId);
    if (!set) {
      set = new Set<ComputerPushListener>();
      this.computerListeners.set(computerId, set);
    }
    // Newest SSE wins: evict and close any pre-existing listeners so we
    // never end up fanning the same delivery to multiple subscribers.
    if (set.size > 0) {
      console.log(`[core] subscribe push ${computerId}: evicting ${set.size} stale listener(s)`);
      const stale = Array.from(set);
      set.clear();
      for (const fn of stale) {
        const evict = this.computerEvictors.get(fn);
        this.computerEvictors.delete(fn);
        if (evict) {
          try { evict(); } catch (error) {
            console.error(`[core] evict callback for ${computerId} threw: ${(error as Error).message}`);
          }
        }
      }
    }
    set.add(listener);
    if (onEvicted) this.computerEvictors.set(listener, onEvicted);
    console.log(`[core] subscribe push ${computerId} listeners=${set.size}`);
    return () => {
      const current = this.computerListeners.get(computerId);
      if (!current) return;
      current.delete(listener);
      this.computerEvictors.delete(listener);
      console.log(`[core] unsubscribe push ${computerId} listeners=${current.size}`);
      if (current.size === 0) this.computerListeners.delete(computerId);
    };
  }

  /**
   * Number of active push subscribers for a computer. Used by the HTTP layer
   * to decide whether to fall back to polling (no listeners → cold start).
   */
  hasComputerPushListener(computerId: string): boolean {
    const set = this.computerListeners.get(computerId);
    return !!set && set.size > 0;
  }

  private publishComputerPush(computerId: string, event: ComputerPushEvent): void {
    const set = this.computerListeners.get(computerId);
    if (!set || set.size === 0) return;
    if (event.type !== "ping") {
      const tag =
        event.type === "delivery" ? `delivery=${(event.payload as DeliveryWithContext).id}` :
        event.type === "launch" ? `launch=${(event.payload as Agent).id}` :
        event.type === "stop" ? `stop=${(event.payload as Agent).id}` : "";
      console.log(`[core] push ${event.type} -> ${computerId} listeners=${set.size}${tag ? " " + tag : ""}`);
    }
    for (const listener of set) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[core] push listener for ${computerId} threw: ${(error as Error).message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // agents

  createAgent(input: AgentCreateInput): Agent {
    if (!input.name) throw new HttpError(400, "name is required");
    if (!input.computerId) throw new HttpError(400, "computerId is required");

    const state = this.store.snapshot();
    const computer = state.computers.find(c => c.id === input.computerId);
    if (!computer) throw new HttpError(404, "computer not found");
    const spaceId = this.resolveSpaceId(input.spaceId || computer.spaceId);
    if (computer.spaceId && computer.spaceId !== spaceId) {
      throw new HttpError(400, "computer belongs to a different space");
    }
    const runtime = normalizeOptionalString(input.runtime) || defaultRuntimeForComputer(computer.runtimes || []);
    if (!runtime) throw new HttpError(400, "runtime is required");
    const agent = this.store.mutate<Agent>(s => {
      const now = this.clock();
      const agentId = this.newId("agent");
      const created: Agent = {
        id: agentId,
        spaceId,
        name: input.name,
        handle: input.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
        description: input.description || "Local AI teammate",
        runtime: runtime as Agent["runtime"],
        model: input.model || null,
        reasoning: input.reasoning || "medium",
        computerId: computer.id,
        status: "registered",
        desiredStatus: "running",
        launchId: null,
        pid: null,
        workspacePath: `${this.store.agentRoot}/${agentId}`,
        createdAt: now,
        updatedAt: now,
        env: input.env || {}
      };
      s.agents.push(created);
      const linkedComputer = s.computers.find(c => c.id === computer.id);
      if (linkedComputer && !linkedComputer.agentIds.includes(created.id)) {
        linkedComputer.agentIds.push(created.id);
      }
      const all = s.channels.find(c => c.spaceId === spaceId && c.target === "#all");
      if (all && !all.memberIds.includes(created.id)) all.memberIds.push(created.id);
      return created;
    });
    // Push a launch command to the owning computer; if no SSE listener is
    // attached yet, the command will be picked up via the next /connect call
    // (deliveries/launchAgents are still computed there).
    this.publishComputerPush(agent.computerId, { type: "launch", payload: { ...agent } });
    return agent;
  }

  patchAgent(agentId: string, input: AgentPatchInput): Agent {
    return this.store.mutate<Agent>(s => {
      const current = s.agents.find(agent => agent.id === agentId);
      if (!current) throw new HttpError(404, "agent not found");
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw new HttpError(400, "name is required");
        const handle = slugHandle(name);
        const taken = s.agents.some(agent =>
          agent.id !== current.id &&
          agent.spaceId === current.spaceId &&
          agent.handle === handle
        );
        if (taken) throw new HttpError(409, "agent handle already exists");
        current.name = name;
        current.handle = handle;
      }
      if (input.description !== undefined) current.description = input.description.trim();
      if (input.model !== undefined) current.model = input.model || null;
      current.updatedAt = this.clock();
      return current;
    });
  }

  deleteAgent(agentId: string): Agent {
    const removed = this.store.mutate<Agent>(s => {
      const now = this.clock();
      const current = (s.agents || []).find(agent => agent.id === agentId);
      if (!current) throw new HttpError(404, "agent not found");
      const removedAgent = { ...current };
      s.agents = (s.agents || []).filter(agent => agent.id !== agentId);
      for (const computer of s.computers || []) {
        computer.agentIds = (computer.agentIds || []).filter(id => id !== agentId);
      }
      s.channels = (s.channels || [])
        .filter(channel => !(channel.kind === "dm" && channel.target === `dm:${agentId}`))
        .map(channel => ({
          ...channel,
          memberIds: (channel.memberIds || []).filter(id => id !== agentId),
          defaultAgentId: channel.defaultAgentId === agentId ? null : channel.defaultAgentId
        }));
      s.deliveries = (s.deliveries || []).filter(delivery => delivery.agentId !== agentId);
      s.deliveryEvents = (s.deliveryEvents || []).filter(event => event.agentId !== agentId);
      s.deliveryArtifacts = (s.deliveryArtifacts || []).filter(artifact => artifact.agentId !== agentId);
      for (const task of s.tasks || []) {
        if (task.assigneeId === agentId) {
          task.assigneeId = null;
          task.updatedAt = now;
        }
      }
      for (const scheduled of s.scheduledTasks || []) {
        if (scheduled.agentId === agentId) {
          scheduled.status = "paused";
          scheduled.updatedAt = now;
        }
      }
      for (const binding of s.externalBotBindings || []) {
        if (binding.defaultAgentId === agentId) binding.defaultAgentId = null;
      }
      return removedAgent;
    });
    if (removed.computerId) {
      this.publishComputerPush(removed.computerId, {
        type: "stop",
        payload: { ...removed, desiredStatus: "stopped", status: "stopped" }
      });
    }
    return removed;
  }

  reportRuntimeStatus(agentId: string, input: RuntimeStatusInput): Agent {
    return this.store.mutate<Agent>(s => {
      const current = s.agents.find(agent => agent.id === agentId);
      if (!current) throw new HttpError(404, "agent not found");
      current.status = input.status || current.status;
      current.updatedAt = this.clock();
      current.launchId = (input.details?.launchId as string | undefined) ?? current.launchId;
      if (input.details && Object.prototype.hasOwnProperty.call(input.details, "pid")) {
        current.pid = (input.details.pid as number | null) ?? null;
      }
      current.lastRuntimeStatus = input.details || {};
      if (input.status === "exited") current.pid = null;
      if (input.status === "launch_failed" || input.status === "stopped") {
        current.desiredStatus = "stopped";
        current.pid = null;
      }
      return current;
    });
  }

  recordRuntimeEvent(agentId: string, input: RuntimeEventInput): void {
    this.store.emit("agent:runtime_event", { agentId, ...input });
  }

  createDeliveryEvent(input: DeliveryEventCreateInput): DeliveryEvent {
    const event = this.store.mutate<DeliveryEvent>(s => {
      const delivery = (s.deliveries || []).find(item => item.id === input.deliveryId);
      if (!delivery) throw new HttpError(404, "delivery not found");
      const event = createDeliveryEventRecord(s, {
        newId: this.newId,
        clock: this.clock,
        delivery,
        kind: input.kind,
        title: input.title,
        text: input.text,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        status: input.status,
        payload: input.payload,
        createdAt: input.createdAt
      });
      return event;
    });
    this.store.emit("delivery:event", { event });
    return event;
  }

  setAgentDesiredStatus(agentId: string, action: "start" | "stop"): Agent {
    const agent = this.store.mutate<Agent>(s => {
      const found = s.agents.find(agent => agent.id === agentId);
      if (!found) throw new HttpError(404, "agent not found");
      found.desiredStatus = action === "start" ? "running" : "stopped";
      found.status = action === "start" ? "registered" : "stopped";
      if (action === "start") found.pid = null;
      found.updatedAt = this.clock();
      return found;
    });
    // Notify the owning computer so it can launch/stop the runtime immediately
    // without waiting for the next heartbeat.
    if (agent.computerId) {
      this.publishComputerPush(agent.computerId, {
        type: action === "start" ? "launch" : "stop",
        payload: { ...agent }
      });
    }
    return agent;
  }

  // ---------------------------------------------------------------------------
  // messages / deliveries

  createMessage(input: MessageCreateInput): Message {
    if (!input.target || !input.text) throw new HttpError(400, "target and text are required");
    const spaceId = this.resolveSpaceId(input.spaceId);
    const createdIds: string[] = [];
    const message = this.store.mutate<Message>(s => {
      const now = this.clock();
      const authorId = input.authorId || "human-local";
      const authorAgentInAnySpace = s.agents.find(agent => agent.id === authorId);
      const authorAgent = s.agents.find(agent => agent.id === authorId && agent.spaceId === spaceId);
      if (authorAgentInAnySpace && !authorAgent) {
        throw new HttpError(403, "agent cannot post to a different space");
      }
      const scheduleParse = authorAgent
        ? stripScheduleDirective(input.text)
        : { text: input.text, directive: null };
      const created: Message = {
        id: this.newId("msg"),
        spaceId,
        target: input.target,
        authorId,
        type: input.type || (authorAgent ? "agent" : "human"),
        text: scheduleParse.text,
        mentions: input.mentions || parseMentions(scheduleParse.text, s, spaceId),
        createdAt: input.createdAt || now,
        threadId: input.threadId !== undefined ? input.threadId : threadRootFromTarget(input.target)
      };
      s.messages.push(created);
      if (authorAgent) {
        this.linkOutboundForExternalRoot(s, created, created.threadId || created.id, now);
      }
      if (authorAgent && scheduleParse.directive) {
        this.applyScheduleDirective(s, {
          spaceId,
          target: created.target,
          agentId: authorAgent.id,
          createdBy: authorAgent.id,
          directive: scheduleParse.directive,
          now
        });
      }
      // DM channels are 1:1 conversations — `dm:<agentId>`. Strip any agent
      // mention that doesn't belong to the DM peer, otherwise users could
      // smuggle other agents into a private chat. Drop a system note so the
      // sender knows their @ was ignored.
      this.filterDmMentions(s, created, now);
      const agentMentions = (created.mentions || []).filter(m => m.kind === "agent");
      const rawHandles = Array.from(String(input.text || "").matchAll(/@([A-Za-z0-9_-]+)/g)).map(m => m[1]);
      if (rawHandles.length > 0) {
        const matched = agentMentions.map(m => `@${m.handle || m.name}`).join(", ") || "(none)";
        console.log(`[core] message ${created.id} on ${created.target}: handles=${rawHandles.map(h => "@" + h).join(",")} matched-agents=${matched}`);
      }
      if (agentMentions.length > 0) {
        // User explicitly addressed specific agents — honour that and never
        // silently fall back to a different agent. Mentioned-but-offline
        // agents get a system reply explaining why nothing happened.
        const queued = this.enqueueMentionDeliveries(s, created, {
          rootMessageId: created.id,
          parentDeliveryId: null,
          depth: 0,
          excludeAgentId: null,
          createdIds,
          sessionKey: normalizeOptionalString(input.sessionKey),
          source: input.source || "message"
        });
        if (queued === 0) {
          const offline = agentMentions
            .map(m => `@${m.handle || slugHandle(m.name)}`)
            .join(", ");
          s.messages.push({
            id: this.newId("msg"),
            spaceId,
            target: created.target,
            authorId: "system",
            type: "system",
            text: `${offline} is not running, message was not delivered.`,
            mentions: [],
            createdAt: now,
            threadId: threadRootFromTarget(created.target)
          });
        }
      } else {
        const explicitDefaultAgentId = normalizeOptionalString(input.defaultAgentId);
        const channelDefaultAgentId = channelDefaultAgentForTarget(s, created.target, spaceId);
        if (explicitDefaultAgentId || channelDefaultAgentId) {
          // No explicit mention — a caller-provided id overrides the channel
          // default, otherwise the channel's configured default agent handles it.
          this.enqueueDefaultAgentDelivery(s, created, explicitDefaultAgentId || channelDefaultAgentId || undefined, createdIds, {
            sessionKey: normalizeOptionalString(input.sessionKey),
            source: input.source || "message"
          });
        }
      }
      return created;
    });
    this.publishDeliveriesById(createdIds);
    this.runtimes.onMessage(message);
    return message;
  }

  applyDeliveryResult(deliveryId: string, input: DeliveryResultInput): Delivery {
    const createdIds: string[] = [];
    const result = this.store.mutate<Delivery>(s => {
      const now = this.clock();
      const delivery = (s.deliveries || []).find(item => item.id === deliveryId);
      if (!delivery) throw new HttpError(404, "delivery not found");
      if (["done", "failed", "cancelled"].includes(delivery.status)) {
        return delivery;
      }
      delivery.status = input.ok ? "done" : "failed";
      delivery.error = input.error || null;
      delivery.updatedAt = now;
      pushDeliveryLifecycle(delivery, "delivery.result", now, input.ok ? "Delivery completed" : "Delivery failed", {
        ok: !!input.ok,
        ...(input.error ? { error: input.error } : {})
      });
      createDeliveryEventRecord(s, {
        newId: this.newId,
        clock: this.clock,
        delivery,
        kind: input.ok ? "completed" : "error",
        title: input.ok ? "Completed" : "Delivery failed",
        text: input.ok ? null : input.error || "unknown error",
        status: input.ok ? "done" : "failed",
        payload: input.ok ? { ok: true } : { ok: false, error: input.error || null },
        createdAt: now
      });
      if (input.ok && input.text) {
        // Agents may prefix their reply with `<thread>` on its own first line to
        // signal that the conversation should move into a thread (see the
        // routing rule in workspace.ts:buildSystemPrompt). Strip the marker and
        // re-anchor the reply onto the delivery's root message — but only when
        // we're not already inside a thread, otherwise the marker is a no-op.
        const { text: textWithoutSchedule, directive } = stripScheduleDirective(input.text);
        const { text: replyText, threaded } = stripThreadMarker(textWithoutSchedule);
        const alreadyInThread = threadRootFromTarget(delivery.target) !== null;
        const useThread = threaded && !alreadyInThread;
        const threadAnchor = delivery.rootMessageId || delivery.messageId;
        const replyTarget = useThread ? `${delivery.target}:${threadAnchor}` : delivery.target;
        const replyThreadId = useThread
          ? threadAnchor
          : (input.threadId || threadRootFromTarget(delivery.target));
        const created: Message = {
          id: this.newId("msg"),
          spaceId: delivery.spaceId,
          target: replyTarget,
          authorId: delivery.agentId,
          type: "agent",
          text: replyText,
          mentions: parseMentions(replyText, s, delivery.spaceId),
          createdAt: now,
          threadId: replyThreadId
        };
        s.messages.push(created);
        // Same DM safeguard as user-sent messages: an agent reply in a DM may
        // not fan out to other agents — only the DM peer is reachable from
        // inside `dm:<peer>`.
        this.filterDmMentions(s, created, now);
        this.linkOutboundForExternalRoot(s, created, delivery.rootMessageId || delivery.messageId, now);
        if (directive) {
          const source = s.messages.find(message => message.id === delivery.messageId);
          if (source && (source.type || "human") === "human" && source.authorId !== "system") {
            this.applyScheduleDirective(s, {
              spaceId: delivery.spaceId,
              target: delivery.target,
              agentId: delivery.agentId,
              createdBy: source.authorId,
              directive,
              now
            });
          }
        }
        this.enqueueMentionDeliveries(s, created, {
          rootMessageId: delivery.rootMessageId || delivery.messageId,
          parentDeliveryId: delivery.id,
          depth: (delivery.depth || 0) + 1,
          excludeAgentId: delivery.agentId,
          createdIds
        });
      } else if (!input.ok) {
        const agent = s.agents.find(agent => agent.id === delivery.agentId);
        const label = agent ? `@${agent.handle || slugHandle(agent.name)}` : delivery.agentId;
        const reason = input.error ? String(input.error).replace(/\s+/g, " ").slice(0, 600) : "unknown error";
        s.messages.push({
          id: this.newId("msg"),
          spaceId: delivery.spaceId,
          target: delivery.target,
          authorId: "system",
          type: "system",
          text: `${label} delivery failed: ${reason}`,
          mentions: [],
          createdAt: now,
          threadId: threadRootFromTarget(delivery.target)
        });
      }
      return delivery;
    });
    this.publishDeliveriesById(createdIds);
    return result;
  }

  applyDeliveryProgress(deliveryId: string, input: DeliveryProgressInput): Message {
    return this.store.mutate<Message>(s => {
      const now = this.clock();
      const delivery = (s.deliveries || []).find(item => item.id === deliveryId);
      if (!delivery) throw new HttpError(404, "delivery not found");
      if (delivery.status !== "delivering") {
        throw new HttpError(409, "delivery is not running");
      }
      const task = (s.tasks || []).find(item =>
        item.threadTarget === delivery.target ||
        item.messageId === delivery.rootMessageId
      );
      if (!task) throw new HttpError(409, "delivery is not attached to a task thread");

      const text = String(input.text || "").trim();
      if (!text) throw new HttpError(400, "progress text is required");
      const message: Message = {
        id: this.newId("msg"),
        spaceId: delivery.spaceId,
        target: task.threadTarget,
        authorId: delivery.agentId,
        type: "agent",
        text: text.slice(0, 1000),
        mentions: [],
        createdAt: now,
        threadId: task.messageId
      };
      s.messages.push(message);
      this.linkOutboundForExternalRoot(s, message, delivery.rootMessageId || delivery.messageId, now);
      delivery.updatedAt = now;
      pushDeliveryLifecycle(delivery, "delivery.progress", now, text.slice(0, 240), {
        ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {})
      });
      createDeliveryEventRecord(s, {
        newId: this.newId,
        clock: this.clock,
        delivery,
        kind: "progress",
        title: "Progress",
        text,
        status: "running",
        payload: input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : null,
        createdAt: now
      });
      if (task.status === "todo") {
        task.status = "in_progress";
        task.updatedAt = now;
      }
      return message;
    });
  }

  applyDeliveryRuntimeState(deliveryId: string, input: DeliveryRuntimeStateInput): Delivery {
    return this.store.mutate<Delivery>(s => {
      const now = this.clock();
      const delivery = (s.deliveries || []).find(item => item.id === deliveryId);
      if (!delivery) throw new HttpError(404, "delivery not found");
      if (delivery.status !== "delivering") {
        throw new HttpError(409, "delivery is not active");
      }
      const phase = input.phase === "running" ? "running" : input.phase === "queued" ? "queued" : null;
      if (!phase) throw new HttpError(400, "phase must be queued or running");
      const queuePosition = Number.isFinite(input.queuePosition)
        ? Math.max(0, Math.floor(Number(input.queuePosition)))
        : undefined;
      const intent = phase === "queued" ? "delivery.queued" : "delivery.running";
      const latestRuntimeState = [...(delivery.lifecycle || [])]
        .reverse()
        .find(item => item.intent === "delivery.queued" || item.intent === "delivery.running");
      if (latestRuntimeState?.intent === "delivery.running" && intent === "delivery.queued") {
        return delivery;
      }
      const processSlot = Number.isFinite(input.processSlot)
        ? Math.floor(Number(input.processSlot))
        : undefined;
      if (
        latestRuntimeState?.intent === intent &&
        latestRuntimeState.details?.sessionKey === input.sessionKey &&
        latestRuntimeState.details?.processSlot === processSlot &&
        (
          intent === "delivery.running" ||
          latestRuntimeState.details?.queuePosition === queuePosition
        )
      ) {
        return delivery;
      }
      delivery.updatedAt = now;
      pushDeliveryLifecycle(
        delivery,
        intent,
        now,
        phase === "queued"
          ? `Queued${queuePosition ? ` (#${queuePosition})` : ""}`
          : "Runtime started",
        {
          phase,
          ...(queuePosition !== undefined ? { queuePosition } : {}),
          ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
          ...(processSlot !== undefined ? { processSlot } : {})
        }
      );
      createDeliveryEventRecord(s, {
        newId: this.newId,
        clock: this.clock,
        delivery,
        kind: phase,
        title: phase === "queued" ? "Queued" : "Runtime started",
        text: phase === "queued" && queuePosition !== undefined ? `Queue position ${queuePosition}` : null,
        status: phase,
        payload: {
          phase,
          ...(queuePosition !== undefined ? { queuePosition } : {}),
          ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
          ...(processSlot !== undefined ? { processSlot } : {})
        },
        createdAt: now
      });
      return delivery;
    });
  }

  applyDeliveryHelpNeeded(deliveryId: string, input: DeliveryHelpNeededInput): Delivery {
    return this.store.mutate<Delivery>(s => {
      const now = this.clock();
      const delivery = (s.deliveries || []).find(item => item.id === deliveryId);
      if (!delivery) throw new HttpError(404, "delivery not found");
      const text = String(input.text || input.reason || "").trim();
      if (!text) throw new HttpError(400, "help-needed text is required");
      delivery.status = "help_needed";
      delivery.error = input.reason || null;
      delivery.updatedAt = now;
      pushDeliveryLifecycle(delivery, "delivery.help_needed", now, text.slice(0, 240), {
        ...(input.reason ? { reason: input.reason } : {})
      });
      const message: Message = {
        id: this.newId("msg"),
        spaceId: delivery.spaceId,
        target: delivery.target,
        authorId: delivery.agentId,
        type: "agent",
        text: `Help needed: ${text.slice(0, 1000)}`,
        mentions: [],
        createdAt: now,
        threadId: threadRootFromTarget(delivery.target)
      };
      s.messages.push(message);
      this.linkOutboundForExternalRoot(s, message, delivery.rootMessageId || delivery.messageId, now);
      return delivery;
    });
  }

  cancelDelivery(deliveryId: string, reason = "cancelled"): Delivery {
    return this.store.mutate<Delivery>(s => {
      const now = this.clock();
      const delivery = (s.deliveries || []).find(item => item.id === deliveryId);
      if (!delivery) throw new HttpError(404, "delivery not found");
      if (["done", "failed", "cancelled"].includes(delivery.status)) {
        throw new HttpError(409, "delivery already reached a terminal state");
      }
      delivery.status = "cancelled";
      delivery.error = reason;
      delivery.updatedAt = now;
      pushDeliveryLifecycle(delivery, "delivery.cancel", now, reason);
      this.publishComputerPush(delivery.computerId, {
        type: "cancel_delivery",
        payload: { deliveryId: delivery.id, agentId: delivery.agentId, reason }
      });
      s.messages.push({
        id: this.newId("msg"),
        spaceId: delivery.spaceId,
        target: delivery.target,
        authorId: "system",
        type: "system",
        text: `Delivery ${delivery.id} cancelled: ${reason}`,
        mentions: [],
        createdAt: now,
        threadId: threadRootFromTarget(delivery.target)
      });
      return delivery;
    });
  }

  // ---------------------------------------------------------------------------
  // tasks

  createTask(input: TaskCreateInput): Task {
    if (!input.target || !input.title) throw new HttpError(400, "target and title are required");
    const spaceId = this.resolveSpaceId(input.spaceId);
    const task = this.store.mutate<Task>(s => {
      const now = this.clock();
      const messageId = this.newId("msg");
      const taskNumber = nextTaskNumber(s, input.target, spaceId);
      const created: Task = {
        id: this.newId("task"),
        spaceId,
        number: taskNumber,
        target: input.target,
        title: input.title,
        description: input.description || "",
        status: input.status || "todo",
        assigneeId: input.assigneeId || null,
        createdBy: input.createdBy || "human-local",
        messageId,
        threadTarget: `${input.target}:${messageId}`,
        createdAt: now,
        updatedAt: now
      };
      s.tasks.push(created);
      const message: Message = {
        id: messageId,
        spaceId,
        target: input.target,
        authorId: created.createdBy,
        type: "task",
        text: created.title,
        taskId: created.id,
        mentions: [],
        createdAt: created.createdAt,
        threadId: null
      };
      s.messages.push(message);
      if (created.assigneeId) {
        this.enqueueSingleAgentDelivery(s, message, created.assigneeId, {
          target: created.threadTarget,
          rootMessageId: message.id,
          depth: 0,
          sessionKey: created.threadTarget,
          source: "task"
        });
      }
      return created;
    });
    this.runtimes.onTask(task);
    return task;
  }

  patchTask(taskId: string, input: TaskPatchInput): Task {
    return this.store.mutate<Task>(s => {
      const now = this.clock();
      const current = s.tasks.find(t => t.id === taskId);
      if (!current) throw new HttpError(404, "task not found");
      const previousStatus = current.status;
      Object.assign(current, {
        status: input.status ?? current.status,
        assigneeId: input.assigneeId ?? current.assigneeId,
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        updatedAt: now
      });
      const taskMessage = s.messages.find(message => message.id === current.messageId);
      if (taskMessage) taskMessage.text = current.title;
      if (input.status && input.status !== previousStatus) {
        s.messages.push({
          id: this.newId("msg"),
          spaceId: current.spaceId,
          target: current.threadTarget,
          authorId: "system",
          type: "system",
          text: `Task #${current.number || current.id} moved to ${current.status}`,
          mentions: [],
          createdAt: now,
          threadId: current.messageId
        });
      }
      return current;
    });
  }

  // ---------------------------------------------------------------------------
  // scheduled tasks

  createScheduledTask(input: ScheduledTaskCreateInput): ScheduledTask {
    if (!input.target || !input.agentId || !input.prompt) {
      throw new HttpError(400, "target, agentId and prompt are required");
    }
    const spaceId = this.resolveSpaceId(input.spaceId);
    const created = this.store.mutate<ScheduledTask>(s => {
      const now = this.clock();
      const agent = s.agents.find(a => a.id === input.agentId && a.spaceId === spaceId);
      if (!agent) throw new HttpError(404, "agent not found");
      const id = this.newId("sched");
      const schedule = parseSchedule({
        intervalMs: input.intervalMs,
        cronExpression: input.cronExpression,
        timezone: input.timezone,
        nextRunAt: input.nextRunAt,
        now
      });
      const task: ScheduledTask = {
        id,
        spaceId,
        target: input.target,
        agentId: input.agentId,
        prompt: input.prompt,
        sessionKey: normalizeOptionalString(input.sessionKey) || id,
        intervalMs: schedule.intervalMs,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        status: "active",
        nextRunAt: schedule.nextRunAt,
        lastRunAt: null,
        lastMessageId: null,
        runCount: 0,
        createdBy: input.createdBy || "human-local",
        createdAt: now,
        updatedAt: now
      };
      s.scheduledTasks ||= [];
      s.scheduledTasks.push(task);
      return task;
    });
    return created;
  }

  patchScheduledTask(taskId: string, input: ScheduledTaskPatchInput): ScheduledTask {
    return this.store.mutate<ScheduledTask>(s => {
      const now = this.clock();
      const current = (s.scheduledTasks || []).find(task => task.id === taskId);
      if (!current) throw new HttpError(404, "scheduled task not found");
      if (input.agentId && !s.agents.some(agent => agent.id === input.agentId)) {
        throw new HttpError(404, "agent not found");
      }
      if (input.status && !["active", "paused"].includes(input.status)) {
        throw new HttpError(400, "status must be active or paused");
      }
      if (input.nextRunAt && !Number.isFinite(Date.parse(input.nextRunAt))) {
        throw new HttpError(400, "nextRunAt must be an ISO timestamp");
      }
      const scheduleChanged =
        input.intervalMs !== undefined ||
        input.cronExpression !== undefined ||
        input.timezone !== undefined;
      const resumingCron =
        input.status === "active" &&
        current.status !== "active" &&
        !!(input.cronExpression ?? current.cronExpression);
      if (scheduleChanged || resumingCron) {
        const switchingToInterval = input.intervalMs !== undefined;
        const switchingToCron = input.cronExpression !== undefined && !!input.cronExpression;
        const schedule = parseSchedule({
          intervalMs: switchingToCron ? undefined : input.intervalMs ?? current.intervalMs ?? undefined,
          cronExpression: switchingToInterval ? undefined : input.cronExpression ?? current.cronExpression ?? undefined,
          timezone: input.timezone ?? current.timezone ?? undefined,
          nextRunAt: input.nextRunAt,
          now
        });
        current.intervalMs = schedule.intervalMs;
        current.cronExpression = schedule.cronExpression;
        current.timezone = schedule.timezone;
        current.nextRunAt = schedule.nextRunAt;
      } else if (input.nextRunAt) {
        current.nextRunAt = input.nextRunAt;
      }
      current.target = input.target ?? current.target;
      current.agentId = input.agentId ?? current.agentId;
      current.prompt = input.prompt ?? current.prompt;
      if (input.sessionKey !== undefined) current.sessionKey = normalizeOptionalString(input.sessionKey);
      current.status = input.status ?? current.status;
      current.updatedAt = now;
      return current;
    });
  }

  deleteScheduledTask(taskId: string): void {
    this.store.mutate(s => {
      const before = (s.scheduledTasks || []).length;
      s.scheduledTasks = (s.scheduledTasks || []).filter(task => task.id !== taskId);
      if (s.scheduledTasks.length === before) throw new HttpError(404, "scheduled task not found");
    });
  }

  private applyScheduleDirective(
    state: State,
    input: { spaceId: string; target: string; agentId: string; createdBy: string; directive: ScheduleDirective; now: string }
  ): void {
    const { spaceId, target, agentId, createdBy, directive, now } = input;
    if (!directive.create) return;
    const agent = state.agents.find(a => a.id === agentId && a.spaceId === spaceId);
    if (!agent) return;
    try {
      const schedule = parseSchedule({
        intervalMs: directive.intervalMs,
        cronExpression: directive.cronExpression,
        timezone: directive.timezone,
        nextRunAt: directive.nextRunAt,
        now
      });
      const prompt = String(directive.prompt || "").trim();
      if (!prompt) throw new Error("prompt is required");
      const scheduled: ScheduledTask = {
        id: this.newId("sched"),
        spaceId,
        target,
        agentId: agent.id,
        prompt,
        sessionKey: null,
        intervalMs: schedule.intervalMs,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        status: "active",
        nextRunAt: schedule.nextRunAt,
        lastRunAt: null,
        lastMessageId: null,
        runCount: 0,
        createdBy,
        createdAt: now,
        updatedAt: now
      };
      scheduled.sessionKey = scheduled.id;
      state.scheduledTasks ||= [];
      state.scheduledTasks.push(scheduled);
      state.messages.push({
        id: this.newId("msg"),
        spaceId,
        target,
        authorId: "system",
        type: "system",
        text: `Scheduled task created for @${agent.handle || slugHandle(agent.name)}: ${formatSchedule(scheduled)}. Next run at ${scheduled.nextRunAt}.`,
        mentions: [],
        createdAt: now,
        threadId: threadRootFromTarget(target)
      });
    } catch (error) {
      state.messages.push({
        id: this.newId("msg"),
        spaceId,
        target,
        authorId: "system",
        type: "system",
        text: `Schedule directive ignored: ${(error as Error).message}`,
        mentions: [],
        createdAt: now,
        threadId: threadRootFromTarget(target)
      });
    }
  }

  runDueScheduledTasks(): number {
    const createdIds: string[] = [];
    const now = this.clock();
    const nowMs = Date.parse(now);
    const dueIds = (this.store.snapshot().scheduledTasks || [])
      .filter(task => task.status === "active")
      .filter(task => {
        const dueAt = Date.parse(task.nextRunAt || "");
        return Number.isFinite(dueAt) && dueAt <= nowMs;
      })
      .map(task => task.id);
    if (dueIds.length === 0) return 0;

    const dueCount = this.store.mutate<number>(s => {
      let ran = 0;
      for (const task of s.scheduledTasks || []) {
        if (!dueIds.includes(task.id) || task.status !== "active") continue;
        const agent = s.agents.find(a => a.id === task.agentId);
        if (!agent) {
          task.status = "paused";
          task.updatedAt = now;
          continue;
        }
        const handle = agent.handle || slugHandle(agent.name);
        const threadId = threadRootFromTarget(task.target);
        const message: Message = {
          id: this.newId("msg"),
          spaceId: task.spaceId,
          target: task.target,
          authorId: "system",
          type: "system",
          text: `@${handle} ${task.prompt}`,
          mentions: [{ id: agent.id, kind: "agent", name: agent.name, handle }],
          createdAt: now,
          threadId
        };
        s.messages.push(message);
        const queued = this.enqueueSingleAgentDelivery(s, message, agent.id, {
          rootMessageId: message.id,
          depth: 0,
          createdIds,
          sessionKey: task.sessionKey || task.id,
          source: "scheduled"
        });
        if (queued === 0) {
          s.messages.push({
            id: this.newId("msg"),
            spaceId: task.spaceId,
            target: task.target,
            authorId: "system",
            type: "system",
            text: `@${handle} is not running, scheduled task was not delivered.`,
            mentions: [],
            createdAt: now,
            threadId
          });
        }
        task.lastRunAt = now;
        task.lastMessageId = message.id;
        task.runCount = (task.runCount || 0) + 1;
        task.nextRunAt = task.cronExpression
          ? nextCronRun(task.cronExpression, task.timezone || defaultTimezone(), now)
          : new Date(nowMs + parseScheduleInterval(task.intervalMs)).toISOString();
        task.updatedAt = now;
        ran += 1;
      }
      return ran;
    });
    this.publishDeliveriesById(createdIds);
    return dueCount;
  }

  // ---------------------------------------------------------------------------
  // external ingress pairing / policy

  createIngressPairing(input: IngressPairingCreateInput): ExternalIngressPairing & { connectUrl: string } {
    if (!input.target || !input.agentId) throw new HttpError(400, "target and agentId are required");
    const spaceId = this.resolveSpaceId(input.spaceId);
    return this.store.mutate(s => {
      const now = this.clock();
      const agent = s.agents.find(a => a.id === input.agentId && a.spaceId === spaceId);
      if (!agent) throw new HttpError(404, "agent not found");
      if (!s.channels.some(channel => channel.spaceId === spaceId && channel.target === input.target)) {
        throw new HttpError(404, "target channel not found");
      }
      const ttl = Number.isFinite(input.expiresInMs) && Number(input.expiresInMs) > 0
        ? Math.min(Number(input.expiresInMs), 24 * 60 * 60 * 1000)
        : DEFAULT_INGRESS_PAIRING_TTL_MS;
      const pairCode = this.newId("pair");
      const created: ExternalIngressPairing = {
        id: this.newId("ingress_pair"),
        spaceId,
        pairCode,
        target: input.target,
        agentId: agent.id,
        ...(input.label ? { label: input.label } : {}),
        contextRules: normalizeContextRules(input.contextRules),
        status: "waiting",
        expiresAt: new Date(Date.parse(now) + ttl).toISOString(),
        createdAt: now,
        consumedAt: null,
        policyId: null
      };
      s.externalIngressPairings ||= [];
      s.externalIngressPairings.push(created);
      return {
        ...created,
        connectUrl: `iteam://ingress/pair?pair_code=${encodeURIComponent(pairCode)}`
      };
    });
  }

  pairIngress(input: IngressPairInput): ExternalIngressPolicy {
    const pairCode = String(input.pairCode || "").trim();
    if (!pairCode) throw new HttpError(400, "pairCode is required");
    return this.store.mutate<ExternalIngressPolicy>(s => {
      const now = this.clock();
      const pairing = (s.externalIngressPairings || []).find(item => item.pairCode === pairCode);
      if (!pairing) throw new HttpError(404, "pairing code not found");
      if (pairing.status !== "waiting") throw new HttpError(409, "pairing code already consumed");
      if (Date.parse(pairing.expiresAt) <= Date.parse(now)) {
        pairing.status = "expired";
        throw new HttpError(410, "pairing code expired");
      }
      const policy: ExternalIngressPolicy = {
        id: this.newId("ingress_policy"),
        spaceId: pairing.spaceId,
        token: this.newId("ingress_token"),
        source: String(input.source || pairing.label || "external").trim() || "external",
        target: pairing.target,
        agentId: pairing.agentId,
        contextRules: normalizeContextRules(input.contextRules) || pairing.contextRules,
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      s.externalIngressPolicies ||= [];
      s.externalIngressPolicies.push(policy);
      pairing.status = "consumed";
      pairing.consumedAt = now;
      pairing.policyId = policy.id;
      return policy;
    });
  }

  createIngressMessage(input: IngressMessageInput): Message {
    const text = String(input.text || "").trim();
    if (!text) throw new HttpError(400, "text is required");
    const createdIds: string[] = [];
    const message = this.store.mutate<Message>(s => {
      const now = this.clock();
      const policy = authenticateIngressPolicy(s, input);
      const target = input.target || policy.target;
      const agentId = input.agentId || policy.agentId;
      if (target !== policy.target) throw new HttpError(403, "target is not allowed by ingress policy");
      if (agentId !== policy.agentId) throw new HttpError(403, "agent is not allowed by ingress policy");
      if (!contextRulesMatch(policy.contextRules, input.context || {})) {
        throw new HttpError(403, "context does not match ingress policy");
      }
      const agent = s.agents.find(a => a.id === agentId);
      if (!agent) throw new HttpError(404, "agent not found");
      const source = String(input.source || policy.source || "external").trim() || "external";
      const created: Message = {
        id: this.newId("msg"),
        spaceId: policy.spaceId,
        target,
        authorId: `ingress:${source}`,
        type: "human",
        text,
        mentions: [{ id: agent.id, kind: "agent", name: agent.name, handle: agent.handle || slugHandle(agent.name) }],
        createdAt: now,
        threadId: threadRootFromTarget(target)
      };
      s.messages.push(created);
      this.enqueueSingleAgentDelivery(s, created, agent.id, {
        rootMessageId: created.id,
        parentDeliveryId: null,
        depth: 0,
        createdIds,
        sessionKey: normalizeOptionalString(input.sessionKey) || policy.id,
        source: "external"
      });
      return created;
    });
    this.publishDeliveriesById(createdIds);
    return message;
  }

  upsertExternalBotConfig(input: ExternalBotConfigUpsertInput): ExternalBotConfig {
    const provider = providerKeyForExternalBotConfig(input.provider || "lark", input.appId);
    const appId = String(input.appId || "").trim();
    if (!provider) throw new HttpError(400, "provider is required");
    if (!appId) throw new HttpError(400, "appId is required");
    const spaceId = this.resolveSpaceId(input.spaceId);
    return this.store.mutate<ExternalBotConfig>(s => {
      const now = this.clock();
      s.externalBotConfigs ||= [];
      let config = s.externalBotConfigs.find(item =>
        item.provider === provider && item.spaceId === spaceId
      );
      if (!config) {
        config = {
          spaceId,
          provider,
          alias: normalizeOptionalString(input.alias),
          appId,
          appSecret: normalizeOptionalString(input.appSecret),
          domain: normalizeOptionalString(input.domain),
          enabled: input.enabled !== false,
          status: initialExternalBotStatus(input.provider || "lark", appId, input.enabled !== false),
          statusMessage: null,
          lastConnectedAt: null,
          createdAt: now,
          updatedAt: now
        };
        s.externalBotConfigs.push(config);
      } else {
        const appChanged = config.appId !== appId;
        config.appId = appId;
        if (input.alias !== undefined) config.alias = normalizeOptionalString(input.alias);
        if (input.appSecret !== undefined) config.appSecret = normalizeOptionalString(input.appSecret);
        config.domain = normalizeOptionalString(input.domain);
        if (input.enabled !== undefined) config.enabled = !!input.enabled;
        if (appChanged || input.appSecret !== undefined || input.enabled !== undefined) {
          config.status = initialExternalBotStatus(input.provider || provider, appId, config.enabled);
          config.statusMessage = null;
          config.lastConnectedAt = null;
        }
        config.updatedAt = now;
      }
      return config;
    });
  }

  updateExternalBotStatus(provider: string, status: string, message?: string | null, spaceId?: string | null): ExternalBotConfig | null {
    const normalized = normalizeProvider(provider);
    if (!normalized) return null;
    const resolved = this.resolveSpaceId(spaceId);
    return this.store.mutate<ExternalBotConfig | null>(s => {
      const config = (s.externalBotConfigs || []).find(item =>
        item.provider === normalized && item.spaceId === resolved
      );
      if (!config) return null;
      const now = this.clock();
      config.status = status;
      config.statusMessage = normalizeOptionalString(message);
      if (status === "connected") config.lastConnectedAt = now;
      config.updatedAt = now;
      return config;
    });
  }

  deleteExternalBotConfig(provider: string, spaceId?: string | null): { ok: true; provider: string; spaceId: string; deletedBindings: number; deletedMessageLinks: number } {
    const normalized = normalizeProvider(provider);
    if (!normalized) throw new HttpError(400, "provider is required");
    const resolved = this.resolveSpaceId(spaceId);
    return this.store.mutate(s => {
      const beforeConfigs = s.externalBotConfigs || [];
      if (!beforeConfigs.some(config => config.provider === normalized && config.spaceId === resolved)) {
        throw new HttpError(404, "bot config not found");
      }
      const beforeBindings = s.externalBotBindings || [];
      const beforeLinks = s.externalMessageLinks || [];
      s.externalBotConfigs = beforeConfigs.filter(config =>
        !(config.provider === normalized && config.spaceId === resolved)
      );
      s.externalBotBindings = beforeBindings.filter(binding =>
        !(binding.provider === normalized && binding.spaceId === resolved)
      );
      s.externalMessageLinks = beforeLinks.filter(link =>
        !(link.provider === normalized && link.spaceId === resolved)
      );
      return {
        ok: true,
        provider: normalized,
        spaceId: resolved,
        deletedBindings: beforeBindings.length - s.externalBotBindings.length,
        deletedMessageLinks: beforeLinks.length - s.externalMessageLinks.length
      };
    });
  }

  upsertExternalBotBinding(input: ExternalBindingUpsertInput): ExternalBotBinding {
    const provider = normalizeProvider(input.provider);
    const tenantKey = String(input.tenantKey || "").trim();
    const chatId = String(input.chatId || "").trim();
    if (!provider || !tenantKey || !chatId) throw new HttpError(400, "provider, tenantKey and chatId are required");
    const spaceId = this.resolveSpaceId(input.spaceId);
    return this.store.mutate<ExternalBotBinding>(s => {
      const now = this.clock();
      const target = normalizeTarget(input.defaultTarget);
      const agentId = normalizeOptionalString(input.defaultAgentId);
      if (target && !findChannel(s, target, spaceId)) throw new HttpError(404, "target channel not found");
      if (agentId && !s.agents.some(agent => agent.id === agentId && agent.spaceId === spaceId)) {
        throw new HttpError(404, "agent not found");
      }
      s.externalBotBindings ||= [];
      let binding = s.externalBotBindings.find(item =>
        item.spaceId === spaceId &&
        item.provider === provider &&
        item.tenantKey === tenantKey &&
        item.chatId === chatId
      );
      if (!binding) {
        binding = {
          id: this.newId("ext_bind"),
          spaceId,
          provider,
          tenantKey,
          chatId,
          chatType: normalizeOptionalString(input.chatType),
          defaultTarget: target,
          defaultAgentId: agentId,
          status: "active",
          createdAt: now,
          updatedAt: now
        };
        s.externalBotBindings.push(binding);
      } else {
        binding.chatType = normalizeOptionalString(input.chatType) || binding.chatType || null;
        binding.defaultTarget = target;
        binding.defaultAgentId = agentId;
        binding.status = "active";
        binding.updatedAt = now;
      }
      return binding;
    });
  }

  createExternalRoutedMessage(input: ExternalRoutedMessageInput): ExternalRoutedMessageResult {
    const provider = normalizeProvider(input.provider);
    const tenantKey = String(input.tenantKey || "").trim();
    const chatId = String(input.chatId || "").trim();
    const text = String(input.text || "").trim();
    if (!provider || !tenantKey || !chatId) throw new HttpError(400, "provider, tenantKey and chatId are required");
    if (!text) throw new HttpError(400, "text is required");
    const spaceId = this.resolveSpaceId(input.spaceId);
    const conversationId = externalConversationId(provider, tenantKey, chatId);
    const createdIds: string[] = [];
    const result = this.store.mutate<ExternalRoutedMessageResult>(s => {
      const now = this.clock();
      const externalMessageId = normalizeOptionalString(input.externalMessageId);
      if (externalMessageId && (s.externalMessageLinks || []).some(link =>
        link.spaceId === spaceId &&
        link.provider === provider &&
        link.externalConversationId === conversationId &&
        link.externalMessageId === externalMessageId &&
        link.direction === "in"
      )) {
        return { ok: true, replyText: "duplicate message ignored" };
      }
      const binding = (s.externalBotBindings || []).find(item =>
        item.spaceId === spaceId &&
        item.provider === provider &&
        item.tenantKey === tenantKey &&
        item.chatId === chatId &&
        item.status === "active"
      ) || null;
      const target = normalizeTarget(input.target) || binding?.defaultTarget || null;
      const mentionedAgents = parseMentions(text, s, spaceId).filter(mention => mention.kind === "agent");
      let routeTarget = target;
      let defaultAgentId = normalizeOptionalString(input.defaultAgentId) || binding?.defaultAgentId || null;

      if (!routeTarget) {
        if (defaultAgentId) {
          // Caller passed an explicit agent (e.g. `handle:` prefix). Route
          // into the agent's DM channel so we don't need a channel binding.
          routeTarget = this.ensureAgentDmChannelInState(s, defaultAgentId, now).target;
        } else if (mentionedAgents.length === 1) {
          routeTarget = this.ensureAgentDmChannelInState(s, mentionedAgents[0].id, now).target;
        } else {
          return {
            ok: false,
            binding,
            replyText: mentionedAgents.length > 1
              ? "请指定 iTeam 频道（例如 `/all ...`）或先执行 `/iteam bind #all`。"
              : "请先绑定 iTeam 频道（`/iteam bind #all`），或用 `/all ...` 显式指定频道，或用 `codex: ...` 直接指定 agent。"
          };
        }
      }

      if (routeTarget.startsWith("dm:")) {
        defaultAgentId ||= routeTarget.slice(3);
      } else {
        const channel = findChannel(s, routeTarget, spaceId);
        if (!channel) return { ok: false, binding, replyText: `iTeam channel not found: ${routeTarget}` };
        // If no explicit agent yet, fall back to the channel's default agent
        // (settable via PATCH /api/channels/:id). This is the "接线员" that
        // fields untagged messages in a channel-wide bind.
        defaultAgentId ||= channel.defaultAgentId ?? null;
      }

      const createdBy = `ingress:${provider}`;
      const assigneeId = defaultAgentId || (mentionedAgents.length === 1 ? mentionedAgents[0].id : null);
      if (input.asTask) {
        const messageId = this.newId("msg");
        const task: Task = {
          id: this.newId("task"),
          spaceId,
          number: nextTaskNumber(s, routeTarget, spaceId),
          target: routeTarget,
          title: text,
          description: "",
          status: "todo",
          assigneeId,
          createdBy,
          messageId,
          threadTarget: `${routeTarget}:${messageId}`,
          createdAt: now,
          updatedAt: now
        };
        s.tasks.push(task);
        const created: Message = {
          id: messageId,
          spaceId,
          target: routeTarget,
          authorId: createdBy,
          type: "task",
          text: task.title,
          taskId: task.id,
          mentions: [],
          createdAt: now,
          threadId: null
        };
        s.messages.push(created);
        if (task.assigneeId) {
          this.enqueueSingleAgentDelivery(s, created, task.assigneeId, {
            target: task.threadTarget,
            rootMessageId: created.id,
            depth: 0,
            createdIds,
            sessionKey: normalizeOptionalString(input.sessionKey) || `${conversationId}:${routeTarget}:task:${task.id}`,
            source: provider
          });
        }
        s.externalMessageLinks ||= [];
        s.externalMessageLinks.push({
          id: this.newId("ext_msg"),
          spaceId,
          provider,
          externalConversationId: conversationId,
          externalMessageId,
          messageId: created.id,
          rootMessageId: created.id,
          direction: "in",
          createdAt: now
        });
        return { ok: true, message: created, task, binding };
      }

      const created: Message = {
        id: this.newId("msg"),
        spaceId,
        target: routeTarget,
        authorId: createdBy,
        type: "human",
        text,
        mentions: parseMentions(text, s, spaceId),
        createdAt: now,
        threadId: threadRootFromTarget(routeTarget)
      };
      s.messages.push(created);
      this.filterDmMentions(s, created, now);
      const finalMentions = (created.mentions || []).filter(mention => mention.kind === "agent");
      if (finalMentions.length > 0) {
        this.enqueueMentionDeliveries(s, created, {
          rootMessageId: created.id,
          parentDeliveryId: null,
          depth: 0,
          excludeAgentId: null,
          createdIds,
          sessionKey: normalizeOptionalString(input.sessionKey) || `${conversationId}:${routeTarget}`,
          source: provider
        });
      } else if (defaultAgentId || !routeTarget.startsWith("dm:")) {
        this.enqueueDefaultAgentDelivery(s, created, defaultAgentId || undefined, createdIds, {
          sessionKey: normalizeOptionalString(input.sessionKey) || `${conversationId}:${routeTarget}`,
          source: provider
        });
      }
      s.externalMessageLinks ||= [];
      s.externalMessageLinks.push({
        id: this.newId("ext_msg"),
        spaceId,
        provider,
        externalConversationId: conversationId,
        externalMessageId,
        messageId: created.id,
        rootMessageId: created.id,
        direction: "in",
        createdAt: now
      });
      return { ok: true, message: created, binding };
    });
    this.publishDeliveriesById(createdIds);
    if (result.task) this.runtimes.onTask(result.task);
    return result;
  }

  markExternalMessageLinkSent(linkId: string, externalMessageId: string): ExternalMessageLink {
    return this.store.mutate<ExternalMessageLink>(s => {
      const link = (s.externalMessageLinks || []).find(item => item.id === linkId);
      if (!link) throw new HttpError(404, "external message link not found");
      link.externalMessageId = externalMessageId;
      return link;
    });
  }

  backfillExternalMessageLinks(rootMessageId: string): { ok: true; rootMessageId: string; created: number } {
    const rootId = String(rootMessageId || "").trim();
    if (!rootId) throw new HttpError(400, "rootMessageId is required");
    return this.store.mutate(s => {
      const inbound = (s.externalMessageLinks || []).find(link =>
        link.direction === "in" &&
        (link.rootMessageId === rootId || link.messageId === rootId)
      );
      if (!inbound) throw new HttpError(404, "external inbound root not found");
      const before = (s.externalMessageLinks || []).length;
      const root = inbound.rootMessageId || inbound.messageId;
      const messages = (s.messages || []).filter(message =>
        message.type === "agent" &&
        message.threadId === root
      );
      const now = this.clock();
      for (const message of messages) {
        this.linkOutboundForExternalRoot(s, message, root, now);
      }
      return {
        ok: true,
        rootMessageId: root,
        created: (s.externalMessageLinks || []).length - before
      };
    });
  }

  // ---------------------------------------------------------------------------
  // private: delivery enqueueing

  /**
   * Strip non-peer agent mentions from a freshly-created message in a DM
   * channel. DMs are 1:1 conversations (`dm:<peerAgentId>`); any `@other`
   * the author wrote (intentionally or by reply-quoting) must not fan out
   * into another agent's inbox. Drops a system note in the DM so the author
   * sees that the mention was ignored.
   */
  private filterDmMentions(s: State, created: Message, now: string): void {
    const dmChannel = (s.channels || []).find(c => c.target === created.target && c.kind === "dm");
    const dmAgentId = dmChannel?.target?.startsWith("dm:") ? dmChannel.target.slice(3) : null;
    if (!dmAgentId) return;
    const before = (created.mentions || []).filter(m => m.kind === "agent");
    const filtered = (created.mentions || []).filter(m => m.kind !== "agent" || m.id === dmAgentId);
    const dropped = before.filter(m => m.id !== dmAgentId);
    created.mentions = filtered;
    if (dropped.length === 0) return;
    const labels = dropped.map(m => `@${m.handle || slugHandle(m.name)}`).join(", ");
    s.messages.push({
      id: this.newId("msg"),
      spaceId: created.spaceId,
      target: created.target,
      authorId: "system",
      type: "system",
      text: `${labels} ignored: this is a direct message; only the DM peer can be addressed here.`,
      mentions: [],
      createdAt: now,
      threadId: threadRootFromTarget(created.target)
    });
  }

  private ensureAgentDmChannelInState(s: State, agentId: string, now: string) {
    const agent = s.agents.find(a => a.id === agentId);
    if (!agent) throw new HttpError(404, "agent not found");
    const target = `dm:${agent.id}`;
    const existing = s.channels.find(channel => channel.kind === "dm" && channel.target === target);
    if (existing) {
      existing.name = agent.name;
      existing.description = `Direct message with ${agent.name}`;
      existing.memberIds = uniqueIds(["human-local", agent.id]);
      return existing;
    }
    const created = {
      id: this.newId("dm"),
      spaceId: agent.spaceId,
      name: agent.name,
      target,
      kind: "dm",
      description: `Direct message with ${agent.name}`,
      memberIds: uniqueIds(["human-local", agent.id]),
      createdAt: now
    };
    s.channels.push(created);
    return created;
  }

  private linkOutboundForExternalRoot(s: State, message: Message, rootMessageId: string, now: string): void {
    const inbound = (s.externalMessageLinks || []).find(link =>
      link.direction === "in" &&
      (link.rootMessageId === rootMessageId || link.messageId === rootMessageId)
    );
    if (!inbound) return;
    s.externalMessageLinks ||= [];
    if (s.externalMessageLinks.some(link => link.direction === "out" && link.messageId === message.id)) return;
    s.externalMessageLinks.push({
      id: this.newId("ext_msg"),
      spaceId: message.spaceId,
      provider: inbound.provider,
      externalConversationId: inbound.externalConversationId,
      externalMessageId: null,
      messageId: message.id,
      rootMessageId: inbound.rootMessageId || inbound.messageId,
      direction: "out",
      createdAt: now
    });
  }

  private enqueueMentionDeliveries(
    state: State,
    message: Message,
    options: {
      rootMessageId?: string;
      parentDeliveryId?: string | null;
      depth?: number;
      excludeAgentId?: string | null;
      createdIds?: string[];
      sessionKey?: string | null;
      source?: string | null;
    } = {}
  ): number {
    const depth = options.depth || 0;
    if (depth > MAX_DELIVERY_DEPTH) return 0;
    let queued = 0;

    for (const mention of (message.mentions || []).filter(m => m.kind === "agent")) {
      if (mention.id === options.excludeAgentId) continue;

      const agent = state.agents.find(a => a.id === mention.id);
      if (!agent) {
        console.warn(`[core] mention @${mention.handle || mention.name} on msg ${message.id}: agent ${mention.id} not found`);
        continue;
      }
      if (agent.desiredStatus !== "running") {
        console.warn(
          `[core] mention @${agent.handle || agent.name} on msg ${message.id}: ` +
          `skipped (desiredStatus=${agent.desiredStatus}, status=${agent.status})`
        );
        continue;
      }

      state.deliveries ||= [];
      const alreadyQueued = state.deliveries.some(delivery =>
        delivery.messageId === message.id &&
        delivery.agentId === agent.id &&
        ["pending", "delivering", "done"].includes(delivery.status)
      );
      if (alreadyQueued) continue;

      this.enqueueSingleAgentDelivery(state, message, agent.id, {
        rootMessageId: options.rootMessageId || message.id,
        parentDeliveryId: options.parentDeliveryId || null,
        depth,
        createdIds: options.createdIds,
        sessionKey: options.sessionKey,
        source: options.source || "message"
      });
      queued += 1;
    }
    return queued;
  }

  private enqueueDefaultAgentDelivery(
    state: State,
    message: Message,
    defaultAgentId?: string,
    createdIds?: string[],
    options: { sessionKey?: string | null; source?: string | null } = {}
  ): number {
    const channel = findChannelForMessageTarget(state, message.target, message.spaceId);
    const channelMemberIds = new Set<string>(channel?.memberIds || []);
    // Priority: caller-supplied agent > channel default agent > first running
    // member. Callers that want only a channel default must check for it before
    // invoking this helper; some external routes still intentionally use the
    // first running member fallback for channel-wide bindings.
    const preferredId = defaultAgentId || channel?.defaultAgentId || null;
    const preferredAgent = preferredId ? state.agents.find(a => a.id === preferredId) : null;
    const fallbackAgent = state.agents.find(a =>
      a.desiredStatus === "running" &&
      (!channelMemberIds.size || channelMemberIds.has(a.id))
    );
    const agent = preferredAgent?.desiredStatus === "running" ? preferredAgent : fallbackAgent;
    if (!agent) return 0;

    return this.enqueueSingleAgentDelivery(state, message, agent.id, {
      rootMessageId: message.id,
      parentDeliveryId: null,
      depth: 0,
      createdIds,
      sessionKey: options.sessionKey,
      source: options.source || "message"
    });
  }

  private enqueueSingleAgentDelivery(
    state: State,
    message: Message,
    agentId: string,
    options: {
      target?: string;
      rootMessageId?: string;
      parentDeliveryId?: string | null;
      depth?: number;
      createdIds?: string[];
      sessionKey?: string | null;
      source?: string | null;
    } = {}
  ): number {
    const agent = state.agents.find(a => a.id === agentId);
    if (!agent || agent.desiredStatus !== "running") return 0;
    if (agent.spaceId && agent.spaceId !== message.spaceId) return 0;
    state.deliveries ||= [];
    const now = this.clock();
    const id = this.newId("delivery");
    const target = options.target || message.target;
    const sessionKey = options.sessionKey ?? sessionKeyFromMessage(target, message.id);
    state.deliveries.push({
      id,
      spaceId: message.spaceId,
      messageId: message.id,
      rootMessageId: options.rootMessageId || message.id,
      parentDeliveryId: options.parentDeliveryId || null,
      depth: options.depth || 0,
      agentId: agent.id,
      computerId: agent.computerId,
      target,
      sessionKey,
      source: options.source || "message",
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      lifecycle: [deliveryLifecycleRecord("delivery.dispatch", now, "Delivery queued")]
    });
    const delivery = state.deliveries[state.deliveries.length - 1];
    createDeliveryEventRecord(state, {
      newId: this.newId,
      clock: this.clock,
      delivery,
      kind: "queued",
      title: "Delivery queued",
      status: "pending",
      payload: { source: options.source || "message" },
      createdAt: now
    });
    if (options.createdIds) options.createdIds.push(id);
    return 1;
  }

  /**
   * Builds DeliveryWithContext payloads for each id and pushes them to the
   * owning computer's listeners. Called after a mutate() commits so listeners
   * always see consistent state.
   *
   * To prevent duplicate dispatch (SSE push + heartbeat both seeing the same
   * pending delivery), we atomically flip pending→delivering when a listener
   * is attached. Without a listener we leave the delivery pending so the next
   * heartbeat picks it up.
   */
  private publishDeliveriesById(ids: string[]): void {
    if (ids.length === 0) return;
    const now = this.clock();
    const enrichedList = this.store.mutate<DeliveryWithContext[]>(s => {
      const out: DeliveryWithContext[] = [];
      for (const id of ids) {
        const delivery = (s.deliveries || []).find(d => d.id === id);
        if (!delivery) continue;
        const hasListener = this.hasComputerPushListener(delivery.computerId);
        if (hasListener && delivery.status === "pending") {
          delivery.status = "delivering";
          delivery.updatedAt = now;
          pushDeliveryLifecycle(delivery, "delivery.ack", now, "Delivery pushed to connected computer");
        }
        const message = s.messages.find(m => m.id === delivery.messageId);
        const author = findMember(s, message?.authorId);
        out.push({
          ...delivery,
          agent: s.agents.find(agent => agent.id === delivery.agentId),
          message,
          author,
          contextMessages: buildConversationContext(s, message),
          activeDeliveries: buildActiveDeliveryContext(s, delivery),
          members: listMembers(s),
          _hasListener: hasListener
        } as DeliveryWithContext & { _hasListener: boolean });
      }
      return out;
    });
    for (const enriched of enrichedList) {
      const meta = enriched as DeliveryWithContext & { _hasListener?: boolean };
      if (!meta._hasListener) continue;
      delete meta._hasListener;
      this.publishComputerPush(enriched.computerId, { type: "delivery", payload: enriched });
    }
  }
}

// -----------------------------------------------------------------------------
// Pure helpers — no class state, safe to share across instances.

function defaultModelForRuntime(runtime: string): string {
  if (runtime === "claude") return "sonnet";
  if (runtime === "gemini") return "gemini-2.5-pro";
  if (runtime === "trae") return "Doubao-Seed-1.8";
  return "gpt-5.5";
}

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function nextTaskNumber(state: State, target: string, spaceId?: string | null): number {
  return (state.tasks || []).filter(task =>
    task.target === target && (!spaceId || task.spaceId === spaceId)
  ).length + 1;
}

function findMember(state: State, id: string | undefined | null): MentionRef | null {
  if (!id) return null;
  const agent = (state.agents || []).find(a => a.id === id);
  if (agent) return { id: agent.id, kind: "agent", name: agent.name, handle: agent.handle || slugHandle(agent.name) };
  const human = (state.humans || []).find(h => h.id === id);
  if (human) return { id: human.id, kind: "human", name: human.name, handle: human.handle || slugHandle(human.name) };
  if (id === "human-local") return { id, kind: "human", name: "Local Human", handle: "you" };
  return { id, kind: "system", name: id, handle: slugHandle(id) };
}

function listMembers(state: State): MentionRef[] {
  return [
    ...(state.humans || []).map<MentionRef>(human => ({ id: human.id, kind: "human", name: human.name, handle: human.handle || slugHandle(human.name) })),
    ...(state.agents || []).map<MentionRef>(agent => ({ id: agent.id, kind: "agent", name: agent.name, handle: agent.handle || slugHandle(agent.name) }))
  ];
}

function buildConversationContext(state: State, message: Message | undefined, limit = 20): ContextMessage[] {
  if (!message) return [];
  const messages = (state.messages || []).filter(item => item.spaceId === message.spaceId);
  const index = messages.findIndex(item => item.id === message.id);
  const threadRootId = threadRootFromTarget(message.target);
  const relatedTargets = new Set<string>([message.target]);
  if (threadRootId) relatedTargets.add(parentTargetFromThread(message.target));
  const before = index === -1 ? messages : messages.slice(0, index + 1);
  const threadMessages = before.filter(item => item.target === message.target);
  const rootMessage = threadRootId ? messages.find(item => item.id === threadRootId) : null;
  const channelContext: Message[] = threadRootId
    ? ([rootMessage, ...threadMessages].filter(Boolean) as Message[])
    : before.filter(item => relatedTargets.has(item.target)).slice(-limit);
  const bounded = channelContext.slice(-limit);
  return bounded.map<ContextMessage>(item => ({
    id: item.id,
    author: findMember(state, item.authorId),
    type: item.type,
    text: item.text,
    createdAt: item.createdAt,
    isCurrent: item.id === message.id
  }));
}

function buildActiveDeliveryContext(
  state: State,
  current: Delivery,
  limit = 8
): ActiveDeliveryContext[] {
  return (state.deliveries || [])
    .filter(delivery =>
      delivery.id !== current.id &&
      delivery.agentId === current.agentId &&
      delivery.spaceId === current.spaceId &&
      delivery.target === current.target &&
      ["pending", "delivering"].includes(delivery.status)
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-limit)
    .map(delivery => {
      const lifecycle = delivery.lifecycle || [];
      const running = [...lifecycle].reverse().find(item => item.intent === "delivery.running");
      const queued = [...lifecycle].reverse().find(item => item.intent === "delivery.queued");
      const queuePosition = Number(queued?.details?.queuePosition);
      const message = (state.messages || []).find(item => item.id === delivery.messageId);
      return {
        id: delivery.id,
        target: delivery.target,
        phase: running ? "running" : queued ? "queued" : "pending",
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
        ...(Number.isFinite(queuePosition) ? { queuePosition } : {}),
        messageText: String(message?.text || "").replace(/\s+/g, " ").slice(0, 600)
      };
    });
}

function threadRootFromTarget(target: string): string | null {
  const text = String(target || "");
  const separator = text.lastIndexOf(":");
  if (separator === -1) return null;
  const parent = text.slice(0, separator);
  const suffix = text.slice(separator + 1);
  if (!parent || parent === "dm") return null;
  return suffix.startsWith("msg_") ? suffix : null;
}

const THREAD_MARKER = /^\s*<thread>\s*(\r?\n)?/i;
const SCHEDULE_DIRECTIVE = /<iteam_schedule>\s*([\s\S]*?)\s*<\/iteam_schedule>/i;

function stripThreadMarker(text: string): { text: string; threaded: boolean } {
  const match = THREAD_MARKER.exec(text);
  if (!match) return { text, threaded: false };
  return { text: text.slice(match[0].length), threaded: true };
}

interface ScheduleDirective {
  create?: boolean;
  intervalMs?: number | string;
  cronExpression?: string;
  timezone?: string;
  prompt: string;
  nextRunAt?: string;
}

function stripScheduleDirective(text: string): { text: string; directive: ScheduleDirective | null } {
  const match = SCHEDULE_DIRECTIVE.exec(text);
  if (!match) return { text, directive: null };
  let directive: ScheduleDirective | null = null;
  try {
    const parsed = JSON.parse(match[1]) as ScheduleDirective;
    if (parsed && typeof parsed === "object") directive = parsed;
  } catch {
    directive = { create: true, prompt: "" };
  }
  return {
    text: text.replace(match[0], "").trim(),
    directive
  };
}

function parentTargetFromThread(target: string): string {
  return threadRootFromTarget(target)
    ? String(target || "").slice(0, String(target || "").lastIndexOf(":"))
    : target;
}

function defaultRuntimeForComputer(runtimes: RuntimeInfo[]): string | null {
  const installed = runtimes.filter(runtime => runtime.installed && runtime.id !== "mock");
  const preferredAcpIds = ["trae", "gemini", "hermes"];
  for (const id of preferredAcpIds) {
    if (installed.some(runtime => runtime.id === id)) return id;
  }
  return (
    installed.find(runtime => runtime.id.includes("acp") || /\bACP\b/i.test(runtime.name)) ||
    installed[0]
  )?.id || null;
}

function sessionKeyFromMessage(target: string, messageId: string): string | null {
  const normalized = String(target || "").trim();
  if (!normalized) return null;
  if (normalized.startsWith("dm:") || threadRootFromTarget(normalized)) return normalized;
  if (normalized.startsWith("#")) return `channel-root:${normalized}:${messageId}`;
  return normalized;
}

function channelDefaultAgentForTarget(state: State, target: string, spaceId: string): string | null {
  return findChannelForMessageTarget(state, target, spaceId)?.defaultAgentId || null;
}

function findChannelForMessageTarget(state: State, target: string, spaceId: string): Channel | null {
  const rootTarget = parentTargetFromThread(target);
  if (!rootTarget || rootTarget.startsWith("dm:")) return null;
  return findChannel(state, rootTarget, spaceId) || null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function isOpenTaskStatus(status: string | null | undefined): boolean {
  return status !== "done" && status !== "closed";
}

function normalizeProvider(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function providerKeyForExternalBotConfig(provider: string | null | undefined, appId: string | null | undefined): string {
  const normalized = normalizeProvider(provider || "lark");
  const app = String(appId || "").trim().toLowerCase();
  const baseProvider = normalized.split(":")[0];
  if ((baseProvider === "lark" || baseProvider === "feishu") && app) return `${baseProvider}:${app}`;
  if (normalized.includes(":")) return normalized;
  return normalized;
}

function initialExternalBotStatus(provider: string | null | undefined, appId: string, enabled: boolean): string {
  if (!enabled) return "disabled";
  const baseProvider = normalizeProvider(provider || "lark").split(":")[0];
  if ((baseProvider === "lark" || baseProvider === "feishu") && !/^cli_[A-Za-z0-9]+$/.test(String(appId || "").trim())) {
    return "invalid";
  }
  return "pending";
}

function normalizeTarget(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.startsWith("dm:")) return text;
  return `#${text.replace(/^[/#]+/, "")}`;
}

function externalConversationId(provider: string, tenantKey: string, chatId: string): string {
  return `${provider}:${tenantKey}:${chatId}`;
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

function contextRulesMatch(rules: Record<string, string[]> | undefined, context: Record<string, string>): boolean {
  if (!rules || Object.keys(rules).length === 0) return true;
  for (const [key, allowedValues] of Object.entries(rules)) {
    const value = context[key];
    if (!value || !allowedValues.includes(value)) return false;
  }
  return true;
}

function authenticateIngressPolicy(state: State, input: IngressMessageInput): ExternalIngressPolicy {
  const policyId = String(input.policyId || "").trim();
  const token = String(input.token || "").trim();
  if (!policyId || !token) throw new HttpError(401, "policyId and token are required");
  const policy = (state.externalIngressPolicies || []).find(item => item.id === policyId);
  if (!policy || policy.status !== "active" || policy.token !== token) {
    throw new HttpError(401, "invalid ingress credentials");
  }
  return policy;
}

function deliveryLifecycleRecord(
  intent: DeliveryLifecycleIntent,
  at: string,
  message?: string,
  details?: Record<string, unknown>
): DeliveryLifecycleRecord {
  return {
    intent,
    at,
    ...(message ? { message } : {}),
    ...(details && Object.keys(details).length ? { details } : {})
  };
}

function pushDeliveryLifecycle(
  delivery: Delivery,
  intent: DeliveryLifecycleIntent,
  at: string,
  message?: string,
  details?: Record<string, unknown>
): void {
  delivery.lifecycle ||= [];
  delivery.lifecycle.push(deliveryLifecycleRecord(intent, at, message, details));
  if (delivery.lifecycle.length > 50) {
    delivery.lifecycle.splice(0, delivery.lifecycle.length - 50);
  }
}

function createDeliveryEventRecord(
  state: State,
  input: {
    newId: (prefix: string) => string;
    clock: () => string;
    delivery: Delivery;
    kind: DeliveryEventKind;
    title?: string | null;
    text?: string | null;
    toolName?: string | null;
    toolCallId?: string | null;
    status?: string | null;
    payload?: unknown;
    createdAt?: string;
  }
): DeliveryEvent {
  state.deliveryEvents ||= [];
  const merged = mergeDeliveryStreamEvent(state, input);
  if (merged) return merged;
  const sequence = nextDeliveryEventSequence(state, input.delivery.id);
  const event: DeliveryEvent = {
    id: input.newId("delivery_event"),
    spaceId: input.delivery.spaceId,
    deliveryId: input.delivery.id,
    agentId: input.delivery.agentId,
    target: input.delivery.target,
    kind: input.kind,
    title: sanitizeDeliveryEventText(input.title, 240),
    text: sanitizeDeliveryEventText(input.text, input.kind === "message_delta" || input.kind === "thinking" ? 8_000 : 2_000, {
      preserveWhitespace: input.kind === "message_delta" || input.kind === "thinking"
    }),
    toolName: normalizeOptionalString(input.toolName),
    toolCallId: normalizeOptionalString(input.toolCallId),
    status: normalizeOptionalString(input.status),
    sequence,
    createdAt: input.createdAt || input.clock(),
    payload: sanitizeDeliveryEventPayload(input.payload)
  };
  state.deliveryEvents.push(event);
  createDeliveryArtifactsForEvent(state, event, input.payload, input.newId);
  trimDeliveryEvents(state, input.delivery.id);
  return event;
}

function mergeDeliveryStreamEvent(
  state: State,
  input: {
    delivery: Delivery;
    kind: DeliveryEventKind;
    title?: string | null;
    text?: string | null;
    toolName?: string | null;
    toolCallId?: string | null;
    status?: string | null;
    payload?: unknown;
    createdAt?: string;
  }
): DeliveryEvent | null {
  if (input.kind !== "thinking" && input.kind !== "message_delta") return null;
  const events = state.deliveryEvents || [];
  const previous = [...events]
    .filter(event => event.deliveryId === input.delivery.id)
    .sort((left, right) =>
      right.sequence - left.sequence ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id)
    )[0];
  if (!previous || previous.kind !== input.kind) return null;
  previous.title = sanitizeDeliveryEventText(input.title, 240) || previous.title;
  previous.text = mergeStreamText(
    previous.text || "",
    sanitizeDeliveryEventText(input.text, 8_000, { preserveWhitespace: true }) || "",
    8_000
  );
  previous.status = normalizeOptionalString(input.status) || previous.status;
  previous.payload = sanitizeDeliveryEventPayload(input.payload);
  previous.createdAt = input.createdAt || previous.createdAt;
  return previous;
}

function nextDeliveryEventSequence(state: State, deliveryId: string): number {
  return 1 + Math.max(
    0,
    ...(state.deliveryEvents || [])
      .filter(event => event.deliveryId === deliveryId)
      .map(event => Number(event.sequence) || 0)
  );
}

function trimDeliveryEvents(state: State, deliveryId: string, limit = 200): void {
  const events = state.deliveryEvents || [];
  const scoped = events
    .filter(event => event.deliveryId === deliveryId)
    .sort((left, right) => left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt));
  if (scoped.length <= limit) return;
  const keep = new Set(scoped.slice(scoped.length - limit).map(event => event.id));
  state.deliveryEvents = events.filter(event => event.deliveryId !== deliveryId || keep.has(event.id));
}

function sanitizeDeliveryEventText(
  value: unknown,
  maxLength = 2_000,
  options: { preserveWhitespace?: boolean } = {}
): string | null {
  const text = options.preserveWhitespace
    ? (value === undefined || value === null ? "" : String(value))
    : normalizeOptionalString(value === undefined || value === null ? "" : String(value));
  if (!text) return null;
  return maskSensitiveText(text).slice(0, maxLength);
}

function mergeStreamText(existing: string, next: string, maxLength: number): string {
  if (!existing) return next.slice(0, maxLength);
  if (!next) return existing.slice(0, maxLength);
  const previousChar = existing[existing.length - 1];
  const nextChar = next[0];
  const separator = (
    /\s/.test(previousChar) ||
    /\s/.test(nextChar) ||
    /^[.,;:!?，。；：！？）】}"']/.test(nextChar) ||
    /[（【{"']$/.test(previousChar) ||
    /[\u4e00-\u9fff]/.test(previousChar) ||
    /[\u4e00-\u9fff]/.test(nextChar)
  ) ? "" : " ";
  return `${existing}${separator}${next}`.slice(-maxLength);
}

function createDeliveryArtifactsForEvent(
  state: State,
  event: DeliveryEvent,
  rawPayload: unknown,
  newId: (prefix: string) => string
): void {
  state.deliveryArtifacts ||= [];
  const payload = sanitizeArtifactPayload(rawPayload);
  const artifacts: Array<Omit<DeliveryArtifact, "id" | "spaceId" | "deliveryId" | "eventId" | "agentId" | "target" | "createdAt">> = [];

  if (event.kind === "tool_call") {
    const command = commandTextFromPayload(payload);
    artifacts.push({
      kind: "tool_input",
      title: command ? `Input: ${truncateMiddle(command, 160)}` : `Input: ${event.title || event.toolName || "tool"}`,
      summary: command || compactJson(payload, 300),
      mime: "application/json",
      size: byteSize(stableStringify(payload)),
      sha256: hashText(stableStringify(payload)),
      storage: "db",
      content: stableStringify(payload),
      metadata: artifactMetadataFromPayload(payload)
    });
  }

  if (event.kind === "tool_result") {
    const outputText = outputTextFromPayload(payload);
    artifacts.push({
      kind: "tool_output",
      title: `Output: ${event.title || event.toolName || "tool"}`,
      summary: outputText ? truncateMiddle(outputText.replace(/\s+/g, " ").trim(), 300) : compactJson(payload, 300),
      mime: "application/json",
      size: byteSize(stableStringify(payload)),
      sha256: hashText(stableStringify(payload)),
      storage: "db",
      content: stableStringify(payload),
      metadata: artifactMetadataFromPayload(payload)
    });

    const stdout = stringField(payload, "stdout") || stringField(payload, "formatted_output") || stringField(payload, "aggregated_output");
    if (stdout) {
      artifacts.push(textArtifact({
        kind: "command_stdout",
        title: `stdout: ${truncateMiddle(commandTextFromPayload(payload) || event.title || "command", 140)}`,
        text: stdout,
        metadata: artifactMetadataFromPayload(payload)
      }));
    }
    const stderr = stringField(payload, "stderr");
    if (stderr) {
      artifacts.push(textArtifact({
        kind: "command_stderr",
        title: `stderr: ${truncateMiddle(commandTextFromPayload(payload) || event.title || "command", 140)}`,
        text: stderr,
        metadata: artifactMetadataFromPayload(payload)
      }));
    }
  }

  for (const change of fileChangesFromPayload(payload)) {
    artifacts.push(textArtifact({
      kind: "file_diff",
      title: `Changed ${change.relativePath || change.path}`,
      text: change.diff || change.content || compactJson(change, 2_000),
      path: change.path,
      relativePath: change.relativePath,
      mime: guessMime(change.path || change.relativePath || "change.diff"),
      metadata: {
        ...artifactMetadataFromPayload(payload),
        changeKind: change.kind || null
      }
    }));
  }

  for (const artifact of artifacts.slice(0, 12)) {
    state.deliveryArtifacts.push({
      id: newId("artifact"),
      spaceId: event.spaceId,
      deliveryId: event.deliveryId,
      eventId: event.id,
      agentId: event.agentId,
      target: event.target,
      createdAt: event.createdAt,
      ...artifact
    });
  }
}

function textArtifact(input: {
  kind: string;
  title: string;
  text: string;
  path?: string | null;
  relativePath?: string | null;
  mime?: string;
  metadata?: unknown;
}): Omit<DeliveryArtifact, "id" | "spaceId" | "deliveryId" | "eventId" | "agentId" | "target" | "createdAt"> {
  const text = maskSensitiveText(String(input.text || ""));
  return {
    kind: input.kind,
    title: input.title,
    summary: truncateMiddle(text.replace(/\s+/g, " ").trim(), 300),
    mime: input.mime || "text/plain; charset=utf-8",
    size: byteSize(text),
    sha256: hashText(text),
    storage: "db",
    path: input.path || null,
    relativePath: input.relativePath || null,
    content: truncateArtifactContent(text),
    metadata: input.metadata ?? null
  };
}

function sanitizeArtifactPayload(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(maskSensitiveText(JSON.stringify(value)));
  } catch {
    return maskSensitiveText(String(value));
  }
}

function sanitizeDeliveryEventPayload(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    return truncateJsonValue(JSON.parse(maskSensitiveText(JSON.stringify(value))));
  } catch {
    return maskSensitiveText(String(value)).slice(0, 2_000);
  }
}

function truncateJsonValue(value: unknown, maxStringLength = 2_000): unknown {
  if (typeof value === "string") {
    return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…[truncated ${value.length - maxStringLength} chars]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(item => truncateJsonValue(item, maxStringLength));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[key] = truncateJsonValue(item, maxStringLength);
    }
    return out;
  }
  return value;
}

function commandTextFromPayload(payload: unknown): string | null {
  const record = asRecord(payload);
  const command = record.command;
  if (Array.isArray(command)) return command.map(part => String(part)).join(" ");
  if (typeof command === "string") return command;
  const parsed = Array.isArray(record.parsed_cmd) ? record.parsed_cmd[0] as Record<string, unknown> : null;
  return typeof parsed?.cmd === "string" ? parsed.cmd : null;
}

function outputTextFromPayload(payload: unknown): string | null {
  return stringField(payload, "stdout") ||
    stringField(payload, "stderr") ||
    stringField(payload, "formatted_output") ||
    stringField(payload, "aggregated_output") ||
    (typeof payload === "string" ? payload : null);
}

function artifactMetadataFromPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    callId: record.call_id || record.callId || null,
    processId: record.process_id || null,
    turnId: record.turn_id || null,
    cwd: record.cwd || null,
    command: commandTextFromPayload(payload),
    exitCode: record.exit_code ?? null,
    status: record.status || null,
    duration: record.duration || null
  };
}

function fileChangesFromPayload(payload: unknown): Array<Record<string, string | null>> {
  const record = asRecord(payload);
  const changes = record.changes;
  const output: Array<Record<string, string | null>> = [];
  if (changes && typeof changes === "object" && !Array.isArray(changes)) {
    for (const [path, value] of Object.entries(changes as Record<string, unknown>)) {
      const item = asRecord(value);
      output.push({
        path,
        relativePath: relativeArtifactPath(path),
        kind: typeof item.kind === "string" ? item.kind : null,
        diff: typeof item.diff === "string" ? item.diff : null,
        content: typeof item.content === "string" ? item.content : null
      });
    }
  }
  const filePath = stringField(payload, "file_path") || stringField(payload, "path");
  if (filePath && (stringField(payload, "diff") || stringField(payload, "content"))) {
    output.push({
      path: filePath,
      relativePath: relativeArtifactPath(filePath),
      kind: stringField(payload, "kind"),
      diff: stringField(payload, "diff"),
      content: stringField(payload, "content")
    });
  }
  return output;
}

function relativeArtifactPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const marker = "/.iteam/agents/";
  const index = path.indexOf(marker);
  if (index === -1) return path.split("/").slice(-3).join("/");
  const parts = path.slice(index + marker.length).split("/");
  return parts.slice(1).join("/") || parts.join("/");
}

function stringField(value: unknown, key: string): string | null {
  const item = asRecord(value)[key];
  return typeof item === "string" && item ? item : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactJson(value: unknown, maxLength: number): string {
  return truncateMiddle(stableStringify(value).replace(/\s+/g, " ").trim(), maxLength);
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const head = Math.max(20, Math.floor(maxLength * 0.6));
  const tail = Math.max(10, maxLength - head - 16);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function truncateArtifactContent(value: string, maxLength = 120_000): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} chars]`;
}

function byteSize(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".jsx")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".diff") || lower.endsWith(".patch")) return "text/x-diff; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function maskSensitiveText(value: string): string {
  return String(value || "")
    .replace(/connect_[A-Za-z0-9_-]+/g, "connect_...[redacted]")
    .replace(/(api[_-]?key|authorization|bearer|token|secret)(["'\s:=]+)([^"'\s,}]+)/gi, "$1$2[redacted]");
}

function parseMentions(text: string, state: State, spaceId?: string | null): MentionRef[] {
  const handles = new Set<string>(
    Array.from(String(text || "").matchAll(/@([A-Za-z0-9_-]+)/g)).map(match => match[1].toLowerCase())
  );
  const scopedAgents = spaceId
    ? (state.agents || []).filter(agent => agent.spaceId === spaceId)
    : (state.agents || []);
  const people: MentionRef[] = [
    ...(state.humans || []).map<MentionRef>(human => ({ id: human.id, kind: "human", name: human.name, handle: human.handle || slugHandle(human.name) })),
    ...scopedAgents.map<MentionRef>(agent => ({ id: agent.id, kind: "agent", name: agent.name, handle: agent.handle || slugHandle(agent.name) }))
  ];
  return people.filter(person => handles.has(person.handle.toLowerCase()) || handles.has(person.id.toLowerCase()));
}

function findChannel(state: State, channelIdOrTarget: string, spaceId?: string | null) {
  const scoped = spaceId
    ? (state.channels || []).filter(channel => channel.spaceId === spaceId)
    : (state.channels || []);
  return scoped.find(channel =>
    channel.id === channelIdOrTarget ||
    channel.target === channelIdOrTarget ||
    channel.target === `#${channelIdOrTarget.replace(/^#/, "")}`
  );
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function parseMessageLimit(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 10;
  const numeric = typeof value === "number" ? value : Number(value);
  return Math.max(1, Math.min(1000, numeric || 10));
}

function parseScheduleInterval(value: number | string | null | undefined): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 1000) {
    throw new HttpError(400, "intervalMs must be at least 1000");
  }
  return Math.floor(numeric);
}

interface ParsedSchedule {
  intervalMs: number | null;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: string;
}

function parseSchedule(input: {
  intervalMs?: number | string;
  cronExpression?: string;
  timezone?: string;
  nextRunAt?: string;
  now: string;
}): ParsedSchedule {
  const cronExpression = String(input.cronExpression || "").trim();
  if (cronExpression && input.intervalMs !== undefined) {
    throw new HttpError(400, "use either intervalMs or cronExpression, not both");
  }
  if (cronExpression) {
    const timezone = String(input.timezone || defaultTimezone()).trim();
    return {
      intervalMs: null,
      cronExpression,
      timezone,
      nextRunAt: nextCronRun(cronExpression, timezone, input.now)
    };
  }
  const intervalMs = parseScheduleInterval(input.intervalMs);
  const nextRunAt = input.nextRunAt || new Date(Date.parse(input.now) + intervalMs).toISOString();
  if (!Number.isFinite(Date.parse(nextRunAt))) throw new HttpError(400, "nextRunAt must be an ISO timestamp");
  return { intervalMs, cronExpression: null, timezone: null, nextRunAt };
}

function nextCronRun(expression: string, timezone: string, currentDate: string): string {
  if (expression.trim().split(/\s+/).length !== 5) {
    throw new HttpError(400, "cronExpression must use the standard 5-field format");
  }
  try {
    return CronExpressionParser.parse(expression, { currentDate, tz: timezone }).next().toDate().toISOString();
  } catch (error) {
    throw new HttpError(400, `invalid cronExpression or timezone: ${(error as Error).message}`);
  }
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatScheduleInterval(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} day(s)`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour(s)`;
  if (ms % 60_000 === 0) return `${ms / 60_000} minute(s)`;
  return `${Math.round(ms / 1000)} second(s)`;
}

function formatSchedule(task: ScheduledTask): string {
  if (task.cronExpression) {
    return `cron ${task.cronExpression} (${task.timezone || "UTC"})`;
  }
  return `every ${formatScheduleInterval(parseScheduleInterval(task.intervalMs))}`;
}

function paginateMessages(messages: Message[], options: { limit: number; before?: string | null }): Message[] {
  const ordered = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const before = options.before?.trim();
  if (!before) return ordered.slice(-options.limit);

  const index = ordered.findIndex(message => message.id === before || message.id.startsWith(before));
  if (index >= 0) return ordered.slice(Math.max(0, index - options.limit), index);

  const filtered = ordered.filter(message =>
    message.createdAt < before ||
    message.id < before
  );
  return filtered.slice(-options.limit);
}

function withReplyCounts(allMessages: Message[], messages: Message[]): Array<Message & { replyCount: number }> {
  const counts = new Map<string, number>();
  for (const message of allMessages) {
    const threadId = threadRootFromTarget(message.target);
    if (!threadId) continue;
    counts.set(threadId, (counts.get(threadId) || 0) + 1);
  }
  return messages.map(message => ({
    ...message,
    replyCount: counts.get(message.id) || 0
  }));
}

function withDeliveryDepth(deliveries: Delivery[], messages: Array<Message & { replyCount: number }>): Array<Message & { replyCount: number; depth?: number }> {
  const depthByMessageId = new Map<string, number>();
  for (const d of deliveries) {
    if (d.messageId && d.depth !== undefined && d.depth !== null) {
      const existing = depthByMessageId.get(d.messageId);
      if (existing === undefined || d.depth < existing) {
        depthByMessageId.set(d.messageId, d.depth);
      }
    }
  }
  return messages.map(message => ({
    ...message,
    depth: depthByMessageId.get(message.id)
  }));
}

function migrateChannelTarget(state: State, oldTarget: string, newTarget: string, clock: () => string): void {
  if (oldTarget === newTarget) return;
  const oldThreadPrefix = `${oldTarget}:`;
  const newThreadPrefix = `${newTarget}:`;
  const now = clock();

  for (const message of state.messages || []) {
    if (message.target === oldTarget) message.target = newTarget;
    else if (message.target.startsWith(oldThreadPrefix)) {
      message.target = `${newThreadPrefix}${message.target.slice(oldThreadPrefix.length)}`;
    }
    if (message.threadId && message.target.startsWith(oldThreadPrefix)) {
      message.target = `${newThreadPrefix}${message.target.slice(oldThreadPrefix.length)}`;
    }
  }

  for (const task of state.tasks || []) {
    if (task.target === oldTarget) task.target = newTarget;
    if (task.threadTarget === `${oldTarget}:${task.messageId}`) {
      task.threadTarget = `${newTarget}:${task.messageId}`;
    } else if (task.threadTarget?.startsWith(oldThreadPrefix)) {
      task.threadTarget = `${newThreadPrefix}${task.threadTarget.slice(oldThreadPrefix.length)}`;
    }
    task.updatedAt = now;
  }

  for (const delivery of state.deliveries || []) {
    if (delivery.target === oldTarget) delivery.target = newTarget;
    else if (delivery.target.startsWith(oldThreadPrefix)) {
      delivery.target = `${newThreadPrefix}${delivery.target.slice(oldThreadPrefix.length)}`;
    }
    delivery.updatedAt = now;
  }
}

function slugHandle(value: string): string {
  return String(value || "member").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "member";
}

function slugChannelName(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^#+/, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "channel";
}

/**
 * Space name / slug policy: ASCII letters, digits, `_` and `-` only.
 * Whitespace and unicode letters (including CJK) are rejected so URLs stay
 * clean and slugs stay recognisable across systems.
 */
const SPACE_NAME_PATTERN = /^[A-Za-z0-9 _-]{1,40}$/;
const SPACE_SLUG_PATTERN = /^[a-z0-9_-]{1,40}$/;

function validateSpaceName(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) throw new HttpError(400, "name is required");
  if (!SPACE_NAME_PATTERN.test(raw)) {
    throw new HttpError(400, "space name must be 1-40 ASCII letters, digits, space, underscore, or hyphen");
  }
  return raw;
}

function slugSpaceName(value: string): string {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) throw new HttpError(400, "space slug is empty after normalization; use ASCII letters or digits");
  if (!SPACE_SLUG_PATTERN.test(cleaned)) {
    throw new HttpError(400, "space slug must be 1-40 ASCII lowercase letters, digits, underscore, or hyphen");
  }
  return cleaned;
}

/** Render a token as `<first6>…<last4>` for log diagnostics so we can compare
 * what the daemon presented vs. what the server has bound, without leaking
 * the full secret to logs. */
function maskToken(token: string | undefined | null): string {
  if (!token) return "<none>";
  if (token.length <= 12) return `${token.slice(0, 2)}…${token.slice(-2)}(len=${token.length})`;
  return `${token.slice(0, 6)}…${token.slice(-4)}(len=${token.length})`;
}
