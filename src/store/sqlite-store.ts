import { join } from "node:path";
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
import { BaseStore, initialState, sanitizeState } from "./base.js";
import { SQLITE_INDEXES, SQLITE_TABLES } from "./sqlite-schema.js";

const requireCjs = createRequire(import.meta.url);

interface SqliteStatement {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(pragma: string): unknown;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  close(): void;
}

interface BetterSqlite3Ctor {
  new (path: string): SqliteDatabase;
}

/**
 * SQLite backend, P1+P2 implementation.
 *
 * Mirrors MysqlStore: 10 normalized tables (see ./sqlite-schema.ts), full
 * State rebuild on load, full transactional rewrite on persist. Synchronous
 * because better-sqlite3 is synchronous, so persist() is naturally atomic
 * with mutate().
 *
 * On startup, migrates a legacy single-row `state` table into the new schema
 * if found, then drops it.
 *
 * Requires `better-sqlite3` to be installed when ITEAM_STORE=sqlite.
 */
export class SqliteStore extends BaseStore {
  private db: SqliteDatabase;
  private writeAll: (state: State) => void;

  constructor(home: string, file?: string) {
    super(home);
    let BetterSqlite3: BetterSqlite3Ctor;
    try {
      BetterSqlite3 = requireCjs("better-sqlite3") as BetterSqlite3Ctor;
    } catch (error) {
      throw new Error(
        "ITEAM_STORE=sqlite requires the optional 'better-sqlite3' package. " +
          "Install it with: npm install better-sqlite3"
      );
    }
    const dbFile = file || process.env.ITEAM_SQLITE_FILE || join(home, "state.db");
    this.db = new BetterSqlite3(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    for (const ddl of SQLITE_TABLES) this.db.exec(ddl);
    for (const idx of SQLITE_INDEXES) this.db.exec(idx);
    this.runColumnMigrations();

    // Compose the transactional writer once; reused on every persist().
    this.writeAll = this.db.transaction((s: State) => this.writeAllUnwrapped(s));

    const migrated = this.migrateLegacyStateTable();
    const loaded = migrated ?? this.loadFromTables();
    this.setStateAfterLoad(loaded);
  }

  // ---------------------------------------------------------------------------
  // In-place additive column migrations for tables that pre-date a column.
  // SQLite's ALTER TABLE ADD COLUMN is fine for our nullable columns; running
  // it twice raises "duplicate column" which we swallow.
  // ---------------------------------------------------------------------------
  private runColumnMigrations(): void {
    this.addColumnIfMissing("iteam_computers", "connect_token", "TEXT");
    this.migrateAgentsModelNullable();
  }

  // SQLite doesn't support ALTER COLUMN to drop NOT NULL; rebuild the table.
  private migrateAgentsModelNullable(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(iteam_agents)`)
      .all() as Array<{ name: string; notnull: number }>;
    const modelCol = cols.find(c => c.name === "model");
    if (!modelCol || modelCol.notnull === 0) return; // already nullable
    console.log("[sqlite] migrating iteam_agents.model to nullable...");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS iteam_agents_new (
        id                  TEXT NOT NULL PRIMARY KEY,
        name                TEXT NOT NULL,
        handle              TEXT NOT NULL,
        description         TEXT NOT NULL,
        runtime             TEXT NOT NULL,
        model               TEXT,
        reasoning           TEXT,
        computer_id         TEXT NOT NULL,
        status              TEXT NOT NULL,
        desired_status      TEXT NOT NULL,
        launch_id           TEXT,
        pid                 INTEGER,
        workspace_path      TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        env                 TEXT,
        last_started_at     TEXT,
        last_runtime_status TEXT
      )
    `);
    this.db.exec(`
      INSERT INTO iteam_agents_new
      SELECT id, name, handle, description, runtime, model, reasoning, computer_id,
             status, desired_status, launch_id, pid, workspace_path, created_at,
             updated_at, env, last_started_at, last_runtime_status
      FROM iteam_agents
    `);
    this.db.exec(`DROP TABLE iteam_agents`);
    this.db.exec(`ALTER TABLE iteam_agents_new RENAME TO iteam_agents`);
    console.log("[sqlite] iteam_agents.model migration complete");
  }

  private addColumnIfMissing(table: string, column: string, ddlType: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (cols.some(c => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }

  // ---------------------------------------------------------------------------
  // Legacy migration: detect old `state(id, document, updated_at)` table,
  // import its document into the new tables, then drop it.
  // ---------------------------------------------------------------------------
  private migrateLegacyStateTable(): State | null {
    const legacy = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='state'"
      )
      .get() as { name?: string } | undefined;
    if (!legacy?.name) return null;

    const row = this.db
      .prepare("SELECT document FROM state WHERE id = 1")
      .get() as { document?: string } | undefined;

    if (!row?.document) {
      this.db.exec("DROP TABLE state");
      return null;
    }

    let parsed: State;
    try {
      parsed = JSON.parse(row.document) as State;
    } catch (error) {
      console.error("[sqlite-store] legacy state document is not valid JSON, skipping migration");
      return null;
    }

    // Write the legacy state into the new schema, then drop the old table.
    this.writeAll(sanitizeState(parsed));
    this.db.exec("DROP TABLE state");
    console.log("[sqlite-store] migrated legacy state table → 10 normalized tables");
    return parsed;
  }

  // ---------------------------------------------------------------------------
  // Load: rebuild State from the 10 tables
  // ---------------------------------------------------------------------------
  private loadFromTables(): State {
    const seed = initialState();

    const humanRows = this.db
      .prepare("SELECT id, name, handle, role FROM iteam_humans")
      .all() as Array<{ id: string; name: string; handle: string; role: string | null }>;

    const computerRows = this.db.prepare("SELECT * FROM iteam_computers").all() as Array<{
      id: string;
      name: string;
      fingerprint_id: string;
      fingerprint_hostname: string;
      fingerprint_os: string;
      fingerprint_arch: string;
      status: string;
      daemon_version: string;
      runtimes: string;
      agent_ids: string;
      connection_id: string;
      connect_token: string | null;
      created_at: string;
      first_connected_at: string | null;
      last_seen_at: string | null;
    }>;

    const pendingRows = this.db.prepare("SELECT * FROM iteam_pending_connections").all() as Array<{
      id: string;
      token: string;
      status: string;
      created_at: string;
      connected_computer_id: string | null;
      label: string | null;
      connected_at: string | null;
    }>;

    const agentRows = this.db.prepare("SELECT * FROM iteam_agents").all() as Array<{
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
      env: string | null;
      last_started_at: string | null;
      last_runtime_status: string | null;
    }>;

    const channelRows = this.db.prepare("SELECT * FROM iteam_channels").all() as Array<{
      id: string;
      name: string;
      target: string;
      kind: string;
      description: string | null;
      created_at: string;
    }>;

    const memberRows = this.db
      .prepare("SELECT channel_id, member_id FROM iteam_channel_members")
      .all() as Array<{ channel_id: string; member_id: string }>;

    const messageRows = this.db
      .prepare("SELECT * FROM iteam_messages ORDER BY created_at ASC")
      .all() as Array<{
        id: string;
        target: string;
        author_id: string;
        type: string;
        text: string;
        mentions: string;
        created_at: string;
        thread_id: string | null;
        task_id: string | null;
      }>;

    const taskRows = this.db
      .prepare("SELECT * FROM iteam_tasks ORDER BY number ASC")
      .all() as Array<{
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
      }>;

    const deliveryRows = this.db
      .prepare("SELECT * FROM iteam_deliveries ORDER BY created_at ASC")
      .all() as Array<{
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
      }>;

    const eventRows = this.db
      .prepare("SELECT * FROM iteam_events ORDER BY created_at ASC LIMIT 500")
      .all() as Array<{ id: string; type: string; payload: string; created_at: string }>;

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
  // Persist: synchronous, atomic via better-sqlite3 transaction()
  // ---------------------------------------------------------------------------
  protected persist(state: State): void {
    this.writeAll(state);
  }

  private writeAllUnwrapped(state: State): void {
    this.db.exec("DELETE FROM iteam_humans");
    if (state.humans.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_humans (id, name, handle, role) VALUES (?, ?, ?, ?)"
      );
      for (const h of state.humans) stmt.run(h.id, h.name, h.handle, h.role ?? null);
    }

    this.db.exec("DELETE FROM iteam_computers");
    if (state.computers.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_computers (id, name, fingerprint_id, fingerprint_hostname, fingerprint_os, fingerprint_arch, status, daemon_version, runtimes, agent_ids, connection_id, connect_token, created_at, first_connected_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const c of state.computers) {
        stmt.run(
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
        );
      }
    }

    this.db.exec("DELETE FROM iteam_pending_connections");
    if (state.pendingComputerConnections.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_pending_connections (id, token, status, created_at, connected_computer_id, label, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const p of state.pendingComputerConnections) {
        stmt.run(
          p.id,
          p.token,
          p.status,
          p.createdAt,
          p.connectedComputerId,
          p.label ?? null,
          p.connectedAt ?? null
        );
      }
    }

    this.db.exec("DELETE FROM iteam_agents");
    if (state.agents.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_agents (id, name, handle, description, runtime, model, reasoning, computer_id, status, desired_status, launch_id, pid, workspace_path, created_at, updated_at, env, last_started_at, last_runtime_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const a of state.agents) {
        stmt.run(
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
        );
      }
    }

    this.db.exec("DELETE FROM iteam_channel_members");
    this.db.exec("DELETE FROM iteam_channels");
    if (state.channels.length) {
      const channelStmt = this.db.prepare(
        "INSERT INTO iteam_channels (id, name, target, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const memberStmt = this.db.prepare(
        "INSERT INTO iteam_channel_members (channel_id, member_id) VALUES (?, ?)"
      );
      for (const channel of state.channels) {
        channelStmt.run(
          channel.id,
          channel.name,
          channel.target,
          channel.kind,
          channel.description ?? null,
          channel.createdAt
        );
        for (const memberId of channel.memberIds || []) {
          memberStmt.run(channel.id, memberId);
        }
      }
    }

    this.db.exec("DELETE FROM iteam_messages");
    if (state.messages.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_messages (id, target, author_id, type, text, mentions, created_at, thread_id, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const m of state.messages) {
        stmt.run(
          m.id,
          m.target,
          m.authorId,
          m.type,
          m.text,
          JSON.stringify(m.mentions || []),
          m.createdAt,
          m.threadId,
          m.taskId ?? null
        );
      }
    }

    this.db.exec("DELETE FROM iteam_tasks");
    if (state.tasks.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_tasks (id, number, target, title, description, status, assignee_id, created_by, message_id, thread_target, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const t of state.tasks) {
        stmt.run(
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
        );
      }
    }

    this.db.exec("DELETE FROM iteam_deliveries");
    if (state.deliveries.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_deliveries (id, message_id, root_message_id, parent_delivery_id, depth, agent_id, computer_id, target, status, attempts, created_at, updated_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const d of state.deliveries) {
        stmt.run(
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
        );
      }
    }

    this.db.exec("DELETE FROM iteam_events");
    if (state.events.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_events (id, type, payload, created_at) VALUES (?, ?, ?, ?)"
      );
      for (const e of state.events) {
        stmt.run(e.id, e.type, JSON.stringify(e.payload ?? null), e.createdAt);
      }
    }
  }

  close(): void {
    this.db.close();
  }
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
