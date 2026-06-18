/**
 * SQLite schema, mirroring the MySQL 10-table layout.
 *
 * Differences from MySQL:
 * - SQLite has no ENGINE / DEFAULT CHARSET clauses.
 * - JSON columns are stored as TEXT (parsed/serialized in app layer).
 * - VARCHAR(N) maps to TEXT (SQLite ignores the length anyway).
 * - DATETIME stored as TEXT in ISO-8601 (consistent with the rest of the app).
 *
 * Indexes are created separately because SQLite doesn't support inline KEY
 * inside CREATE TABLE.
 */

export const SQLITE_TABLES: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS iteam_humans (
    id      TEXT NOT NULL PRIMARY KEY,
    name    TEXT NOT NULL,
    handle  TEXT NOT NULL UNIQUE,
    role    TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_computers (
    id                   TEXT NOT NULL PRIMARY KEY,
    name                 TEXT NOT NULL,
    fingerprint_id       TEXT NOT NULL,
    fingerprint_hostname TEXT NOT NULL,
    fingerprint_os       TEXT NOT NULL,
    fingerprint_arch     TEXT NOT NULL,
    status               TEXT NOT NULL,
    daemon_version       TEXT NOT NULL,
    runtimes             TEXT NOT NULL,
    agent_ids            TEXT NOT NULL,
    connection_id        TEXT NOT NULL,
    connect_token        TEXT,
    created_at           TEXT NOT NULL,
    first_connected_at   TEXT,
    last_seen_at         TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_pending_connections (
    id                    TEXT NOT NULL PRIMARY KEY,
    token                 TEXT NOT NULL UNIQUE,
    status                TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    connected_computer_id TEXT,
    label                 TEXT,
    connected_at          TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_agents (
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
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_channels (
    id          TEXT NOT NULL PRIMARY KEY,
    name        TEXT NOT NULL,
    target      TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_channel_members (
    channel_id TEXT NOT NULL,
    member_id  TEXT NOT NULL,
    PRIMARY KEY (channel_id, member_id)
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_messages (
    id         TEXT NOT NULL PRIMARY KEY,
    target     TEXT NOT NULL,
    author_id  TEXT NOT NULL,
    type       TEXT NOT NULL,
    text       TEXT NOT NULL,
    mentions   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    thread_id  TEXT,
    task_id    TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_tasks (
    id            TEXT NOT NULL PRIMARY KEY,
    number        INTEGER NOT NULL,
    target        TEXT NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL,
    status        TEXT NOT NULL,
    assignee_id   TEXT,
    created_by    TEXT NOT NULL,
    message_id    TEXT NOT NULL,
    thread_target TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_scheduled_tasks (
    id              TEXT NOT NULL PRIMARY KEY,
    target          TEXT NOT NULL,
	    agent_id        TEXT NOT NULL,
	    prompt          TEXT NOT NULL,
	    session_key     TEXT,
	    interval_ms     INTEGER,
    cron_expression TEXT,
    timezone        TEXT,
    status          TEXT NOT NULL,
    next_run_at     TEXT NOT NULL,
    last_run_at     TEXT,
    last_message_id TEXT,
    run_count       INTEGER NOT NULL DEFAULT 0,
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_deliveries (
    id                 TEXT NOT NULL PRIMARY KEY,
    message_id         TEXT NOT NULL,
    root_message_id    TEXT NOT NULL,
    parent_delivery_id TEXT,
    depth              INTEGER NOT NULL DEFAULT 0,
    agent_id           TEXT NOT NULL,
	    computer_id        TEXT NOT NULL,
	    target             TEXT NOT NULL,
	    session_key        TEXT,
	    source             TEXT,
	    status             TEXT NOT NULL,
    attempts           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
	    error              TEXT,
	    lifecycle          TEXT
	  )`,
  `CREATE TABLE IF NOT EXISTS iteam_external_ingress_pairings (
    id            TEXT NOT NULL PRIMARY KEY,
    pair_code     TEXT NOT NULL UNIQUE,
    target        TEXT NOT NULL,
    agent_id      TEXT NOT NULL,
    label         TEXT,
    context_rules TEXT,
    status        TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    consumed_at   TEXT,
    policy_id     TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_external_ingress_policies (
    id            TEXT NOT NULL PRIMARY KEY,
    token         TEXT NOT NULL,
    source        TEXT NOT NULL,
    target        TEXT NOT NULL,
    agent_id      TEXT NOT NULL,
    context_rules TEXT,
    status        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_external_bot_configs (
    provider   TEXT NOT NULL PRIMARY KEY,
    alias      TEXT,
    app_id     TEXT NOT NULL,
    app_secret TEXT,
    domain     TEXT,
    enabled    INTEGER NOT NULL DEFAULT 1,
    status     TEXT,
    status_message TEXT,
    last_connected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_external_bot_bindings (
    id               TEXT NOT NULL PRIMARY KEY,
    provider         TEXT NOT NULL,
    tenant_key       TEXT NOT NULL,
    chat_id          TEXT NOT NULL,
    chat_type        TEXT,
    default_target   TEXT,
    default_agent_id TEXT,
    status           TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_external_message_links (
    id                       TEXT NOT NULL PRIMARY KEY,
    provider                 TEXT NOT NULL,
    external_conversation_id TEXT NOT NULL,
    external_message_id      TEXT,
    message_id               TEXT NOT NULL,
    root_message_id          TEXT,
    direction                TEXT NOT NULL,
    created_at               TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS iteam_events (
    id         TEXT NOT NULL PRIMARY KEY,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`
];

export const SQLITE_INDEXES: ReadonlyArray<string> = [
  "CREATE INDEX IF NOT EXISTS idx_computers_status ON iteam_computers(status)",
  "CREATE INDEX IF NOT EXISTS idx_computers_fingerprint ON iteam_computers(fingerprint_id)",
  "CREATE INDEX IF NOT EXISTS idx_pending_status ON iteam_pending_connections(status)",
  "CREATE INDEX IF NOT EXISTS idx_agents_computer ON iteam_agents(computer_id)",
  "CREATE INDEX IF NOT EXISTS idx_agents_handle ON iteam_agents(handle)",
  "CREATE INDEX IF NOT EXISTS idx_agents_desired ON iteam_agents(desired_status)",
  "CREATE INDEX IF NOT EXISTS idx_channel_members_member ON iteam_channel_members(member_id)",
  "CREATE INDEX IF NOT EXISTS idx_messages_target_created ON iteam_messages(target, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_messages_author ON iteam_messages(author_id)",
  "CREATE INDEX IF NOT EXISTS idx_messages_thread ON iteam_messages(thread_id)",
  "CREATE INDEX IF NOT EXISTS idx_messages_task ON iteam_messages(task_id)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_target_status ON iteam_tasks(target, status)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON iteam_tasks(assignee_id)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_message ON iteam_tasks(message_id)",
  "CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON iteam_scheduled_tasks(status, next_run_at)",
  "CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_agent ON iteam_scheduled_tasks(agent_id)",
  "CREATE INDEX IF NOT EXISTS idx_deliveries_status_computer ON iteam_deliveries(status, computer_id)",
  "CREATE INDEX IF NOT EXISTS idx_deliveries_agent ON iteam_deliveries(agent_id)",
  "CREATE INDEX IF NOT EXISTS idx_deliveries_message ON iteam_deliveries(message_id)",
  "CREATE INDEX IF NOT EXISTS idx_ingress_pairings_code ON iteam_external_ingress_pairings(pair_code)",
  "CREATE INDEX IF NOT EXISTS idx_ingress_policies_token ON iteam_external_ingress_policies(id, token)",
  "CREATE INDEX IF NOT EXISTS idx_external_bot_configs_enabled ON iteam_external_bot_configs(enabled)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_external_bot_bindings_chat ON iteam_external_bot_bindings(provider, tenant_key, chat_id)",
  "CREATE INDEX IF NOT EXISTS idx_external_message_links_message ON iteam_external_message_links(message_id)",
  "CREATE INDEX IF NOT EXISTS idx_external_message_links_external ON iteam_external_message_links(provider, external_conversation_id, external_message_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_type_created ON iteam_events(type, created_at)"
];
