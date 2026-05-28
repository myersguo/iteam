// IteamCore — domain logic separated from HTTP transport.
//
// Mirrors zouk-daemon's DaemonCore pattern: the HTTP layer (http-server.ts)
// only translates wire protocol; this class owns all state mutations, message
// dispatch, and delivery enqueueing. Dependencies (store, runtime manager,
// clock, id generator) are injectable so the class is library-friendly and
// testable without booting an HTTP server.

import { createId as defaultCreateId, nowIso as defaultNowIso, DAEMON_VERSION } from "./lib.js";
import { createStore } from "./store/index.js";
import { RuntimeManager } from "./runtime.js";
import type { IStore, StateListener } from "./store/types.js";
import type {
  Agent,
  ConnectComputerResult,
  ContextMessage,
  Delivery,
  DeliveryWithContext,
  Fingerprint,
  MentionRef,
  Message,
  PendingComputerConnection,
  RuntimeInfo,
  State,
  StoreEvent,
  Task
} from "./types.js";

const MAX_DELIVERY_DEPTH = 20;
const SUPPORTED_RUNTIMES = ["codex", "claude", "gemini", "trae"];

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

export interface MessageCreateInput {
  target: string;
  text: string;
  authorId?: string;
  type?: string;
  mentions?: MentionRef[];
  createdAt?: string;
  threadId?: string | null;
  defaultAgentId?: string;
}

export interface AgentCreateInput {
  name: string;
  description?: string;
  runtime: string;
  computerId: string;
  model?: string;
  reasoning?: string;
  env?: Record<string, string>;
}

export interface AgentPatchInput {
  name?: string;
  description?: string;
}

export interface ChannelCreateInput {
  name: string;
  description?: string;
  private?: boolean;
}

export interface ChannelPatchInput {
  name?: string;
  description?: string;
}

export interface TaskCreateInput {
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

export interface ConnectInviteInput {
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

export interface MessageQuery {
  target?: string;
  limit?: number | string | null;
  before?: string | null;
}

export interface ChannelMessageQuery {
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
        const agent = s.agents.find(a => a.id === delivery.agentId);
        const label = agent ? `@${agent.handle || slugHandle(agent.name)}` : delivery.agentId;
        s.messages.push({
          id: this.newId("msg"),
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

  listChannels() {
    return this.store.snapshot().channels || [];
  }

  listAgents() {
    return this.store.snapshot().agents || [];
  }

  listComputers() {
    return this.store.snapshot().computers || [];
  }

  listHumans() {
    return this.store.snapshot().humans || [];
  }

  listDeliveries() {
    return this.store.snapshot().deliveries || [];
  }

  listPendingConnections() {
    return this.store.snapshot().pendingComputerConnections || [];
  }

  listTasks(filter: { target?: string | null; status?: string | null } = {}) {
    let tasks = this.store.snapshot().tasks || [];
    if (filter.target) tasks = tasks.filter(task => task.target === filter.target);
    if (filter.status) tasks = tasks.filter(task => task.status === filter.status);
    return tasks;
  }

  listMessagesByTarget(query: MessageQuery): Message[] {
    if (!query.target) {
      throw new HttpError(400, "target is required; use /api/messages/channel/:channelId for channel messages");
    }
    const snapshot = this.store.snapshot();
    const limit = parseMessageLimit(query.limit);
    const filtered = (snapshot.messages || []).filter(message => message.target === query.target);
    return paginateMessages(filtered, { limit, before: query.before ?? null });
  }

  listMessagesByChannel(query: ChannelMessageQuery): Array<Message & { replyCount: number }> {
    const snapshot = this.store.snapshot();
    const channel = findChannel(snapshot, query.channelId);
    if (!channel) throw new HttpError(404, "channel not found");
    const limit = parseMessageLimit(query.limit);
    const messages = (snapshot.messages || []).filter(message => message.target === channel.target);
    const paginated = paginateMessages(messages, { limit, before: query.before ?? null });
    return withReplyCounts(snapshot.messages || [], paginated);
  }

  // ---------------------------------------------------------------------------
  // channels

  createChannel(input: ChannelCreateInput) {
    if (!input.name?.trim()) throw new HttpError(400, "name is required");
    return this.store.mutate(s => {
      const now = this.clock();
      const name = slugChannelName(input.name);
      const target = `#${name}`;
      if (s.channels.some(channel => channel.target === target)) {
        throw new HttpError(409, "channel already exists");
      }
      const created = {
        id: this.newId("chan"),
        name,
        target,
        kind: input.private ? "private" : "channel",
        description: input.description?.trim() || `Channel for ${name}`,
        memberIds: [
          ...(s.humans || []).map(human => human.id),
          ...(s.agents || []).map(agent => agent.id)
        ],
        createdAt: now
      };
      s.channels.push(created);
      s.messages.push({
        id: this.newId("msg"),
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
        if (target !== oldTarget && s.channels.some(channel => channel.id !== current.id && channel.target === target)) {
          throw new HttpError(409, "channel already exists");
        }
        current.name = name;
        current.target = target;
        migrateChannelTarget(s, oldTarget, target, this.clock);
      }
      if (input.description !== undefined) current.description = input.description.trim();
      return current;
    });
  }

  ensureAgentDmChannel(agentId: string) {
    return this.store.mutate(s => {
      const now = this.clock();
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
        name: agent.name,
        target,
        kind: "dm",
        description: `Direct message with ${agent.name}`,
        memberIds: uniqueIds(["human-local", agent.id]),
        createdAt: now
      };
      s.channels.push(created);
      return created;
    });
  }

  // ---------------------------------------------------------------------------
  // computers / connect flow

  createConnectInvite(input: ConnectInviteInput, originFromHost: string): ConnectInviteResult {
    const origin = input.serverUrl || originFromHost;
    const token = this.newId("connect");
    const invite = this.store.mutate<PendingComputerConnection>(s => {
      const now = this.clock();
      const created: PendingComputerConnection = {
        id: this.newId("computer_invite"),
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
      shellQuote(token)
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
          const message = s.messages.find(message => message.id === delivery.messageId);
          const author = findMember(s, message?.authorId);
          return {
            ...delivery,
            agent: s.agents.find(agent => agent.id === delivery.agentId),
            message,
            author,
            contextMessages: buildConversationContext(s, message),
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
    if (!input.runtime || !SUPPORTED_RUNTIMES.includes(input.runtime)) {
      throw new HttpError(400, "runtime must be codex, claude, gemini, or trae");
    }
    if (!input.computerId) throw new HttpError(400, "computerId is required");

    const state = this.store.snapshot();
    const computer = state.computers.find(c => c.id === input.computerId);
    if (!computer) throw new HttpError(404, "computer not found");
    const runtimeInfo = computer.runtimes?.find(runtime => runtime.id === input.runtime);
    if (!runtimeInfo?.installed) {
      throw new HttpError(400, `${input.runtime} is not installed on ${computer.name}`);
    }

    const agent = this.store.mutate<Agent>(s => {
      const now = this.clock();
      const agentId = this.newId("agent");
      const created: Agent = {
        id: agentId,
        name: input.name,
        handle: input.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
        description: input.description || "Local AI teammate",
        runtime: input.runtime as Agent["runtime"],
        model: input.model || defaultModelForRuntime(input.runtime),
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
      const all = s.channels.find(c => c.target === "#all");
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
        const taken = s.agents.some(agent => agent.id !== current.id && agent.handle === handle);
        if (taken) throw new HttpError(409, "agent handle already exists");
        current.name = name;
        current.handle = handle;
      }
      if (input.description !== undefined) current.description = input.description.trim();
      current.updatedAt = this.clock();
      return current;
    });
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
    const createdIds: string[] = [];
    const message = this.store.mutate<Message>(s => {
      const now = this.clock();
      const created: Message = {
        id: this.newId("msg"),
        target: input.target,
        authorId: input.authorId || "human-local",
        type: input.type || "human",
        text: input.text,
        mentions: input.mentions || parseMentions(input.text, s),
        createdAt: input.createdAt || now,
        threadId: input.threadId !== undefined ? input.threadId : threadRootFromTarget(input.target)
      };
      s.messages.push(created);
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
          createdIds
        });
        if (queued === 0) {
          const offline = agentMentions
            .map(m => `@${m.handle || slugHandle(m.name)}`)
            .join(", ");
          s.messages.push({
            id: this.newId("msg"),
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
        // No explicit mention — only fall back when the caller passed an
        // explicit defaultAgentId (e.g. channel default agent picker).
        if (input.defaultAgentId) {
          this.enqueueDefaultAgentDelivery(s, created, input.defaultAgentId, createdIds);
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
      delivery.status = input.ok ? "done" : "failed";
      delivery.error = input.error || null;
      delivery.updatedAt = now;
      if (input.ok && input.text) {
        const created: Message = {
          id: this.newId("msg"),
          target: delivery.target,
          authorId: delivery.agentId,
          type: "agent",
          text: input.text,
          mentions: parseMentions(input.text, s),
          createdAt: now,
          threadId: input.threadId || threadRootFromTarget(delivery.target)
        };
        s.messages.push(created);
        // Same DM safeguard as user-sent messages: an agent reply in a DM may
        // not fan out to other agents — only the DM peer is reachable from
        // inside `dm:<peer>`.
        this.filterDmMentions(s, created, now);
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

  // ---------------------------------------------------------------------------
  // tasks

  createTask(input: TaskCreateInput): Task {
    if (!input.target || !input.title) throw new HttpError(400, "target and title are required");
    const task = this.store.mutate<Task>(s => {
      const now = this.clock();
      const messageId = this.newId("msg");
      const taskNumber = nextTaskNumber(s, input.target);
      const created: Task = {
        id: this.newId("task"),
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
          depth: 0
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
      target: created.target,
      authorId: "system",
      type: "system",
      text: `${labels} ignored: this is a direct message; only the DM peer can be addressed here.`,
      mentions: [],
      createdAt: now,
      threadId: threadRootFromTarget(created.target)
    });
  }

  private enqueueMentionDeliveries(
    state: State,
    message: Message,
    options: { rootMessageId?: string; parentDeliveryId?: string | null; depth?: number; excludeAgentId?: string | null; createdIds?: string[] } = {}
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
        createdIds: options.createdIds
      });
      queued += 1;
    }
    return queued;
  }

  private enqueueDefaultAgentDelivery(state: State, message: Message, defaultAgentId?: string, createdIds?: string[]): number {
    const channel = (state.channels || []).find(channel => channel.target === message.target);
    const channelMemberIds = new Set<string>(channel?.memberIds || []);
    const selectedAgent = defaultAgentId ? state.agents.find(a => a.id === defaultAgentId) : null;
    const fallbackAgent = state.agents.find(a =>
      a.desiredStatus === "running" &&
      (!channelMemberIds.size || channelMemberIds.has(a.id))
    );
    const agent = selectedAgent?.desiredStatus === "running" ? selectedAgent : fallbackAgent;
    if (!agent) return 0;

    return this.enqueueSingleAgentDelivery(state, message, agent.id, {
      rootMessageId: message.id,
      parentDeliveryId: null,
      depth: 0,
      createdIds
    });
  }

  private enqueueSingleAgentDelivery(
    state: State,
    message: Message,
    agentId: string,
    options: { target?: string; rootMessageId?: string; parentDeliveryId?: string | null; depth?: number; createdIds?: string[] } = {}
  ): number {
    const agent = state.agents.find(a => a.id === agentId);
    if (!agent || agent.desiredStatus !== "running") return 0;
    state.deliveries ||= [];
    const now = this.clock();
    const id = this.newId("delivery");
    state.deliveries.push({
      id,
      messageId: message.id,
      rootMessageId: options.rootMessageId || message.id,
      parentDeliveryId: options.parentDeliveryId || null,
      depth: options.depth || 0,
      agentId: agent.id,
      computerId: agent.computerId,
      target: options.target || message.target,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now
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
        }
        const message = s.messages.find(m => m.id === delivery.messageId);
        const author = findMember(s, message?.authorId);
        out.push({
          ...delivery,
          agent: s.agents.find(agent => agent.id === delivery.agentId),
          message,
          author,
          contextMessages: buildConversationContext(s, message),
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

function nextTaskNumber(state: State, target: string): number {
  return (state.tasks || []).filter(task => task.target === target).length + 1;
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
  const messages = state.messages || [];
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

function threadRootFromTarget(target: string): string | null {
  const text = String(target || "");
  const separator = text.lastIndexOf(":");
  if (separator === -1) return null;
  const parent = text.slice(0, separator);
  const suffix = text.slice(separator + 1);
  if (!parent || parent === "dm") return null;
  return suffix.startsWith("msg_") ? suffix : null;
}

function parentTargetFromThread(target: string): string {
  return threadRootFromTarget(target)
    ? String(target || "").slice(0, String(target || "").lastIndexOf(":"))
    : target;
}

function parseMentions(text: string, state: State): MentionRef[] {
  const handles = new Set<string>(
    Array.from(String(text || "").matchAll(/@([A-Za-z0-9_-]+)/g)).map(match => match[1].toLowerCase())
  );
  const people: MentionRef[] = [
    ...(state.humans || []).map<MentionRef>(human => ({ id: human.id, kind: "human", name: human.name, handle: human.handle || slugHandle(human.name) })),
    ...(state.agents || []).map<MentionRef>(agent => ({ id: agent.id, kind: "agent", name: agent.name, handle: agent.handle || slugHandle(agent.name) }))
  ];
  return people.filter(person => handles.has(person.handle.toLowerCase()) || handles.has(person.id.toLowerCase()));
}

function findChannel(state: State, channelIdOrTarget: string) {
  return (state.channels || []).find(channel =>
    channel.id === channelIdOrTarget ||
    channel.target === channelIdOrTarget ||
    channel.target === `#${channelIdOrTarget.replace(/^#/, "")}`
  );
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function parseMessageLimit(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 50;
  const numeric = typeof value === "number" ? value : Number(value);
  return Math.max(1, Math.min(1000, numeric || 50));
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

/** Render a token as `<first6>…<last4>` for log diagnostics so we can compare
 * what the daemon presented vs. what the server has bound, without leaking
 * the full secret to logs. */
function maskToken(token: string | undefined | null): string {
  if (!token) return "<none>";
  if (token.length <= 12) return `${token.slice(0, 2)}…${token.slice(-2)}(len=${token.length})`;
  return `${token.slice(0, 6)}…${token.slice(-4)}(len=${token.length})`;
}
