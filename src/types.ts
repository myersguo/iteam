// Shared domain types used across the daemon, agent launcher, and CLI.

export type AgentRuntime = string;

export type AgentDesiredStatus = "running" | "stopped";

export type AgentStatus =
  | "registered"
  | "starting"
  | "online"
  | "idle"
  | "offline"
  | "stopped"
  | "exited"
  | "launch_failed"
  | "stop_failed"
  | string;

export type MemberKind = "human" | "agent" | "system";

export interface Fingerprint {
  id: string;
  hostname: string;
  os: string;
  arch: string;
}

export interface RuntimeInfo {
  id: string;
  name: string;
  installed: boolean;
}

export interface Human {
  id: string;
  name: string;
  handle: string;
  role?: string;
}

export interface Agent {
  id: string;
  name: string;
  handle: string;
  description: string;
  runtime: AgentRuntime;
  model: string | null;
  reasoning?: string;
  computerId: string;
  status: AgentStatus;
  desiredStatus: AgentDesiredStatus;
  launchId: string | null;
  pid: number | null;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  env?: Record<string, string>;
  lastStartedAt?: string;
  lastRuntimeStatus?: Record<string, unknown>;
}

export interface Computer {
  id: string;
  name: string;
  fingerprint: Fingerprint;
  status: string;
  daemonVersion: string;
  runtimes: RuntimeInfo[];
  agentIds: string[];
  connectionId: string;
  /**
   * Permanent connect token bound to this computer on first registration.
   * Server-determined; never rotates. The daemon supplies it via
   * `--connect-token` on every launch and presents it as
   * `X-Iteam-Connection: <computerId>:<token>` on heartbeats and runtime
   * callbacks. There is no client-side token cache: the server's storage
   * is the single source of truth.
   */
  connectToken?: string;
  createdAt: string;
  firstConnectedAt?: string;
  lastSeenAt?: string;
}

export interface PendingComputerConnection {
  id: string;
  token: string;
  status: "waiting" | "connected" | string;
  createdAt: string;
  connectedComputerId: string | null;
  label: string;
  connectedAt?: string;
}

export interface Channel {
  id: string;
  name: string;
  target: string;
  kind: string;
  description: string;
  memberIds: string[];
  createdAt: string;
}

export interface MentionRef {
  id: string;
  kind: MemberKind;
  name: string;
  handle: string;
}

export type MessageType = "human" | "agent" | "task" | "system" | string;

export interface Message {
  id: string;
  target: string;
  authorId: string;
  type: MessageType;
  text: string;
  mentions: MentionRef[];
  createdAt: string;
  threadId: string | null;
  taskId?: string;
}

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done" | string;

export type DeliveryLifecycleIntent =
  | "delivery.dispatch"
  | "delivery.ack"
  | "delivery.progress"
  | "delivery.help_needed"
  | "delivery.result"
  | "delivery.cancel";

export interface DeliveryLifecycleRecord {
  intent: DeliveryLifecycleIntent;
  at: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface Task {
  id: string;
  number: number;
  target: string;
  title: string;
  description: string;
  status: TaskStatus;
  assigneeId: string | null;
  createdBy: string;
  messageId: string;
  threadTarget: string;
  createdAt: string;
  updatedAt: string;
}

export type ScheduledTaskStatus = "active" | "paused" | string;

export interface ScheduledTask {
  id: string;
  target: string;
  agentId: string;
  prompt: string;
  sessionKey?: string | null;
  intervalMs: number | null;
  cronExpression?: string | null;
  timezone?: string | null;
  status: ScheduledTaskStatus;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastMessageId?: string | null;
  runCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Delivery {
  id: string;
  messageId: string;
  rootMessageId: string;
  parentDeliveryId: string | null;
  depth: number;
  agentId: string;
  computerId: string;
  target: string;
  sessionKey?: string | null;
  source?: string | null;
  status: "pending" | "delivering" | "done" | "failed" | string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
  lifecycle?: DeliveryLifecycleRecord[];
}

export interface ExternalIngressPairing {
  id: string;
  pairCode: string;
  target: string;
  agentId: string;
  label?: string;
  contextRules?: Record<string, string[]>;
  status: "waiting" | "consumed" | "expired" | string;
  expiresAt: string;
  createdAt: string;
  consumedAt?: string | null;
  policyId?: string | null;
}

export interface ExternalIngressPolicy {
  id: string;
  token: string;
  source: string;
  target: string;
  agentId: string;
  contextRules?: Record<string, string[]>;
  status: "active" | "revoked" | string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalBotBinding {
  id: string;
  provider: string;
  tenantKey: string;
  chatId: string;
  chatType?: string | null;
  defaultTarget?: string | null;
  defaultAgentId?: string | null;
  status: "active" | "revoked" | string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalBotConfig {
  provider: string;
  alias?: string | null;
  appId: string;
  appSecret?: string | null;
  domain?: string | null;
  enabled: boolean;
  status?: "pending" | "connected" | "error" | "invalid" | "disabled" | string;
  statusMessage?: string | null;
  lastConnectedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalMessageLink {
  id: string;
  provider: string;
  externalConversationId: string;
  externalMessageId?: string | null;
  messageId: string;
  rootMessageId?: string | null;
  direction: "in" | "out" | string;
  createdAt: string;
}

export interface StoreEvent {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface StoreMeta {
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
}

export interface State {
  meta: StoreMeta;
  computers: Computer[];
  pendingComputerConnections: PendingComputerConnection[];
  humans: Human[];
  agents: Agent[];
  channels: Channel[];
  messages: Message[];
  deliveries: Delivery[];
  tasks: Task[];
  scheduledTasks: ScheduledTask[];
  externalIngressPairings: ExternalIngressPairing[];
  externalIngressPolicies: ExternalIngressPolicy[];
  externalBotConfigs: ExternalBotConfig[];
  externalBotBindings: ExternalBotBinding[];
  externalMessageLinks: ExternalMessageLink[];
  events: StoreEvent[];
}

export interface DeliveryWithContext extends Delivery {
  agent?: Agent;
  message?: Message;
  author?: MentionRef | null;
  contextMessages?: ContextMessage[];
  members?: MentionRef[];
}

export interface ContextMessage {
  id: string;
  author: MentionRef | null;
  type: MessageType;
  text: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface ConnectComputerResult extends Computer {
  launchAgents: Agent[];
  stopAgents: Agent[];
  deliveries: DeliveryWithContext[];
}
