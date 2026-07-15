import { createRequire } from "node:module";
import type {
  Agent,
  Channel,
  Computer,
  Delivery,
  ExternalBotBinding,
  ExternalBotConfig,
  ExternalIngressPairing,
  ExternalIngressPolicy,
  ExternalMessageLink,
  Human,
  MentionRef,
  Message,
  PendingComputerConnection,
  RuntimeInfo,
  ScheduledTask,
  Space,
  State,
  StoreEvent,
  Task
} from "../types.js";
import { nowIso } from "../lib.js";
import { BaseStore, DEFAULT_SPACE_ID, initialState } from "./base.js";
import { MYSQL_TABLES } from "./mysql-schema.js";

const requireCjs = createRequire(import.meta.url);

export interface MysqlIndexColumn {
  INDEX_NAME: string;
  COLUMN_NAME: string;
  SEQ_IN_INDEX: number;
  NON_UNIQUE: number;
}

export function planMysqlChannelUniqueMigration(rows: MysqlIndexColumn[]): {
  legacyIndexNames: string[];
  hasSpaceTarget: boolean;
} {
  const uniqueIndexes = new Map<string, Array<{ column: string; position: number }>>();
  for (const row of rows || []) {
    if (Number(row.NON_UNIQUE) !== 0 || row.INDEX_NAME === "PRIMARY") continue;
    const columns = uniqueIndexes.get(row.INDEX_NAME) || [];
    columns.push({ column: row.COLUMN_NAME, position: Number(row.SEQ_IN_INDEX) });
    uniqueIndexes.set(row.INDEX_NAME, columns);
  }
  const normalized = Array.from(uniqueIndexes.entries()).map(([name, columns]) => ({
    name,
    columns: columns
      .sort((left, right) => left.position - right.position)
      .map(item => item.column)
  }));
  return {
    hasSpaceTarget: normalized.some(index => index.columns.join(",") === "space_id,target"),
    legacyIndexNames: normalized
      .filter(index => index.columns.join(",") === "target")
      .map(index => index.name)
  };
}

export const MYSQL_SPACE_BACKFILL_QUERIES = [
  `UPDATE iteam_channels channel_row
   LEFT JOIN iteam_agents default_agent ON default_agent.id = channel_row.default_agent_id
   LEFT JOIN (
     SELECT
       member.channel_id,
       MIN(agent.space_id) AS space_id,
       COUNT(DISTINCT agent.space_id) AS space_count
     FROM iteam_channel_members member
     INNER JOIN iteam_agents agent ON agent.id = member.member_id
     GROUP BY member.channel_id
   ) member_space ON member_space.channel_id = channel_row.id
   SET channel_row.space_id = CASE
     WHEN member_space.space_count > 1 THEN channel_row.space_id
     WHEN default_agent.space_id IS NOT NULL
      AND member_space.space_id IS NOT NULL
      AND default_agent.space_id <> member_space.space_id
       THEN channel_row.space_id
     ELSE COALESCE(default_agent.space_id, member_space.space_id, channel_row.space_id)
   END
   WHERE channel_row.space_id = 'space_default'`,
  `UPDATE iteam_deliveries delivery
   LEFT JOIN iteam_agents agent ON agent.id = delivery.agent_id
   SET delivery.space_id = COALESCE(
     NULLIF(agent.space_id, ''),
     NULLIF(delivery.space_id, 'space_default'),
     'space_default'
   )
   WHERE delivery.space_id = 'space_default'`,
  `UPDATE iteam_messages message
   LEFT JOIN (
     SELECT
       message_id,
       MIN(space_id) AS space_id,
       COUNT(DISTINCT space_id) AS space_count
     FROM iteam_deliveries
     GROUP BY message_id
   ) delivery ON delivery.message_id = message.id
   LEFT JOIN iteam_agents agent ON agent.id = message.author_id
   LEFT JOIN (
     SELECT
       target,
       MIN(space_id) AS space_id,
       COUNT(DISTINCT space_id) AS space_count
     FROM iteam_channels
     GROUP BY target
   ) channel_space ON channel_space.target = message.target
   SET message.space_id = CASE
     WHEN delivery.space_count > 1 OR channel_space.space_count > 1 THEN message.space_id
     WHEN agent.space_id IS NOT NULL
      AND delivery.space_id IS NOT NULL
      AND agent.space_id <> delivery.space_id
       THEN message.space_id
     WHEN agent.space_id IS NOT NULL
      AND channel_space.space_id IS NOT NULL
      AND agent.space_id <> channel_space.space_id
       THEN message.space_id
     WHEN delivery.space_id IS NOT NULL
      AND channel_space.space_id IS NOT NULL
      AND delivery.space_id <> channel_space.space_id
       THEN message.space_id
     ELSE COALESCE(agent.space_id, delivery.space_id, channel_space.space_id, message.space_id)
   END
   WHERE message.space_id = 'space_default'`,
  `UPDATE iteam_messages message
   INNER JOIN iteam_agents agent ON agent.id = message.author_id
   SET message.type = 'agent'
   WHERE message.type = 'human'`,
  `UPDATE iteam_tasks task
   LEFT JOIN iteam_agents agent ON agent.id = task.assignee_id
   LEFT JOIN iteam_messages message ON message.id = task.message_id
   SET task.space_id = CASE
     WHEN NULLIF(message.space_id, 'space_default') IS NOT NULL
      AND NULLIF(agent.space_id, 'space_default') IS NOT NULL
      AND message.space_id <> agent.space_id
       THEN task.space_id
     ELSE COALESCE(
       NULLIF(message.space_id, 'space_default'),
       NULLIF(agent.space_id, 'space_default'),
       task.space_id
     )
   END
   WHERE task.space_id = 'space_default'`,
  `UPDATE iteam_scheduled_tasks scheduled
   LEFT JOIN iteam_agents agent ON agent.id = scheduled.agent_id
   SET scheduled.space_id = COALESCE(
     NULLIF(agent.space_id, ''),
     NULLIF(scheduled.space_id, 'space_default'),
     'space_default'
   )
   WHERE scheduled.space_id = 'space_default'`
] as const;

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
    await this.addColumnIfMissing(
      "iteam_computers",
      "space_id",
      "VARCHAR(64) NOT NULL DEFAULT 'space_default'"
    );
    await this.addColumnIfMissing(
      "iteam_pending_connections",
      "space_id",
      "VARCHAR(64) NOT NULL DEFAULT 'space_default'"
    );
    await this.addColumnIfMissing(
      "iteam_agents",
      "space_id",
      "VARCHAR(64) NOT NULL DEFAULT 'space_default'"
    );
    await this.addColumnIfMissing(
      "iteam_messages",
      "space_id",
      "VARCHAR(64) NOT NULL DEFAULT 'space_default'"
    );
    await this.addColumnIfMissing(
      "iteam_tasks",
      "space_id",
      "VARCHAR(64) NOT NULL DEFAULT 'space_default'"
    );
    await this.addColumnIfMissing(
      "iteam_scheduled_tasks",
      "space_id",
      "VARCHAR(64) NOT NULL DEFAULT 'space_default'"
    );
    await this.addColumnIfMissing(
      "iteam_deliveries",
      "space_id",
      "VARCHAR(64) NOT NULL DEFAULT 'space_default'"
    );
    await this.addColumnIfMissing(
      "iteam_scheduled_tasks",
      "cron_expression",
      "VARCHAR(255) DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_scheduled_tasks",
      "timezone",
      "VARCHAR(128) DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_scheduled_tasks",
      "session_key",
      "VARCHAR(255) DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_deliveries",
      "session_key",
      "VARCHAR(255) DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_deliveries",
      "source",
      "VARCHAR(64) DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_deliveries",
      "lifecycle",
      "JSON DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_external_bot_configs",
      "alias",
      "VARCHAR(128) DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_external_bot_configs",
      "status",
      "VARCHAR(32) DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_external_bot_configs",
      "status_message",
      "VARCHAR(255) DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_external_bot_configs",
      "last_connected_at",
      "VARCHAR(40) DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_channels",
      "default_agent_id",
      "VARCHAR(64) DEFAULT NULL"
    );
    await this.addColumnIfMissing(
      "iteam_channels",
      "space_id",
      "VARCHAR(64) NOT NULL DEFAULT 'space_default'"
    );
    await this.runSpaceBackfillMigration();
    await this.migrateChannelsUniqueSpaceTarget();
    await this.migrateAgentsModelNullable();
  }

  private async migrateChannelsUniqueSpaceTarget(): Promise<void> {
    const [rows] = await this.pool.query<MysqlIndexColumn[]>(
      `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'iteam_channels'
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`
    );
    const plan = planMysqlChannelUniqueMigration(rows);
    if (!plan.hasSpaceTarget) {
      await this.pool.query(
        "ALTER TABLE iteam_channels ADD UNIQUE KEY uniq_space_target (space_id, target)"
      );
    }
    for (const indexName of plan.legacyIndexNames) {
      await this.pool.query(`ALTER TABLE iteam_channels DROP INDEX \`${escapeMysqlIdentifier(indexName)}\``);
    }
  }

  private async runSpaceBackfillMigration(): Promise<void> {
    const migrationName = "space_backfill_v1";
    const [rows] = await this.pool.query<Array<{ applied: number }>>(
      "SELECT 1 AS applied FROM iteam_schema_migrations WHERE name = ?",
      [migrationName]
    );
    if (Array.isArray(rows) && rows.length > 0) return;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.backfillEntitySpaceIds(connection);
      await this.backfillMissingSpaces(connection);
      await connection.query(
        "INSERT INTO iteam_schema_migrations (name, applied_at) VALUES (?, ?)",
        [migrationName, nowIso()]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async backfillEntitySpaceIds(connection: MysqlConnection): Promise<void> {
    for (const query of MYSQL_SPACE_BACKFILL_QUERIES) {
      await connection.query(query);
    }
  }

  private async backfillMissingSpaces(connection: MysqlConnection): Promise<void> {
    const [rows] = await connection.query<Array<{ space_id: string | null }>>(
      `SELECT DISTINCT space_id FROM (
         SELECT space_id FROM iteam_computers
         UNION ALL SELECT space_id FROM iteam_pending_connections
         UNION ALL SELECT space_id FROM iteam_agents
         UNION ALL SELECT space_id FROM iteam_channels
         UNION ALL SELECT space_id FROM iteam_messages
         UNION ALL SELECT space_id FROM iteam_tasks
         UNION ALL SELECT space_id FROM iteam_scheduled_tasks
         UNION ALL SELECT space_id FROM iteam_deliveries
       ) entity_spaces
       WHERE space_id IS NOT NULL AND space_id <> ''`
    );
    const [existingRows] = await connection.query<Array<{ id: string; slug: string }>>(
      "SELECT id, slug FROM iteam_spaces"
    );
    const existing = new Set((existingRows || []).map(row => row.id));
    const existingSlugs = new Set((existingRows || []).map(row => row.slug));
    const now = nowIso();
    for (const row of rows || []) {
      const id = String(row.space_id || "").trim();
      if (!id || existing.has(id)) continue;
      const isDefault = id === DEFAULT_SPACE_ID;
      const baseSlug = (isDefault ? "default" : id).slice(0, 64);
      let slug = baseSlug;
      let suffix = 2;
      while (existingSlugs.has(slug)) {
        const suffixText = `-${suffix++}`;
        slug = `${baseSlug.slice(0, 64 - suffixText.length)}${suffixText}`;
      }
      await connection.query(
        `INSERT INTO iteam_spaces
         (id, name, slug, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          isDefault ? "Default" : id,
          slug,
          isDefault ? "Default iTeam space" : "Recovered from persisted space-owned entities",
          now,
          now
        ]
      );
      existing.add(id);
      existingSlugs.add(slug);
    }
  }

  private async migrateAgentsModelNullable(): Promise<void> {
    const [rows] = await this.pool.query<Array<{ IS_NULLABLE: string }>>(
      "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'iteam_agents' AND COLUMN_NAME = 'model'"
    );
    const isNullable = Array.isArray(rows) && rows[0] && rows[0].IS_NULLABLE === "YES";
    if (isNullable) return;
    console.log("[mysql] migrating iteam_agents.model to nullable...");
    await this.pool.query(`ALTER TABLE iteam_agents MODIFY COLUMN model VARCHAR(64) DEFAULT NULL`);
    console.log("[mysql] iteam_agents.model migration complete");
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

    const [spaceRows] = await this.pool.query<Array<{
      id: string;
      name: string;
      slug: string;
      description: string | null;
      created_at: string;
      updated_at: string;
    }>>("SELECT id, name, slug, description, created_at, updated_at FROM iteam_spaces");

    const [humanRows] = await this.pool.query<Array<{
      id: string;
      name: string;
      handle: string;
      role: string | null;
    }>>("SELECT id, name, handle, role FROM iteam_humans");

    const [computerRows] = await this.pool.query<Array<{
      id: string;
      space_id: string | null;
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
      space_id: string | null;
      token: string;
      status: string;
      created_at: string;
      connected_computer_id: string | null;
      label: string | null;
      connected_at: string | null;
    }>>("SELECT * FROM iteam_pending_connections");

    const [agentRows] = await this.pool.query<Array<{
      id: string;
      space_id: string | null;
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
      space_id: string | null;
      name: string;
      target: string;
      kind: string;
      description: string | null;
      default_agent_id: string | null;
      created_at: string;
    }>>("SELECT * FROM iteam_channels");

    const [memberRows] = await this.pool.query<Array<{
      channel_id: string;
      member_id: string;
    }>>("SELECT channel_id, member_id FROM iteam_channel_members");

    const [messageRows] = await this.pool.query<Array<{
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
    }>>("SELECT * FROM iteam_messages ORDER BY created_at ASC");

    const [taskRows] = await this.pool.query<Array<{
      id: string;
      space_id: string | null;
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
      space_id: string | null;
      message_id: string;
      root_message_id: string;
      parent_delivery_id: string | null;
      depth: number;
      agent_id: string;
      computer_id: string;
      target: string;
      session_key: string | null;
      source: string | null;
      status: string;
      attempts: number;
      created_at: string;
      updated_at: string;
      error: string | null;
      lifecycle: string | unknown | null;
    }>>("SELECT * FROM iteam_deliveries ORDER BY created_at ASC");

    const [scheduledTaskRows] = await this.pool.query<Array<{
      id: string;
      space_id: string | null;
      target: string;
      agent_id: string;
      prompt: string;
      session_key: string | null;
      interval_ms: number | null;
      cron_expression: string | null;
      timezone: string | null;
      status: string;
      next_run_at: string;
      last_run_at: string | null;
      last_message_id: string | null;
      run_count: number;
      created_by: string;
      created_at: string;
      updated_at: string;
    }>>("SELECT * FROM iteam_scheduled_tasks ORDER BY created_at ASC");

    const [ingressPairingRows] = await this.pool.query<Array<{
      id: string;
      pair_code: string;
      target: string;
      agent_id: string;
      label: string | null;
      context_rules: string | unknown | null;
      status: string;
      expires_at: string;
      created_at: string;
      consumed_at: string | null;
      policy_id: string | null;
    }>>("SELECT * FROM iteam_external_ingress_pairings ORDER BY created_at ASC");

    const [ingressPolicyRows] = await this.pool.query<Array<{
      id: string;
      token: string;
      source: string;
      target: string;
      agent_id: string;
      context_rules: string | unknown | null;
      status: string;
      created_at: string;
      updated_at: string;
    }>>("SELECT * FROM iteam_external_ingress_policies ORDER BY created_at ASC");

    const [externalBotConfigRows] = await this.pool.query<Array<{
      provider: string;
      alias: string | null;
      app_id: string;
      app_secret: string | null;
      domain: string | null;
      enabled: number;
      status: string | null;
      status_message: string | null;
      last_connected_at: string | null;
      created_at: string;
      updated_at: string;
    }>>("SELECT * FROM iteam_external_bot_configs ORDER BY created_at ASC");

    const [externalBotBindingRows] = await this.pool.query<Array<{
      id: string;
      provider: string;
      tenant_key: string;
      chat_id: string;
      chat_type: string | null;
      default_target: string | null;
      default_agent_id: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }>>("SELECT * FROM iteam_external_bot_bindings ORDER BY created_at ASC");

    const [externalMessageLinkRows] = await this.pool.query<Array<{
      id: string;
      provider: string;
      external_conversation_id: string;
      external_message_id: string | null;
      message_id: string;
      root_message_id: string | null;
      direction: string;
      created_at: string;
    }>>("SELECT * FROM iteam_external_message_links ORDER BY created_at ASC");

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
      spaceId: row.space_id || DEFAULT_SPACE_ID,
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
      spaceId: row.space_id || DEFAULT_SPACE_ID,
      token: row.token,
      status: row.status,
      createdAt: row.created_at,
      connectedComputerId: row.connected_computer_id,
      label: row.label || "",
      ...(row.connected_at ? { connectedAt: row.connected_at } : {})
    }));

    const agents: Agent[] = agentRows.map(row => ({
      id: row.id,
      spaceId: row.space_id || DEFAULT_SPACE_ID,
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
      spaceId: row.space_id || DEFAULT_SPACE_ID,
      name: row.name,
      target: row.target,
      kind: row.kind,
      description: row.description || "",
      memberIds: channelMemberMap.get(row.id) || [],
      defaultAgentId: row.default_agent_id || null,
      createdAt: row.created_at
    }));

    const messages: Message[] = messageRows.map(row => ({
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
    }));

    const tasks: Task[] = taskRows.map(row => ({
      id: row.id,
      spaceId: row.space_id || DEFAULT_SPACE_ID,
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
      spaceId: row.space_id || DEFAULT_SPACE_ID,
      messageId: row.message_id,
      rootMessageId: row.root_message_id,
      parentDeliveryId: row.parent_delivery_id,
      depth: row.depth,
      agentId: row.agent_id,
      computerId: row.computer_id,
      target: row.target,
      sessionKey: row.session_key,
      source: row.source,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      error: row.error,
      lifecycle: parseJsonField(row.lifecycle, [])
    }));

    const scheduledTasks: ScheduledTask[] = scheduledTaskRows.map(row => ({
      id: row.id,
      spaceId: row.space_id || DEFAULT_SPACE_ID,
      target: row.target,
      agentId: row.agent_id,
      prompt: row.prompt,
      sessionKey: row.session_key,
      intervalMs: row.interval_ms,
      cronExpression: row.cron_expression,
      timezone: row.timezone,
      status: row.status,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastMessageId: row.last_message_id,
      runCount: row.run_count,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    const externalIngressPairings: ExternalIngressPairing[] = ingressPairingRows.map(row => ({
      id: row.id,
      spaceId: DEFAULT_SPACE_ID,
      pairCode: row.pair_code,
      target: row.target,
      agentId: row.agent_id,
      ...(row.label ? { label: row.label } : {}),
      contextRules: parseJsonField<Record<string, string[]> | undefined>(row.context_rules, undefined),
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      consumedAt: row.consumed_at,
      policyId: row.policy_id
    }));

    const externalIngressPolicies: ExternalIngressPolicy[] = ingressPolicyRows.map(row => ({
      id: row.id,
      spaceId: DEFAULT_SPACE_ID,
      token: row.token,
      source: row.source,
      target: row.target,
      agentId: row.agent_id,
      contextRules: parseJsonField<Record<string, string[]> | undefined>(row.context_rules, undefined),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    const externalBotConfigs: ExternalBotConfig[] = externalBotConfigRows.map(row => ({
      spaceId: DEFAULT_SPACE_ID,
      provider: row.provider,
      alias: row.alias,
      appId: row.app_id,
      appSecret: row.app_secret,
      domain: row.domain,
      enabled: !!row.enabled,
      status: row.status || undefined,
      statusMessage: row.status_message,
      lastConnectedAt: row.last_connected_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    const externalBotBindings: ExternalBotBinding[] = externalBotBindingRows.map(row => ({
      id: row.id,
      spaceId: DEFAULT_SPACE_ID,
      provider: row.provider,
      tenantKey: row.tenant_key,
      chatId: row.chat_id,
      chatType: row.chat_type,
      defaultTarget: row.default_target,
      defaultAgentId: row.default_agent_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    const externalMessageLinks: ExternalMessageLink[] = externalMessageLinkRows.map(row => ({
      id: row.id,
      spaceId: DEFAULT_SPACE_ID,
      provider: row.provider,
      externalConversationId: row.external_conversation_id,
      externalMessageId: row.external_message_id,
      messageId: row.message_id,
      rootMessageId: row.root_message_id,
      direction: row.direction,
      createdAt: row.created_at
    }));

    const events: StoreEvent[] = eventRows.map(row => ({
      id: row.id,
      type: row.type,
      payload: parseJsonField<unknown>(row.payload, null),
      createdAt: row.created_at
    }));

    const spaces: Space[] = spaceRows.length
      ? spaceRows.map(row => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          description: row.description || "",
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }))
      : seed.spaces;

    // Fall back to seed defaults when the database is empty (first run).
    return {
      meta: seed.meta,
      spaces,
      computers,
      pendingComputerConnections,
      humans: humans.length ? humans : seed.humans,
      agents,
      channels: channels.length ? channels : seed.channels,
      messages,
      deliveries,
      tasks,
      scheduledTasks,
      externalIngressPairings,
      externalIngressPolicies,
      externalBotConfigs,
      externalBotBindings,
      externalMessageLinks,
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

      await conn.query("DELETE FROM iteam_spaces");
      if (state.spaces.length) {
        await conn.query(
          "INSERT INTO iteam_spaces (id, name, slug, description, created_at, updated_at) VALUES ?",
          [
            state.spaces.map(space => [
              space.id,
              space.name,
              space.slug,
              space.description ?? null,
              space.createdAt,
              space.updatedAt
            ])
          ]
        );
      }

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
          "INSERT INTO iteam_computers (id, space_id, name, fingerprint_id, fingerprint_hostname, fingerprint_os, fingerprint_arch, status, daemon_version, runtimes, agent_ids, connection_id, connect_token, created_at, first_connected_at, last_seen_at) VALUES ?",
          [
            state.computers.map(c => [
              c.id,
              c.spaceId || DEFAULT_SPACE_ID,
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
          "INSERT INTO iteam_pending_connections (id, space_id, token, status, created_at, connected_computer_id, label, connected_at) VALUES ?",
          [
            state.pendingComputerConnections.map(p => [
              p.id,
              p.spaceId || DEFAULT_SPACE_ID,
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
          "INSERT INTO iteam_agents (id, space_id, name, handle, description, runtime, model, reasoning, computer_id, status, desired_status, launch_id, pid, workspace_path, created_at, updated_at, env, last_started_at, last_runtime_status) VALUES ?",
          [
            state.agents.map(a => [
              a.id,
              a.spaceId || DEFAULT_SPACE_ID,
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
          "INSERT INTO iteam_channels (id, space_id, name, target, kind, description, default_agent_id, created_at) VALUES ?",
          [
            state.channels.map(c => [
              c.id,
              c.spaceId || DEFAULT_SPACE_ID,
              c.name,
              c.target,
              c.kind,
              c.description ?? null,
              c.defaultAgentId ?? null,
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
          "INSERT INTO iteam_messages (id, space_id, target, author_id, type, text, mentions, created_at, thread_id, task_id) VALUES ?",
          [
            state.messages.map(m => [
              m.id,
              m.spaceId || DEFAULT_SPACE_ID,
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
          "INSERT INTO iteam_tasks (id, space_id, number, target, title, description, status, assignee_id, created_by, message_id, thread_target, created_at, updated_at) VALUES ?",
          [
            state.tasks.map(t => [
              t.id,
              t.spaceId || DEFAULT_SPACE_ID,
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
          "INSERT INTO iteam_deliveries (id, space_id, message_id, root_message_id, parent_delivery_id, depth, agent_id, computer_id, target, session_key, source, status, attempts, created_at, updated_at, error, lifecycle) VALUES ?",
          [
            state.deliveries.map(d => [
              d.id,
              d.spaceId || DEFAULT_SPACE_ID,
              d.messageId,
              d.rootMessageId,
              d.parentDeliveryId,
              d.depth,
              d.agentId,
              d.computerId,
              d.target,
              d.sessionKey ?? null,
              d.source ?? null,
              d.status,
              d.attempts,
              d.createdAt,
              d.updatedAt,
              d.error ?? null,
              JSON.stringify(d.lifecycle || [])
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_scheduled_tasks");
      if (state.scheduledTasks.length) {
        await conn.query(
          "INSERT INTO iteam_scheduled_tasks (id, space_id, target, agent_id, prompt, session_key, interval_ms, cron_expression, timezone, status, next_run_at, last_run_at, last_message_id, run_count, created_by, created_at, updated_at) VALUES ?",
          [
            state.scheduledTasks.map(task => [
              task.id,
              task.spaceId || DEFAULT_SPACE_ID,
              task.target,
              task.agentId,
              task.prompt,
              task.sessionKey ?? null,
              task.intervalMs ?? 0,
              task.cronExpression ?? null,
              task.timezone ?? null,
              task.status,
              task.nextRunAt,
              task.lastRunAt ?? null,
              task.lastMessageId ?? null,
              task.runCount ?? 0,
              task.createdBy,
              task.createdAt,
              task.updatedAt
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_external_ingress_pairings");
      if (state.externalIngressPairings.length) {
        await conn.query(
          "INSERT INTO iteam_external_ingress_pairings (id, pair_code, target, agent_id, label, context_rules, status, expires_at, created_at, consumed_at, policy_id) VALUES ?",
          [
            state.externalIngressPairings.map(pairing => [
              pairing.id,
              pairing.pairCode,
              pairing.target,
              pairing.agentId,
              pairing.label ?? null,
              pairing.contextRules ? JSON.stringify(pairing.contextRules) : null,
              pairing.status,
              pairing.expiresAt,
              pairing.createdAt,
              pairing.consumedAt ?? null,
              pairing.policyId ?? null
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_external_ingress_policies");
      if (state.externalIngressPolicies.length) {
        await conn.query(
          "INSERT INTO iteam_external_ingress_policies (id, token, source, target, agent_id, context_rules, status, created_at, updated_at) VALUES ?",
          [
            state.externalIngressPolicies.map(policy => [
              policy.id,
              policy.token,
              policy.source,
              policy.target,
              policy.agentId,
              policy.contextRules ? JSON.stringify(policy.contextRules) : null,
              policy.status,
              policy.createdAt,
              policy.updatedAt
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_external_bot_configs");
      if (state.externalBotConfigs.length) {
        await conn.query(
          "INSERT INTO iteam_external_bot_configs (provider, alias, app_id, app_secret, domain, enabled, status, status_message, last_connected_at, created_at, updated_at) VALUES ?",
          [
            state.externalBotConfigs.map(config => [
              config.provider,
              config.alias ?? null,
              config.appId,
              config.appSecret ?? null,
              config.domain ?? null,
              config.enabled ? 1 : 0,
              config.status ?? null,
              config.statusMessage ?? null,
              config.lastConnectedAt ?? null,
              config.createdAt,
              config.updatedAt
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_external_bot_bindings");
      if (state.externalBotBindings.length) {
        await conn.query(
          "INSERT INTO iteam_external_bot_bindings (id, provider, tenant_key, chat_id, chat_type, default_target, default_agent_id, status, created_at, updated_at) VALUES ?",
          [
            state.externalBotBindings.map(binding => [
              binding.id,
              binding.provider,
              binding.tenantKey,
              binding.chatId,
              binding.chatType ?? null,
              binding.defaultTarget ?? null,
              binding.defaultAgentId ?? null,
              binding.status,
              binding.createdAt,
              binding.updatedAt
            ])
          ]
        );
      }

      await conn.query("DELETE FROM iteam_external_message_links");
      if (state.externalMessageLinks.length) {
        await conn.query(
          "INSERT INTO iteam_external_message_links (id, provider, external_conversation_id, external_message_id, message_id, root_message_id, direction, created_at) VALUES ?",
          [
            state.externalMessageLinks.map(link => [
              link.id,
              link.provider,
              link.externalConversationId,
              link.externalMessageId ?? null,
              link.messageId,
              link.rootMessageId ?? null,
              link.direction,
              link.createdAt
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

function escapeMysqlIdentifier(value: string): string {
  return value.replaceAll("`", "``");
}
