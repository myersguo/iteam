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
  Human,
  Message,
  PendingComputerConnection,
  ScheduledTask,
  Space,
  State,
  StoreEvent,
  Task
} from "@iteam/shared";
import { DEFAULT_SPACE_ID } from "./base.js";

export interface SqlRowSpec {
  key: string;
  keyValues: unknown[];
  values: unknown[];
  fingerprint: string;
}

export interface SqlTableSpec {
  table: string;
  columns: string[];
  keyColumns: string[];
  rows: SqlRowSpec[];
}

export type SqlPersistBaseline = Map<string, Map<string, string>>;

export function emptySqlPersistBaseline(): SqlPersistBaseline {
  return new Map();
}

export function baselineFromState(state: State): SqlPersistBaseline {
  return baselineFromSpecs(buildSqlTableSpecs(state));
}

export function baselineFromSpecs(specs: SqlTableSpec[]): SqlPersistBaseline {
  return new Map(specs.map(spec => [
    spec.table,
    new Map(spec.rows.map(row => [row.key, row.fingerprint]))
  ]));
}

export function buildSqlTableSpecs(state: State): SqlTableSpec[] {
  return [
    table("iteam_spaces", ["id"], [
      "id", "name", "slug", "description", "created_at", "updated_at"
    ], (state.spaces || []).map(spaceRow)),
    table("iteam_humans", ["id"], [
      "id", "name", "handle", "role", "source", "username", "email", "avatar_url", "external_id"
    ], (state.humans || []).map(humanRow)),
    table("iteam_computers", ["id"], [
      "id", "space_id", "name", "fingerprint_id", "fingerprint_hostname", "fingerprint_os", "fingerprint_arch", "status",
      "daemon_version", "runtimes", "agent_ids", "connection_id", "connect_token", "created_at", "first_connected_at", "last_seen_at"
    ], (state.computers || []).map(computerRow)),
    table("iteam_pending_connections", ["id"], [
      "id", "space_id", "token", "status", "created_at", "connected_computer_id", "label", "connected_at"
    ], (state.pendingComputerConnections || []).map(pendingConnectionRow)),
    table("iteam_agents", ["id"], [
      "id", "space_id", "name", "handle", "description", "runtime", "model", "reasoning", "computer_id", "status",
      "desired_status", "launch_id", "pid", "workspace_path", "created_at", "updated_at", "env",
      "share_runtime_history", "last_started_at", "last_runtime_status"
    ], (state.agents || []).map(agentRow)),
    table("iteam_channels", ["id"], [
      "id", "space_id", "name", "target", "kind", "description", "default_agent_id", "created_at"
    ], (state.channels || []).map(channelRow)),
    table("iteam_channel_members", ["channel_id", "member_id"], [
      "channel_id", "member_id"
    ], channelMemberRows(state.channels || [])),
    table("iteam_messages", ["id"], [
      "id", "space_id", "target", "author_id", "type", "text", "mentions", "created_at", "thread_id", "task_id"
    ], (state.messages || []).map(messageRow)),
    table("iteam_tasks", ["id"], [
      "id", "space_id", "number", "target", "title", "description", "status", "assignee_id", "created_by",
      "message_id", "thread_target", "created_at", "updated_at"
    ], (state.tasks || []).map(taskRow)),
    table("iteam_deliveries", ["id"], [
      "id", "space_id", "message_id", "root_message_id", "parent_delivery_id", "depth", "agent_id", "computer_id",
      "target", "session_key", "source", "status", "attempts", "created_at", "updated_at", "error", "lifecycle"
    ], (state.deliveries || []).map(deliveryRow)),
    table("iteam_delivery_events", ["id"], [
      "id", "space_id", "delivery_id", "agent_id", "target", "kind", "title", "text", "tool_name", "tool_call_id",
      "status", "sequence", "created_at", "payload"
    ], (state.deliveryEvents || []).map(deliveryEventRow)),
    table("iteam_delivery_artifacts", ["id"], [
      "id", "space_id", "delivery_id", "event_id", "agent_id", "target", "kind", "title", "summary", "mime",
      "size", "sha256", "storage", "path", "relative_path", "content", "metadata", "created_at"
    ], (state.deliveryArtifacts || []).map(deliveryArtifactRow)),
    table("iteam_scheduled_tasks", ["id"], [
      "id", "space_id", "target", "agent_id", "prompt", "session_key", "interval_ms", "cron_expression", "timezone",
      "status", "next_run_at", "last_run_at", "last_message_id", "run_count", "created_by", "created_at", "updated_at"
    ], (state.scheduledTasks || []).map(scheduledTaskRow)),
    table("iteam_external_ingress_pairings", ["id"], [
      "id", "space_id", "pair_code", "target", "agent_id", "label", "context_rules", "status", "expires_at", "created_at", "consumed_at", "policy_id"
    ], (state.externalIngressPairings || []).map(ingressPairingRow)),
    table("iteam_external_ingress_policies", ["id"], [
      "id", "space_id", "token", "source", "target", "agent_id", "context_rules", "status", "created_at", "updated_at"
    ], (state.externalIngressPolicies || []).map(ingressPolicyRow)),
    table("iteam_external_bot_configs", ["provider"], [
      "provider", "space_id", "alias", "app_id", "app_secret", "domain", "enabled", "status", "status_message", "last_connected_at", "created_at", "updated_at"
    ], (state.externalBotConfigs || []).map(externalBotConfigRow)),
    table("iteam_external_bot_bindings", ["id"], [
      "id", "space_id", "provider", "tenant_key", "chat_id", "chat_type", "default_target", "default_agent_id", "status", "created_at", "updated_at"
    ], (state.externalBotBindings || []).map(externalBotBindingRow)),
    table("iteam_external_message_links", ["id"], [
      "id", "space_id", "provider", "external_conversation_id", "external_message_id", "external_thread_id", "external_root_message_id",
      "external_parent_message_id", "external_reply_to_message_id", "message_id", "root_message_id", "direction", "created_at"
    ], (state.externalMessageLinks || []).map(externalMessageLinkRow)),
    table("iteam_events", ["id"], [
      "id", "type", "payload", "created_at"
    ], (state.events || []).map(storeEventRow))
  ];
}

function table(tableName: string, keyColumns: string[], columns: string[], values: unknown[][]): SqlTableSpec {
  const keyIndexes = keyColumns.map(column => columns.indexOf(column));
  return {
    table: tableName,
    columns,
    keyColumns,
    rows: values.map(rowValues => {
      const keyValues = keyIndexes.map(index => rowValues[index]);
      return {
        key: JSON.stringify(keyValues),
        keyValues,
        values: rowValues,
        fingerprint: JSON.stringify(rowValues)
      };
    })
  };
}

function spaceRow(space: Space): unknown[] {
  return [space.id, space.name, space.slug, space.description ?? null, space.createdAt, space.updatedAt];
}

function humanRow(human: Human): unknown[] {
  return [
    human.id, human.name, human.handle, human.role ?? null, human.source ?? null, human.username ?? null,
    human.email ?? null, human.avatarUrl ?? null, human.externalId ?? null
  ];
}

function computerRow(computer: Computer): unknown[] {
  return [
    computer.id,
    computer.spaceId || DEFAULT_SPACE_ID,
    computer.name,
    computer.fingerprint?.id ?? null,
    computer.fingerprint?.hostname ?? null,
    computer.fingerprint?.os ?? null,
    computer.fingerprint?.arch ?? null,
    computer.status,
    computer.daemonVersion,
    JSON.stringify(computer.runtimes || []),
    JSON.stringify(computer.agentIds || []),
    computer.connectionId ?? null,
    computer.connectToken ?? null,
    computer.createdAt,
    computer.firstConnectedAt ?? null,
    computer.lastSeenAt ?? null
  ];
}

function pendingConnectionRow(pending: PendingComputerConnection): unknown[] {
  return [
    pending.id, pending.spaceId || DEFAULT_SPACE_ID, pending.token, pending.status, pending.createdAt,
    pending.connectedComputerId ?? null, pending.label ?? null, pending.connectedAt ?? null
  ];
}

function agentRow(agent: Agent): unknown[] {
  return [
    agent.id, agent.spaceId || DEFAULT_SPACE_ID, agent.name, agent.handle, agent.description, agent.runtime,
    agent.model ?? null, agent.reasoning ?? null, agent.computerId, agent.status, agent.desiredStatus,
    agent.launchId ?? null, agent.pid ?? null, agent.workspacePath, agent.createdAt, agent.updatedAt,
    JSON.stringify(agent.env || {}), agent.shareRuntimeHistory ? 1 : 0, agent.lastStartedAt ?? null,
    agent.lastRuntimeStatus ? JSON.stringify(agent.lastRuntimeStatus) : null
  ];
}

function channelRow(channel: Channel): unknown[] {
  return [
    channel.id, channel.spaceId || DEFAULT_SPACE_ID, channel.name, channel.target, channel.kind,
    channel.description ?? null, channel.defaultAgentId ?? null, channel.createdAt
  ];
}

function channelMemberRows(channels: Channel[]): unknown[][] {
  const rows: unknown[][] = [];
  for (const channel of channels) {
    for (const memberId of channel.memberIds || []) rows.push([channel.id, memberId]);
  }
  return rows;
}

function messageRow(message: Message): unknown[] {
  return [
    message.id, message.spaceId || DEFAULT_SPACE_ID, message.target, message.authorId, message.type, message.text,
    JSON.stringify(message.mentions || []), message.createdAt, message.threadId ?? null, message.taskId ?? null
  ];
}

function taskRow(task: Task): unknown[] {
  return [
    task.id, task.spaceId || DEFAULT_SPACE_ID, task.number, task.target, task.title, task.description ?? "",
    task.status, task.assigneeId ?? null, task.createdBy, task.messageId, task.threadTarget ?? null,
    task.createdAt, task.updatedAt
  ];
}

function deliveryRow(delivery: Delivery): unknown[] {
  return [
    delivery.id, delivery.spaceId || DEFAULT_SPACE_ID, delivery.messageId ?? null, delivery.rootMessageId ?? null,
    delivery.parentDeliveryId ?? null, delivery.depth ?? 0, delivery.agentId, delivery.computerId, delivery.target,
    delivery.sessionKey ?? null, delivery.source ?? null, delivery.status, delivery.attempts ?? 0, delivery.createdAt,
    delivery.updatedAt, delivery.error ?? null, JSON.stringify(delivery.lifecycle || [])
  ];
}

function deliveryEventRow(event: DeliveryEvent): unknown[] {
  return [
    event.id, event.spaceId || DEFAULT_SPACE_ID, event.deliveryId, event.agentId, event.target, event.kind,
    event.title ?? null, event.text ?? null, event.toolName ?? null, event.toolCallId ?? null, event.status ?? null,
    event.sequence ?? 0, event.createdAt, event.payload !== undefined ? JSON.stringify(event.payload) : null
  ];
}

function deliveryArtifactRow(artifact: DeliveryArtifact): unknown[] {
  return [
    artifact.id, artifact.spaceId || DEFAULT_SPACE_ID, artifact.deliveryId, artifact.eventId ?? null, artifact.agentId,
    artifact.target, artifact.kind, artifact.title, artifact.summary ?? null, artifact.mime, artifact.size ?? 0,
    artifact.sha256 ?? null, artifact.storage || "db", artifact.path ?? null, artifact.relativePath ?? null,
    artifact.content ?? null, artifact.metadata !== undefined ? JSON.stringify(artifact.metadata) : null, artifact.createdAt
  ];
}

function scheduledTaskRow(task: ScheduledTask): unknown[] {
  return [
    task.id, task.spaceId || DEFAULT_SPACE_ID, task.target, task.agentId, task.prompt, task.sessionKey ?? null,
    task.intervalMs ?? 0, task.cronExpression ?? null, task.timezone ?? null, task.status, task.nextRunAt,
    task.lastRunAt ?? null, task.lastMessageId ?? null, task.runCount ?? 0, task.createdBy, task.createdAt, task.updatedAt
  ];
}

function ingressPairingRow(pairing: ExternalIngressPairing): unknown[] {
  return [
    pairing.id, pairing.spaceId || DEFAULT_SPACE_ID, pairing.pairCode, pairing.target, pairing.agentId, pairing.label ?? null,
    pairing.contextRules ? JSON.stringify(pairing.contextRules) : null, pairing.status, pairing.expiresAt,
    pairing.createdAt, pairing.consumedAt ?? null, pairing.policyId ?? null
  ];
}

function ingressPolicyRow(policy: ExternalIngressPolicy): unknown[] {
  return [
    policy.id, policy.spaceId || DEFAULT_SPACE_ID, policy.token, policy.source, policy.target, policy.agentId,
    policy.contextRules ? JSON.stringify(policy.contextRules) : null, policy.status, policy.createdAt, policy.updatedAt
  ];
}

function externalBotConfigRow(config: ExternalBotConfig): unknown[] {
  return [
    config.provider, config.spaceId || DEFAULT_SPACE_ID, config.alias ?? null, config.appId, config.appSecret ?? null, config.domain ?? null,
    config.enabled ? 1 : 0, config.status ?? null, config.statusMessage ?? null, config.lastConnectedAt ?? null,
    config.createdAt, config.updatedAt
  ];
}

function externalBotBindingRow(binding: ExternalBotBinding): unknown[] {
  return [
    binding.id, binding.spaceId || DEFAULT_SPACE_ID, binding.provider, binding.tenantKey, binding.chatId, binding.chatType ?? null,
    binding.defaultTarget ?? null, binding.defaultAgentId ?? null, binding.status, binding.createdAt, binding.updatedAt
  ];
}

function externalMessageLinkRow(link: ExternalMessageLink): unknown[] {
  return [
    link.id, link.spaceId || DEFAULT_SPACE_ID, link.provider, link.externalConversationId, link.externalMessageId ?? null, link.externalThreadId ?? null,
    link.externalRootMessageId ?? null, link.externalParentMessageId ?? null, link.externalReplyToMessageId ?? null,
    link.messageId, link.rootMessageId ?? null, link.direction, link.createdAt
  ];
}

function storeEventRow(event: StoreEvent): unknown[] {
  return [event.id, event.type, event.payload !== undefined ? JSON.stringify(event.payload) : null, event.createdAt];
}
