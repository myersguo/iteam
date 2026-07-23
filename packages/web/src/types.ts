export type SectionId = "chat" | "tasks" | "members" | "computers" | "scheduled" | "integrations";

export interface Human {
  id: string;
  name: string;
  handle?: string;
  role?: string;
  source?: string;
  username?: string;
  email?: string;
  avatarUrl?: string;
  externalId?: string;
}

export interface Agent {
  id: string;
  name: string;
  handle?: string;
  status: string;
  desiredStatus?: string;
  runtime: string;
  model?: string;
  reasoning?: string;
  workspacePath?: string;
  computerId?: string;
  lastRuntimeStatus?: {
    error?: string;
    [key: string]: unknown;
  };
}

export interface Channel {
  id: string;
  name: string;
  target: string;
  kind?: string;
  description?: string;
  memberIds?: string[];
  defaultAgentId?: string | null;
  messageCount?: number;
}

export interface Message {
  id: string;
  target: string;
  authorId: string;
  text: string;
  type?: string;
  createdAt: string;
  threadId?: string | null;
  taskId?: string;
  replyCount?: number;
  depth?: number;
}

export interface Task {
  id: string;
  number?: number;
  title: string;
  description?: string;
  status: string;
  target: string;
  messageId: string;
  threadTarget?: string;
  createdBy?: string;
  assigneeId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  replyCount?: number;
}

export interface ScheduledTask {
  id: string;
  target: string;
  agentId: string;
  prompt: string;
  intervalMs: number | null;
  cronExpression?: string | null;
  timezone?: string | null;
  status: string;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastMessageId?: string | null;
  runCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeInfo {
  id: string;
  name: string;
  installed: boolean;
}

export interface ComputerEntity {
  id: string;
  name: string;
  status: string;
  connectionId?: string;
  connectToken?: string;
  daemonVersion?: string;
  fingerprint: { os: string; arch: string };
  runtimes: RuntimeInfo[];
}

export interface ExternalBotConfig {
  provider: string;
  alias?: string | null;
  appId: string;
  appSecret?: string | null;
  domain?: string | null;
  enabled: boolean;
  status?: string | null;
  statusMessage?: string | null;
  lastConnectedAt?: string | null;
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
  status: string;
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  description?: string;
}

export interface DeliveryLifecycleRecord {
  intent: string;
  at: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface Delivery {
  id: string;
  agentId: string;
  messageId?: string;
  target: string;
  status: string;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  lifecycle?: DeliveryLifecycleRecord[];
}

export interface DeliveryEvent {
  id: string;
  deliveryId: string;
  agentId: string;
  target: string;
  kind: string;
  title?: string | null;
  text?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  status?: string | null;
  sequence: number;
  createdAt: string;
  payload?: unknown;
}

export interface DeliveryArtifact {
  id: string;
  deliveryId: string;
  eventId?: string | null;
  agentId: string;
  target: string;
  kind: string;
  title: string;
  summary?: string | null;
  mime: string;
  size: number;
  sha256?: string | null;
  storage: string;
  path?: string | null;
  relativePath?: string | null;
  content?: string | null;
  metadata?: unknown;
  createdAt: string;
}

export interface AppState {
  humans: Human[];
  agents: Agent[];
  channels: Channel[];
  messages: Message[];
  tasks: Task[];
  scheduledTasks: ScheduledTask[];
  computers: ComputerEntity[];
  externalBotConfigs: ExternalBotConfig[];
  externalBotBindings: ExternalBotBinding[];
  deliveries: Delivery[];
  deliveryEvents: DeliveryEvent[];
  deliveryArtifacts: DeliveryArtifact[];
  events: unknown[];
  spaces: Space[];
}

export interface AuthProviderOption {
  id: string;
  label: string;
  type: string;
  loginUrl: string;
}

export interface AuthInfo {
  authMode: "none" | "oauth";
  providers?: AuthProviderOption[];
  authenticated: boolean;
  human?: Human | null;
  loginUrl?: string;
  logoutUrl?: string;
}

export interface ConfirmationRequest {
  title: string;
  content: string;
  onOk: () => Promise<void>;
}
