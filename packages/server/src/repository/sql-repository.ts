import type {
  Channel,
  DeliveryArtifact,
  DeliveryEvent,
  MentionRef,
  Message
} from "@iteam/shared";
import { DEFAULT_SPACE_ID } from "../store/base.js";
import type {
  ChannelMessageQuery,
  ChannelMessageResult,
  DeliveryArtifactQuery,
  DeliveryEventQuery,
  IteamRepository,
  MessageQuery,
  SqlRowsAdapter
} from "./types.js";

interface MessageRow {
  id: string;
  space_id: string | null;
  target: string;
  author_id: string;
  type: string;
  text: string;
  mentions: string | MentionRef[];
  created_at: string;
  thread_id: string | null;
  task_id: string | null;
}

interface ChannelRow {
  id: string;
  space_id: string | null;
  name: string;
  target: string;
  kind: string;
  description: string | null;
  default_agent_id: string | null;
  created_at: string;
  member_ids?: string | null;
}

interface DeliveryRow {
  id: string;
  space_id: string | null;
  message_id: string;
  root_message_id: string;
  parent_delivery_id: string | null;
  depth: number | null;
  agent_id: string;
  computer_id: string;
  target: string;
  session_key: string | null;
  source: string | null;
  status: string;
  attempts: number | null;
  created_at: string;
  updated_at: string;
  error: string | null;
  lifecycle: string | unknown | null;
}

interface DeliveryEventRow {
  id: string;
  space_id: string | null;
  delivery_id: string;
  agent_id: string;
  target: string;
  kind: string;
  title: string | null;
  text: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  status: string | null;
  sequence: number | null;
  created_at: string;
  payload: string | unknown | null;
}

interface DeliveryArtifactRow {
  id: string;
  space_id: string | null;
  delivery_id: string;
  event_id: string | null;
  agent_id: string;
  target: string;
  kind: string;
  title: string;
  summary: string | null;
  mime: string;
  size: number | null;
  sha256: string | null;
  storage: string | null;
  path: string | null;
  relative_path: string | null;
  content: string | null;
  metadata: string | unknown | null;
  created_at: string;
}

export class SqlIteamRepository implements IteamRepository {
  constructor(private readonly db: SqlRowsAdapter) {}

  async listMessagesByTarget(query: MessageQuery): Promise<Message[]> {
    const limit = parseLimit(query.limit);
    const params: unknown[] = [query.target];
    let where = "target = ?";
    if (query.spaceId) {
      where += " AND space_id = ?";
      params.push(query.spaceId);
    }
    if (query.before) {
      const cursor = await this.findMessageCursor(query.target, query.spaceId, query.before);
      if (cursor) {
        where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
        params.push(cursor.created_at, cursor.created_at, cursor.id);
      } else {
        where += " AND (created_at < ? OR id < ?)";
        params.push(query.before, query.before);
      }
    }
    const rows = await this.db.all<MessageRow>(
      `SELECT * FROM iteam_messages WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.reverse().map(messageFromRow);
  }

  async listMessagesByChannel(query: ChannelMessageQuery): Promise<ChannelMessageResult[]> {
    const channel = await this.findChannel(query.channelId, query.spaceId);
    if (!channel) return [];
    const messages = await this.listMessagesByTarget({
      target: channel.target,
      spaceId: query.spaceId,
      limit: query.limit,
      before: query.before
    });
    const rootMessages = messages.filter(message => !message.threadId);
    const [replyRows, deliveryRows] = await Promise.all([
      rootMessages.length
        ? this.db.all<{ thread_id: string; reply_count: number }>(
            `SELECT thread_id, COUNT(*) AS reply_count
             FROM iteam_messages
             WHERE thread_id IN (${rootMessages.map(() => "?").join(",")})
             GROUP BY thread_id`,
            rootMessages.map(message => message.id)
          )
        : Promise.resolve([]),
      rootMessages.length
        ? this.db.all<Pick<DeliveryRow, "message_id" | "depth">>(
            `SELECT message_id, MIN(depth) AS depth
             FROM iteam_deliveries
             WHERE message_id IN (${rootMessages.map(() => "?").join(",")})
             GROUP BY message_id`,
            rootMessages.map(message => message.id)
          )
        : Promise.resolve([])
    ]);
    const replyCounts = new Map(replyRows.map(row => [row.thread_id, Number(row.reply_count) || 0]));
    const depths = new Map(deliveryRows.map(row => [row.message_id, row.depth ?? undefined]));
    return rootMessages.map(message => ({
      ...message,
      replyCount: replyCounts.get(message.id) || 0,
      depth: depths.get(message.id)
    }));
  }

  async listDeliveryEvents(query: DeliveryEventQuery = {}): Promise<DeliveryEvent[]> {
    const limit = parseLimit(query.limit);
    const { where, params } = filterWhere([
      ["space_id", query.spaceId],
      ["target", query.target],
      ["delivery_id", query.deliveryId]
    ]);
    const rows = await this.db.all<DeliveryEventRow>(
      `SELECT * FROM iteam_delivery_events ${where} ORDER BY created_at DESC, sequence DESC, id DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.reverse().map(deliveryEventFromRow);
  }

  async listDeliveryArtifacts(query: DeliveryArtifactQuery = {}): Promise<DeliveryArtifact[]> {
    const limit = parseLimit(query.limit);
    const { where, params } = filterWhere([
      ["space_id", query.spaceId],
      ["target", query.target],
      ["delivery_id", query.deliveryId],
      ["event_id", query.eventId]
    ]);
    const rows = await this.db.all<DeliveryArtifactRow>(
      `SELECT id, space_id, delivery_id, event_id, agent_id, target, kind, title, summary, mime, size, sha256, storage, path, relative_path, NULL AS content, metadata, created_at
       FROM iteam_delivery_artifacts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.reverse().map(deliveryArtifactFromRow);
  }

  async getDeliveryArtifact(artifactId: string, spaceId?: string | null): Promise<DeliveryArtifact | null> {
    const params: unknown[] = [artifactId];
    let where = "id = ?";
    if (spaceId) {
      where += " AND space_id = ?";
      params.push(spaceId);
    }
    const row = await this.db.get<DeliveryArtifactRow>(
      `SELECT * FROM iteam_delivery_artifacts WHERE ${where} LIMIT 1`,
      params
    );
    return row ? deliveryArtifactFromRow(row) : null;
  }

  private async findMessageCursor(target: string, spaceId: string | null | undefined, before: string): Promise<Pick<MessageRow, "id" | "created_at"> | null> {
    const escaped = escapeSqlLike(before);
    const params: unknown[] = [target, before, `${escaped}%`, `${escaped}\_%`];
    let where = "target = ? AND (id = ? OR id LIKE ? ESCAPE '~' OR id LIKE ? ESCAPE '~')";
    if (spaceId) {
      where += " AND space_id = ?";
      params.push(spaceId);
    }
    return this.db.get<Pick<MessageRow, "id" | "created_at">>(
      `SELECT id, created_at FROM iteam_messages WHERE ${where} ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC, id ASC LIMIT 1`,
      [...params, before]
    );
  }

  private async findChannel(channelIdOrTarget: string, spaceId?: string | null): Promise<Channel | null> {
    const normalizedTarget = `#${channelIdOrTarget.replace(/^#/, "")}`;
    const params: unknown[] = [channelIdOrTarget, channelIdOrTarget, normalizedTarget];
    let where = "(id = ? OR target = ? OR target = ?)";
    if (spaceId) {
      where += " AND space_id = ?";
      params.push(spaceId);
    }
    const row = await this.db.get<ChannelRow>(`SELECT * FROM iteam_channels WHERE ${where} LIMIT 1`, params);
    return row ? channelFromRow(row) : null;
  }
}

function filterWhere(filters: Array<[string, unknown]>): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of filters) {
    if (value === null || value === undefined || value === "") continue;
    clauses.push(`${column} = ?`);
    params.push(value);
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function parseLimit(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 10;
  const numeric = typeof value === "number" ? value : Number(value);
  return Math.max(1, Math.min(1000, numeric || 10));
}

function escapeSqlLike(value: string): string {
  return value.replace(/[~%_]/g, match => `~${match}`);
}

function messageFromRow(row: MessageRow): Message {
  return {
    id: row.id,
    spaceId: row.space_id || DEFAULT_SPACE_ID,
    target: row.target,
    authorId: row.author_id,
    type: row.type,
    text: row.text,
    mentions: parseJsonField<MentionRef[]>(row.mentions, []),
    createdAt: row.created_at,
    threadId: row.thread_id,
    ...(row.task_id ? { taskId: row.task_id } : {})
  };
}

function channelFromRow(row: ChannelRow): Channel {
  return {
    id: row.id,
    spaceId: row.space_id || DEFAULT_SPACE_ID,
    name: row.name,
    target: row.target,
    kind: row.kind,
    description: row.description || "",
    memberIds: row.member_ids ? String(row.member_ids).split(",").filter(Boolean) : [],
    defaultAgentId: row.default_agent_id || null,
    createdAt: row.created_at
  };
}

function deliveryEventFromRow(row: DeliveryEventRow): DeliveryEvent {
  return {
    id: row.id,
    spaceId: row.space_id || DEFAULT_SPACE_ID,
    deliveryId: row.delivery_id,
    agentId: row.agent_id,
    target: row.target,
    kind: row.kind,
    title: row.title,
    text: row.text,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    status: row.status,
    sequence: Number(row.sequence) || 0,
    createdAt: row.created_at,
    payload: parseJsonField<unknown>(row.payload, null)
  };
}

function deliveryArtifactFromRow(row: DeliveryArtifactRow): DeliveryArtifact {
  return {
    id: row.id,
    spaceId: row.space_id || DEFAULT_SPACE_ID,
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    agentId: row.agent_id,
    target: row.target,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    mime: row.mime,
    size: Number(row.size) || 0,
    sha256: row.sha256,
    storage: row.storage || "db",
    path: row.path,
    relativePath: row.relative_path,
    content: row.content,
    metadata: parseJsonField<unknown>(row.metadata, null),
    createdAt: row.created_at
  };
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}
