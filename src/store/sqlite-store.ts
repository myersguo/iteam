import { join } from "node:path";
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
  State,
  StoreEvent,
  Task
} from "../types.js";
import { BaseStore, DEFAULT_SPACE_ID, initialState, sanitizeState } from "./base.js";
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
    this.addColumnIfMissing("iteam_computers", "space_id", "TEXT NOT NULL DEFAULT 'space_default'");
    this.addColumnIfMissing("iteam_pending_connections", "space_id", "TEXT NOT NULL DEFAULT 'space_default'");
    this.addColumnIfMissing("iteam_agents", "space_id", "TEXT NOT NULL DEFAULT 'space_default'");
    this.addColumnIfMissing("iteam_scheduled_tasks", "cron_expression", "TEXT");
    this.addColumnIfMissing("iteam_scheduled_tasks", "timezone", "TEXT");
    this.addColumnIfMissing("iteam_scheduled_tasks", "session_key", "TEXT");
    this.addColumnIfMissing("iteam_deliveries", "session_key", "TEXT");
    this.addColumnIfMissing("iteam_deliveries", "source", "TEXT");
    this.addColumnIfMissing("iteam_deliveries", "lifecycle", "TEXT");
    this.addColumnIfMissing("iteam_external_bot_configs", "alias", "TEXT");
    this.addColumnIfMissing("iteam_external_bot_configs", "status", "TEXT");
    this.addColumnIfMissing("iteam_external_bot_configs", "status_message", "TEXT");
    this.addColumnIfMissing("iteam_external_bot_configs", "last_connected_at", "TEXT");
    this.addColumnIfMissing("iteam_channels", "default_agent_id", "TEXT");
    this.addColumnIfMissing("iteam_channels", "space_id", "TEXT NOT NULL DEFAULT 'space_default'");
    this.migrateChannelsUniqueSpaceTarget();
    this.migrateAgentsModelNullable();
  }

  // Legacy iteam_channels had UNIQUE(target). Multi-space channels need
  // UNIQUE(space_id, target). Rebuild the table when the old constraint is
  // still there.
  private migrateChannelsUniqueSpaceTarget(): void {
    const indexes = this.db
      .prepare(`PRAGMA index_list(iteam_channels)`)
      .all() as Array<{ name: string; unique: number; origin: string }>;
    let hasLegacyUnique = false;
    for (const idx of indexes) {
      if (!idx.unique) continue;
      const cols = this.db
        .prepare(`PRAGMA index_info(${idx.name})`)
        .all() as Array<{ name: string }>;
      if (cols.length === 1 && cols[0].name === "target") {
        hasLegacyUnique = true;
        break;
      }
    }
    if (!hasLegacyUnique) return;
    console.log("[sqlite] migrating iteam_channels UNIQUE(target) → UNIQUE(space_id, target)...");
    this.db.exec(`
      CREATE TABLE iteam_channels_new (
        id                TEXT NOT NULL PRIMARY KEY,
        space_id          TEXT NOT NULL DEFAULT 'space_default',
        name              TEXT NOT NULL,
        target            TEXT NOT NULL,
        kind              TEXT NOT NULL,
        description       TEXT,
        default_agent_id  TEXT,
        created_at        TEXT NOT NULL,
        UNIQUE(space_id, target)
      )
    `);
    this.db.exec(`
      INSERT INTO iteam_channels_new (id, space_id, name, target, kind, description, default_agent_id, created_at)
      SELECT id, COALESCE(space_id, 'space_default'), name, target, kind, description, default_agent_id, created_at
      FROM iteam_channels
    `);
    this.db.exec(`DROP TABLE iteam_channels`);
    this.db.exec(`ALTER TABLE iteam_channels_new RENAME TO iteam_channels`);
    console.log("[sqlite] iteam_channels unique-constraint migration complete");
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
        space_id            TEXT NOT NULL DEFAULT 'space_default',
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
      SELECT id, COALESCE(space_id, 'space_default'), name, handle, description, runtime, model, reasoning, computer_id,
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

    const spaceRows = this.db
      .prepare("SELECT id, name, slug, description, created_at, updated_at FROM iteam_spaces")
      .all() as Array<{
        id: string;
        name: string;
        slug: string;
        description: string | null;
        created_at: string;
        updated_at: string;
      }>;

    const humanRows = this.db
      .prepare("SELECT id, name, handle, role FROM iteam_humans")
      .all() as Array<{ id: string; name: string; handle: string; role: string | null }>;

    const computerRows = this.db.prepare("SELECT * FROM iteam_computers").all() as Array<{
      id: string;
      space_id: string | null;
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
      space_id: string | null;
      token: string;
      status: string;
      created_at: string;
      connected_computer_id: string | null;
      label: string | null;
      connected_at: string | null;
    }>;

    const agentRows = this.db.prepare("SELECT * FROM iteam_agents").all() as Array<{
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
      env: string | null;
      last_started_at: string | null;
      last_runtime_status: string | null;
    }>;

    const channelRows = this.db.prepare("SELECT * FROM iteam_channels").all() as Array<{
      id: string;
      space_id: string | null;
      name: string;
      target: string;
      kind: string;
      description: string | null;
      default_agent_id: string | null;
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
        session_key: string | null;
        source: string | null;
        status: string;
        attempts: number;
        created_at: string;
        updated_at: string;
        error: string | null;
        lifecycle: string | null;
      }>;

    const scheduledTaskRows = this.db
      .prepare("SELECT * FROM iteam_scheduled_tasks ORDER BY created_at ASC")
      .all() as Array<{
        id: string;
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
      }>;

    const ingressPairingRows = this.db
      .prepare("SELECT * FROM iteam_external_ingress_pairings ORDER BY created_at ASC")
      .all() as Array<{
        id: string;
        pair_code: string;
        target: string;
        agent_id: string;
        label: string | null;
        context_rules: string | null;
        status: string;
        expires_at: string;
        created_at: string;
        consumed_at: string | null;
        policy_id: string | null;
      }>;

    const ingressPolicyRows = this.db
      .prepare("SELECT * FROM iteam_external_ingress_policies ORDER BY created_at ASC")
      .all() as Array<{
        id: string;
        token: string;
        source: string;
        target: string;
        agent_id: string;
        context_rules: string | null;
        status: string;
        created_at: string;
        updated_at: string;
      }>;

    const externalBotConfigRows = this.db
      .prepare("SELECT * FROM iteam_external_bot_configs ORDER BY created_at ASC")
      .all() as Array<{
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
      }>;

    const externalBotBindingRows = this.db
      .prepare("SELECT * FROM iteam_external_bot_bindings ORDER BY created_at ASC")
      .all() as Array<{
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
      }>;

    const externalMessageLinkRows = this.db
      .prepare("SELECT * FROM iteam_external_message_links ORDER BY created_at ASC")
      .all() as Array<{
        id: string;
        provider: string;
        external_conversation_id: string;
        external_message_id: string | null;
        message_id: string;
        root_message_id: string | null;
        direction: string;
        created_at: string;
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
      spaceId: DEFAULT_SPACE_ID,
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
      spaceId: DEFAULT_SPACE_ID,
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
      spaceId: DEFAULT_SPACE_ID,
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
      spaceId: DEFAULT_SPACE_ID,
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

    const spaces = spaceRows.length
      ? spaceRows.map(row => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          description: row.description || "",
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }))
      : seed.spaces;

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
  // Persist: synchronous, atomic via better-sqlite3 transaction()
  // ---------------------------------------------------------------------------
  protected persist(state: State): void {
    this.writeAll(state);
  }

  private writeAllUnwrapped(state: State): void {
    this.db.exec("DELETE FROM iteam_spaces");
    if (state.spaces && state.spaces.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_spaces (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const sp of state.spaces) {
        stmt.run(sp.id, sp.name, sp.slug, sp.description ?? null, sp.createdAt, sp.updatedAt);
      }
    }

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
        "INSERT INTO iteam_computers (id, space_id, name, fingerprint_id, fingerprint_hostname, fingerprint_os, fingerprint_arch, status, daemon_version, runtimes, agent_ids, connection_id, connect_token, created_at, first_connected_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const c of state.computers) {
        stmt.run(
          c.id,
          c.spaceId || DEFAULT_SPACE_ID,
          c.name,
          c.fingerprint?.id ?? null,
          c.fingerprint?.hostname ?? null,
          c.fingerprint?.os ?? null,
          c.fingerprint?.arch ?? null,
          c.status,
          c.daemonVersion,
          c.runtimes !== undefined ? JSON.stringify(c.runtimes) : '[]',
          c.agentIds !== undefined ? JSON.stringify(c.agentIds) : '[]',
          c.connectionId ?? null,
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
        "INSERT INTO iteam_pending_connections (id, space_id, token, status, created_at, connected_computer_id, label, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const p of state.pendingComputerConnections) {
        stmt.run(
          p.id,
          p.spaceId || DEFAULT_SPACE_ID,
          p.token,
          p.status,
          p.createdAt,
          p.connectedComputerId ?? null,
          p.label ?? null,
          p.connectedAt ?? null
        );
      }
    }

    this.db.exec("DELETE FROM iteam_agents");
    if (state.agents.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_agents (id, space_id, name, handle, description, runtime, model, reasoning, computer_id, status, desired_status, launch_id, pid, workspace_path, created_at, updated_at, env, last_started_at, last_runtime_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const a of state.agents) {
        stmt.run(
          a.id,
          a.spaceId || DEFAULT_SPACE_ID,
          a.name,
          a.handle,
          a.description,
          a.runtime,
          a.model ?? null,
          a.reasoning ?? null,
          a.computerId,
          a.status,
          a.desiredStatus,
          a.launchId ?? null,
          a.pid ?? null,
          a.workspacePath,
          a.createdAt,
          a.updatedAt,
          a.env !== undefined ? JSON.stringify(a.env) : '{}',
          a.lastStartedAt ?? null,
          a.lastRuntimeStatus ? JSON.stringify(a.lastRuntimeStatus) : null
        );
      }
    }

    this.db.exec("DELETE FROM iteam_channel_members");
    this.db.exec("DELETE FROM iteam_channels");
    if (state.channels.length) {
      const channelStmt = this.db.prepare(
        "INSERT INTO iteam_channels (id, space_id, name, target, kind, description, default_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const memberStmt = this.db.prepare(
        "INSERT INTO iteam_channel_members (channel_id, member_id) VALUES (?, ?)"
      );
      for (const channel of state.channels) {
        channelStmt.run(
          channel.id,
          channel.spaceId || DEFAULT_SPACE_ID,
          channel.name,
          channel.target,
          channel.kind,
          channel.description ?? null,
          channel.defaultAgentId ?? null,
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
          m.mentions !== undefined ? JSON.stringify(m.mentions) : '[]',
          m.createdAt,
          m.threadId ?? null,
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
          t.description ?? "",
          t.status,
          t.assigneeId ?? null,
          t.createdBy,
          t.messageId,
          t.threadTarget ?? null,
          t.createdAt,
          t.updatedAt
        );
      }
    }

    this.db.exec("DELETE FROM iteam_deliveries");
    if (state.deliveries.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_deliveries (id, message_id, root_message_id, parent_delivery_id, depth, agent_id, computer_id, target, session_key, source, status, attempts, created_at, updated_at, error, lifecycle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const d of state.deliveries) {
        stmt.run(
          d.id,
          d.messageId ?? null,
          d.rootMessageId ?? null,
          d.parentDeliveryId ?? null,
          d.depth ?? 0,
          d.agentId,
          d.computerId,
          d.target,
          d.sessionKey ?? null,
          d.source ?? null,
          d.status,
          d.attempts ?? 0,
          d.createdAt,
          d.updatedAt,
          d.error ?? null,
          JSON.stringify(d.lifecycle || [])
        );
      }
    }

    this.db.exec("DELETE FROM iteam_scheduled_tasks");
    if (state.scheduledTasks.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_scheduled_tasks (id, target, agent_id, prompt, session_key, interval_ms, cron_expression, timezone, status, next_run_at, last_run_at, last_message_id, run_count, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const task of state.scheduledTasks) {
        stmt.run(
          task.id,
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
        );
      }
    }

    this.db.exec("DELETE FROM iteam_external_ingress_pairings");
    if (state.externalIngressPairings.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_external_ingress_pairings (id, pair_code, target, agent_id, label, context_rules, status, expires_at, created_at, consumed_at, policy_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const pairing of state.externalIngressPairings) {
        stmt.run(
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
        );
      }
    }

    this.db.exec("DELETE FROM iteam_external_ingress_policies");
    if (state.externalIngressPolicies.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_external_ingress_policies (id, token, source, target, agent_id, context_rules, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const policy of state.externalIngressPolicies) {
        stmt.run(
          policy.id,
          policy.token,
          policy.source,
          policy.target,
          policy.agentId,
          policy.contextRules ? JSON.stringify(policy.contextRules) : null,
          policy.status,
          policy.createdAt,
          policy.updatedAt
        );
      }
    }

    this.db.exec("DELETE FROM iteam_external_bot_configs");
    if (state.externalBotConfigs.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_external_bot_configs (provider, alias, app_id, app_secret, domain, enabled, status, status_message, last_connected_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const config of state.externalBotConfigs) {
        stmt.run(
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
        );
      }
    }

    this.db.exec("DELETE FROM iteam_external_bot_bindings");
    if (state.externalBotBindings.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_external_bot_bindings (id, provider, tenant_key, chat_id, chat_type, default_target, default_agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const binding of state.externalBotBindings) {
        stmt.run(
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
        );
      }
    }

    this.db.exec("DELETE FROM iteam_external_message_links");
    if (state.externalMessageLinks.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_external_message_links (id, provider, external_conversation_id, external_message_id, message_id, root_message_id, direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const link of state.externalMessageLinks) {
        stmt.run(
          link.id,
          link.provider,
          link.externalConversationId,
          link.externalMessageId ?? null,
          link.messageId,
          link.rootMessageId ?? null,
          link.direction,
          link.createdAt
        );
      }
    }

    this.db.exec("DELETE FROM iteam_events");
    if (state.events.length) {
      const stmt = this.db.prepare(
        "INSERT INTO iteam_events (id, type, payload, created_at) VALUES (?, ?, ?, ?)"
      );
      for (const e of state.events) {
        stmt.run(e.id, e.type, e.payload !== undefined ? JSON.stringify(e.payload) : null, e.createdAt);
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
