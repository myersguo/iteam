// Shared domain types used across the daemon, agent launcher, and CLI.

export type AgentRuntime = "codex" | "claude" | "gemini" | "opencode" | "trae";

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

export interface Delivery {
  id: string;
  messageId: string;
  rootMessageId: string;
  parentDeliveryId: string | null;
  depth: number;
  agentId: string;
  computerId: string;
  target: string;
  status: "pending" | "delivering" | "done" | "failed" | string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
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
