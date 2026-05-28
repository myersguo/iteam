import { createRequire } from "node:module";
import type {
  Agent,
  Channel,
  Computer,
  Delivery,
  Human,
  MentionRef,
  Message,
  PendingComputerConnection,
  RuntimeInfo,
  State,
  StoreEvent,
  Task
} from "../types.js";
import { BaseStore, initialState } from "./base.js";
import { MYSQL_TABLES } from "./mysql-schema.js";

const requireCjs = createRequire(import.meta.url);

interface MysqlConnection {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<[T, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

interface MysqlPool {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<[T, unknown]>;
  getConnection(): Promise<MysqlConnection>;
  end(): Promise<void>;
}

interface MysqlDriver {
  createPool(config: {
    uri?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    waitForConnections?: boolean;
    connectionLimit?: number;
  }): MysqlPool;
}

/**
 * MySQL backend, P1+P2 implementation.
 *
 * Persists State across 10 normalized tables (see ./mysql-schema.ts):
 *   humans, computers, pending_connections, agents, channels,
 *   channel_members, messages, tasks, deliveries, events.
 *
 * Load rebuilds State from these tables. Persist serializes the in-memory
 * State back to them inside a single transaction (full wipe+reinsert per
 * table). This preserves BaseStore's coarse-grained semantics so the rest of
 * the daemon (mutate/snapshot/emit) doesn't need to know.
 *
 * Because BaseStore.persist is synchronous, writes are queued in a serial
 * promise chain. The constructor blocks via prepare() (called from factory).
 *
 * Requires `mysql2` to be installed when ITEAM_STORE=mysql.
 */
export class MysqlStore extends BaseStore {
  private pool!: MysqlPool;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(home: string) {
    super(home);
    // pool / load are deferred until prepare() — see store/factory.ts.
  }

  /**
   * Async initializer. Must be awaited before the store is used.
   */
  async prepare(): Promise<void> {
    let driver: MysqlDriver;
    try {
      const mod = requireCjs("mysql2/promise") as MysqlDriver | { default: MysqlDriver };
      driver = (mod as { default?: MysqlDriver }).default || (mod as MysqlDriver);
    } catch (error) {
      throw new Error(
        "ITEAM_STORE=mysql requires the optional 'mysql2' package. " +
          "Install it with: npm install mysql2"
      );
    }

    const url = process.env.ITEAM_MYSQL_URL;
    this.pool = url
      ? driver.createPool({ uri: url, waitForConnections: true, connectionLimit: 4 })
      : driver.createPool({
          host: process.env.ITEAM_MYSQL_HOST || "127.0.0.1",
          port: Number(process.env.ITEAM_MYSQL_PORT || 3306),
          user: process.env.ITEAM_MYSQL_USER || "root",
          password: process.env.ITEAM_MYSQL_PASSWORD || "",
          database: process.env.ITEAM_MYSQL_DATABASE || "iteam",
          waitForConnections: true,
          connectionLimit: 4
        });

    for (const table of MYSQL_TABLES) {
      await this.pool.query(table.ddl);
    }

    await this.runColumnMigrations();

    const loaded = await this.loadFromTables();
    this.setStateAfterLoad(loaded);
  }

  /**
   * Additive schema migrations for tables created by older daemon versions.
   * Each step is idempotent: it checks information_schema before running ALTER.
   */
  private async runColumnMigrations(): Promise<void> {
    await this.addColumnIfMissing(
      "iteam_computers",
      "connect_token",
      "VARCHAR(128) DEFAULT NULL"
    );
  }

  private async addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
    const [rows] = await this.pool.query<Array<{ c: number }>>(
      "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, column]
    );
    const exists = Array.isArray(rows) && rows[0] && Number(rows[0].c) > 0;
    if (exists) return;
    await this.pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }

  // ---------------------------------------------------------------------------
  // Load: rebuild State from the 10 tables
  // ---------------------------------------------------------------------------
  private async loadFromTables(): Promise<State> {
    const seed = initialState();

    const [humanRows] = await this.pool.query<Array<{
      id: string;
      name: string;
      handle: string;
      role: string | null;
    }>>("SELECT id, name, handle, role FROM iteam_humans");

    const [computerRows] = await this.pool.query<Array<{
      id: string;
      name: string;
      fingerprint_id: string;
      fingerprint_hostname: string;
      fingerprint_os: string;
      fingerprint_arch: string;
      status: string;
      daemon_version: string;
      runtimes: string | RuntimeInfo[];
      agent_ids: string | string[];
      connection_id: string;
      connect_token: string | null;
      created_at: string;
      first_connected_at: string | null;
      last_seen_at: string | null;
    }>>("SELECT * FROM iteam_computers");

    const [pendingRows] = await this.pool.query<Array<{
      id: string;
      token: string;
      status: string;
      created_at: string;
      connected_computer_id: string | null;
      label: string | null;
      connected_at: string | null;
    }>>("SELECT * FROM iteam_pending_connections");

    const [agentRows] = await this.pool.query<Array<{
      id: string;
      name: string;
      handle: string;
      description: string;
      runtime: string;
      model: string;
      reasoning: string | null;
      computer_id: string;
      status: string;
      desired_status: string;
      launch_id: string | null;
      pid: number | null;
      workspace_path: string;
      created_at: string;
      updated_at: string;
      env: string | Record<string, string> | null;
      last_started_at: string | null;
      last_runtime_status: string | Record<string, unknown> | null;
    }>>("SELECT * FROM iteam_agents");

    const [channelRows] = await this.pool.query<Array<{
      id: string;
      name: string;
      target: string;
      kind: string;
      description: string | null;
      created_at: string;
    }>>("SELECT * FROM iteam_channels");

    const [memberRows] = await this.pool.query<Array<{
      channel_id: string;
      member_id: string;
    }>>("SELECT channel_id, member_id FROM iteam_channel_members");

    const [messageRows] = await this.pool.query<Array<{
      id: string;
      target: string;
      author_id: string;
      type: string;
      text: string;
      mentions: string | MentionRef[];
      created_at: string;
      thread_id: string | null;
      task_id: string | null;
    }>>("SELECT * FROM iteam_messages ORDER BY created_at ASC");

    const [taskRows] = await this.pool.query<Array<{
      id: string;
      number: number;
      target: string;
      title: string;
      description: string;
      status: string;
      assignee_id: string | null;
      created_by: string;
      message_id: string;
      thread_target: string;
      created_at: string;
      updated_at: string;
    }>>("SELECT * FROM iteam_tasks ORDER BY number ASC");

    const [deliveryRows] = await this.pool.query<Array<{
      id: string;
      message_id: string;
      root_message_id: string;
      parent_delivery_id: string | null;
      depth: number;
      agent_id: string;
      computer_id: string;
      target: string;
      status: string;
      attempts: number;
      created_at: string;
      updated_at: string;
      error: string | null;
    }>>("SELECT * FROM iteam_deliveries ORDER BY created_at ASC");

    const [eventRows] = await this.pool.query<Array<{
      id: string;
      type: string;
      payload: string | unknown;
      created_at: string;
    }>>("SELECT * FROM iteam_events ORDER BY created_at ASC LIMIT 500");

    const humans: Human[] = humanRows.map(row => ({
      id: row.id,
      name: row.name,
      handle: row.handle,
      ...(row.role ? { role: row.role } : {})
    }));

    const channelMemberMap = new Map<string, string[]>();
    for (const row of memberRows) {
      const list = channelMemberMap.get(row.channel_id) || [];
      list.push(row.member_id);
      channelMemberMap.set(row.channel_id, list);
    }

    const computers: Computer[] = computerRows.map(row => ({
      id: row.id,
      name: row.name,
      fingerprint: {
        id: row.fingerprint_id,
        hostname: row.fingerprint_hostname,
        os: row.fingerprint_os,
        arch: row.fingerprint_arch
      },
      status: row.status,
      daemonVersion: row.daemon_version,
      runtimes: parseJsonField<RuntimeInfo[]>(row.runtimes, []),
      agentIds: parseJsonField<string[]>(row.agent_ids, []),
      connectionId: row.connection_id,
      ...(row.connect_token ? { connectToken: row.connect_token } : {}),
      createdAt: row.created_at,
      ...(row.first_connected_at ? { firstConnectedAt: row.first_connected_at } : {}),
      ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {})
    }));

    const pendingComputerConnections: PendingComputerConnection[] = pendingRows.map(row => ({
      id: row.id,
      token: row.token,
      status: row.status,
      createdAt: row.created_at,
      connectedComputerId: row.connected_computer_id,
      label: row.label || "",
      ...(row.connected_at ? { connectedAt: row.connected_at } : {})
    }));

    const agents: Agent[] = agentRows.map(row => ({
      id: row.id,
      name: row.name,
      handle: row.handle,
      description: row.description,
      runtime: row.runtime as Agent["runtime"],
      model: row.model,
      ...(row.reasoning ? { reasoning: row.reasoning } : {}),
      computerId: row.computer_id,
      status: row.status,
      desiredStatus: row.desired_status as Agent["desiredStatus"],
      launchId: row.launch_id,
      pid: row.pid,
      workspacePath: row.workspace_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      env: parseJsonField<Record<string, string>>(row.env, {}),
      ...(row.last_started_at ? { lastStartedAt: row.last_started_at } : {}),
      ...(row.last_runtime_status
        ? { lastRuntimeStatus: parseJsonField<Record<string, unknown>>(row.last_runtime_status, {}) }
        : {})
    }));

    const channels: Channel[] = channelRows.map(row => ({
      id: row.id,
      name: row.name,
      target: row.target,
      kind: row.kind,
      description: row.description || "",
      memberIds: channelMemberMap.get(row.id) || [],
      createdAt: row.created_at
    }));

    const messages: Message[] = messageRows.map(row => ({
      id: row.id,
      target: row.target,
      authorId: row.author_id,
      type: row.type,
      text: row.text,
      mentions: parseJsonField<MentionRef[]>(row.mentions, []),
      createdAt: row.created_at,
      threadId: row.thread_id,
      ...(row.task_id ? { taskId: row.task_id } : {})
    }));

    const tasks: Task[] = taskRows.map(row => ({
      id: row.id,
      number: row.number,
      target: row.target,
      title: row.title,
      description: row.description,
      status: row.status,
      assigneeId: row.assignee_id,
      createdBy: row.created_by,
      messageId: row.message_id,
      threadTarget: row.thread_target,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    const deliveries: Delivery[] = deliveryRows.map(row => ({
      id: row.id,
      messageId: row.message_id,
      rootMessageId: row.root_message_id,
      parentDeliveryId: row.parent_delivery_id,
      depth: row.depth,
      agentId: row.agent_id,
      computerId: row.computer_id,
      target: row.target,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      error: row.error
    }));

    const events: StoreEvent[] = eventRows.map(row => ({
      id: row.id,
      type: row.type,
      payload: parseJsonField<unknown>(row.payload, null),
      createdAt: row.created_at
    }));

    // Fall back to seed defaults when the database is empty (first run).
    return {
      meta: seed.meta,
      computers,
      pendingComputerConnections,
      humans: humans.length ? humans : seed.humans,
      agents,
      channels: channels.length ? channels : seed.channels,
      messages,
      deliveries,
      tasks,
      events
    };
  }

  // ---------------------------------------------------------------------------
  // Persist: synchronize the entire State to the 10 tables in one transaction.
  // ---------------------------------------------------------------------------
  protected persist(state: State): void {
    const snapshot = JSON.parse(JSON.stringify(state)) as State;
    this.writeChain = this.writeChain
      .then(() => this.writeSnapshot(snapshot))
      .catch(error => {
        console.error("[mysql-store] persist failed:", (error as Error).message);
      });
  }

  private async writeSnapshot(state: State): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query("DELETE FROM iteam_humans");
      if (state.humans.length) {
        await conn.query(
          "INSERT INTO iteam_humans (id, name, handle, role) VALUES ?",
          [state.humans.map(h => [h.id, h.name, h.handle, h.role ?? null])]
        );
      }

      await conn.query("DELETE FROM iteam_computers");
      if (state.computers.length) {
        await conn.query(
          "INSERT INTO iteam_computers (id, name, fingerprint_id, fingerprint_hostname, fingerprint_os, fingerprint_arch, status, daemon_version, runtimes, agent_ids, connection_id, connect_token, created_at, first_connected_at, last_seen_at) VALUES ?",
          [
            state.computers.map(c => [
              c.id,
              c.name,
              c.fingerprint.id,
              c.fingerprint.hostname,
              c.fingerprint.os,
              c.fingerprint.arch,
              c.status,
              c.daemonVersion,
              JSON.stringify(c.runtimes || []),
              JSON.stringify(c.agentIds || []),
              c.connectionId,
              c.connectToken ?? null,
              c.createdAt,
              c.firstConnectedAt ?? null,
              c.lastSeenAt ?? null
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_pending_connections");
      if (state.pendingComputerConnections.length) {
        await conn.query(
          "INSERT INTO iteam_pending_connections (id, token, status, created_at, connected_computer_id, label, connected_at) VALUES ?",
          [
            state.pendingComputerConnections.map(p => [
              p.id,
              p.token,
              p.status,
              p.createdAt,
              p.connectedComputerId,
              p.label ?? null,
              p.connectedAt ?? null
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_agents");
      if (state.agents.length) {
        await conn.query(
          "INSERT INTO iteam_agents (id, name, handle, description, runtime, model, reasoning, computer_id, status, desired_status, launch_id, pid, workspace_path, created_at, updated_at, env, last_started_at, last_runtime_status) VALUES ?",
          [
            state.agents.map(a => [
              a.id,
              a.name,
              a.handle,
              a.description,
              a.runtime,
              a.model,
              a.reasoning ?? null,
              a.computerId,
              a.status,
              a.desiredStatus,
              a.launchId,
              a.pid,
              a.workspacePath,
              a.createdAt,
              a.updatedAt,
              JSON.stringify(a.env || {}),
              a.lastStartedAt ?? null,
              a.lastRuntimeStatus ? JSON.stringify(a.lastRuntimeStatus) : null
            ])
          ]
        );
      }

      // channels + channel_members are linked, so wipe both before inserting.
      await conn.query("DELETE FROM iteam_channel_members");
      await conn.query("DELETE FROM iteam_channels");
      if (state.channels.length) {
        await conn.query(
          "INSERT INTO iteam_channels (id, name, target, kind, description, created_at) VALUES ?",
          [
            state.channels.map(c => [
              c.id,
              c.name,
              c.target,
              c.kind,
              c.description ?? null,
              c.createdAt
            ])
          ]
        );
        const memberRows: Array<[string, string]> = [];
        for (const channel of state.channels) {
          for (const memberId of channel.memberIds || []) {
            memberRows.push([channel.id, memberId]);
          }
        }
        if (memberRows.length) {
          await conn.query(
            "INSERT INTO iteam_channel_members (channel_id, member_id) VALUES ?",
            [memberRows]
          );
        }
      }

      await conn.query("DELETE FROM iteam_messages");
      if (state.messages.length) {
        await conn.query(
          "INSERT INTO iteam_messages (id, target, author_id, type, text, mentions, created_at, thread_id, task_id) VALUES ?",
          [
            state.messages.map(m => [
              m.id,
              m.target,
              m.authorId,
              m.type,
              m.text,
              JSON.stringify(m.mentions || []),
              m.createdAt,
              m.threadId,
              m.taskId ?? null
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_tasks");
      if (state.tasks.length) {
        await conn.query(
          "INSERT INTO iteam_tasks (id, number, target, title, description, status, assignee_id, created_by, message_id, thread_target, created_at, updated_at) VALUES ?",
          [
            state.tasks.map(t => [
              t.id,
              t.number,
              t.target,
              t.title,
              t.description,
              t.status,
              t.assigneeId,
              t.createdBy,
              t.messageId,
              t.threadTarget,
              t.createdAt,
              t.updatedAt
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_deliveries");
      if (state.deliveries.length) {
        await conn.query(
          "INSERT INTO iteam_deliveries (id, message_id, root_message_id, parent_delivery_id, depth, agent_id, computer_id, target, status, attempts, created_at, updated_at, error) VALUES ?",
          [
            state.deliveries.map(d => [
              d.id,
              d.messageId,
              d.rootMessageId,
              d.parentDeliveryId,
              d.depth,
              d.agentId,
              d.computerId,
              d.target,
              d.status,
              d.attempts,
              d.createdAt,
              d.updatedAt,
              d.error ?? null
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_events");
      if (state.events.length) {
        await conn.query(
          "INSERT INTO iteam_events (id, type, payload, created_at) VALUES ?",
          [
            state.events.map(e => [
              e.id,
              e.type,
              JSON.stringify(e.payload ?? null),
              e.createdAt
            ])
          ]
        );
      }

      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> {
    await this.writeChain;
    await this.pool.end();
  }
}

/**
 * mysql2 returns JSON columns either as already-parsed objects (default) or as
 * raw strings depending on driver options. Normalize both shapes here.
 */
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
