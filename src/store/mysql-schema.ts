/**
 * Schema for the MySQL backend — 10 tables, no schema_migrations,
 * code-guarded with `CREATE TABLE IF NOT EXISTS` so re-running is safe.
 *
 * The schema mirrors the in-memory `State` shape so the JsonStore/SqliteStore
 * contract is preserved: load() rebuilds State from these tables, persist()
 * synchronizes State back to them inside a single transaction.
 *
 * Table prefix `iteam_` keeps the namespace explicit when the daemon shares
 * a database with other apps.
 */
export const MYSQL_TABLES: ReadonlyArray<{ name: string; ddl: string }> = [
  {
    name: "iteam_spaces",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_spaces (
      id          VARCHAR(64)  NOT NULL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      slug        VARCHAR(64)  NOT NULL,
      description TEXT,
      created_at  VARCHAR(40)  NOT NULL,
      updated_at  VARCHAR(40)  NOT NULL,
      UNIQUE KEY uniq_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_humans",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_humans (
      id              VARCHAR(64)  NOT NULL PRIMARY KEY,
      name            VARCHAR(255) NOT NULL,
      handle          VARCHAR(64)  NOT NULL,
      role            VARCHAR(64)  DEFAULT NULL,
      UNIQUE KEY uniq_handle (handle)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_computers",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_computers (
      id                   VARCHAR(64)  NOT NULL PRIMARY KEY,
      space_id             VARCHAR(64)  NOT NULL DEFAULT 'space_default',
      name                 VARCHAR(255) NOT NULL,
      fingerprint_id       VARCHAR(64)  NOT NULL,
      fingerprint_hostname VARCHAR(255) NOT NULL,
      fingerprint_os       VARCHAR(64)  NOT NULL,
      fingerprint_arch     VARCHAR(32)  NOT NULL,
      status               VARCHAR(32)  NOT NULL,
      daemon_version       VARCHAR(32)  NOT NULL,
      runtimes             JSON         NOT NULL,
      agent_ids            JSON         NOT NULL,
      connection_id        VARCHAR(64)  NOT NULL,
      connect_token        VARCHAR(128) DEFAULT NULL,
      created_at           VARCHAR(40)  NOT NULL,
      first_connected_at   VARCHAR(40)  DEFAULT NULL,
      last_seen_at         VARCHAR(40)  DEFAULT NULL,
      KEY idx_status (status),
      KEY idx_fingerprint (fingerprint_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_pending_connections",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_pending_connections (
      id                    VARCHAR(64)  NOT NULL PRIMARY KEY,
      space_id              VARCHAR(64)  NOT NULL DEFAULT 'space_default',
      token                 VARCHAR(128) NOT NULL,
      status                VARCHAR(32)  NOT NULL,
      created_at            VARCHAR(40)  NOT NULL,
      connected_computer_id VARCHAR(64)  DEFAULT NULL,
      label                 VARCHAR(255) DEFAULT NULL,
      connected_at          VARCHAR(40)  DEFAULT NULL,
      UNIQUE KEY uniq_token (token),
      KEY idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_agents",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_agents (
      id                  VARCHAR(64)  NOT NULL PRIMARY KEY,
      space_id            VARCHAR(64)  NOT NULL DEFAULT 'space_default',
      name                VARCHAR(255) NOT NULL,
      handle              VARCHAR(64)  NOT NULL,
      description         TEXT         NOT NULL,
      runtime             VARCHAR(32)  NOT NULL,
      model               VARCHAR(64)  DEFAULT NULL,
      reasoning           VARCHAR(32)  DEFAULT NULL,
      computer_id         VARCHAR(64)  NOT NULL,
      status              VARCHAR(32)  NOT NULL,
      desired_status      VARCHAR(32)  NOT NULL,
      launch_id           VARCHAR(64)  DEFAULT NULL,
      pid                 INT          DEFAULT NULL,
      workspace_path      VARCHAR(512) NOT NULL,
      created_at          VARCHAR(40)  NOT NULL,
      updated_at          VARCHAR(40)  NOT NULL,
      env                 JSON         DEFAULT NULL,
      last_started_at     VARCHAR(40)  DEFAULT NULL,
      last_runtime_status JSON         DEFAULT NULL,
      KEY idx_computer (computer_id),
      KEY idx_handle (handle),
      KEY idx_desired (desired_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_channels",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_channels (
      id                VARCHAR(64)  NOT NULL PRIMARY KEY,
      name              VARCHAR(255) NOT NULL,
      target            VARCHAR(255) NOT NULL,
      kind              VARCHAR(32)  NOT NULL,
      description       TEXT,
      default_agent_id  VARCHAR(64)  DEFAULT NULL,
      created_at        VARCHAR(40)  NOT NULL,
      UNIQUE KEY uniq_target (target)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_channel_members",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_channel_members (
      channel_id VARCHAR(64) NOT NULL,
      member_id  VARCHAR(64) NOT NULL,
      PRIMARY KEY (channel_id, member_id),
      KEY idx_member (member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_messages",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_messages (
      id         VARCHAR(64)  NOT NULL PRIMARY KEY,
      target     VARCHAR(255) NOT NULL,
      author_id  VARCHAR(64)  NOT NULL,
      type       VARCHAR(32)  NOT NULL,
      text       MEDIUMTEXT   NOT NULL,
      mentions   JSON         NOT NULL,
      created_at VARCHAR(40)  NOT NULL,
      thread_id  VARCHAR(64)  DEFAULT NULL,
      task_id    VARCHAR(64)  DEFAULT NULL,
      KEY idx_target_created (target, created_at),
      KEY idx_author (author_id),
      KEY idx_thread (thread_id),
      KEY idx_task (task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_tasks",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_tasks (
      id            VARCHAR(64)  NOT NULL PRIMARY KEY,
      number        INT          NOT NULL,
      target        VARCHAR(255) NOT NULL,
      title         VARCHAR(512) NOT NULL,
      description   TEXT         NOT NULL,
      status        VARCHAR(32)  NOT NULL,
      assignee_id   VARCHAR(64)  DEFAULT NULL,
      created_by    VARCHAR(64)  NOT NULL,
      message_id    VARCHAR(64)  NOT NULL,
      thread_target VARCHAR(255) NOT NULL,
      created_at    VARCHAR(40)  NOT NULL,
      updated_at    VARCHAR(40)  NOT NULL,
      KEY idx_target_status (target, status),
      KEY idx_assignee (assignee_id),
      KEY idx_message (message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_scheduled_tasks",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_scheduled_tasks (
      id              VARCHAR(64)  NOT NULL PRIMARY KEY,
      target          VARCHAR(255) NOT NULL,
	      agent_id        VARCHAR(64)  NOT NULL,
	      prompt          TEXT         NOT NULL,
	      session_key     VARCHAR(255) DEFAULT NULL,
	      interval_ms     INT          DEFAULT NULL,
      cron_expression VARCHAR(255) DEFAULT NULL,
      timezone        VARCHAR(128) DEFAULT NULL,
      status          VARCHAR(32)  NOT NULL,
      next_run_at     VARCHAR(40)  NOT NULL,
      last_run_at     VARCHAR(40)  DEFAULT NULL,
      last_message_id VARCHAR(64)  DEFAULT NULL,
      run_count       INT          NOT NULL DEFAULT 0,
      created_by      VARCHAR(64)  NOT NULL,
      created_at      VARCHAR(40)  NOT NULL,
      updated_at      VARCHAR(40)  NOT NULL,
      KEY idx_due (status, next_run_at),
      KEY idx_agent (agent_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_deliveries",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_deliveries (
      id                 VARCHAR(64)  NOT NULL PRIMARY KEY,
      message_id         VARCHAR(64)  NOT NULL,
      root_message_id    VARCHAR(64)  NOT NULL,
      parent_delivery_id VARCHAR(64)  DEFAULT NULL,
      depth              INT          NOT NULL DEFAULT 0,
      agent_id           VARCHAR(64)  NOT NULL,
	      computer_id        VARCHAR(64)  NOT NULL,
	      target             VARCHAR(255) NOT NULL,
	      session_key        VARCHAR(255) DEFAULT NULL,
	      source             VARCHAR(64)  DEFAULT NULL,
	      status             VARCHAR(32)  NOT NULL,
      attempts           INT          NOT NULL DEFAULT 0,
      created_at         VARCHAR(40)  NOT NULL,
      updated_at         VARCHAR(40)  NOT NULL,
	      error              MEDIUMTEXT   DEFAULT NULL,
	      lifecycle          JSON         DEFAULT NULL,
	      KEY idx_status_computer (status, computer_id),
      KEY idx_agent (agent_id),
      KEY idx_message (message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
	  },
  {
    name: "iteam_external_ingress_pairings",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_external_ingress_pairings (
      id            VARCHAR(64)  NOT NULL PRIMARY KEY,
      pair_code     VARCHAR(128) NOT NULL,
      target        VARCHAR(255) NOT NULL,
      agent_id      VARCHAR(64)  NOT NULL,
      label         VARCHAR(255) DEFAULT NULL,
      context_rules JSON         DEFAULT NULL,
      status        VARCHAR(32)  NOT NULL,
      expires_at    VARCHAR(40)  NOT NULL,
      created_at    VARCHAR(40)  NOT NULL,
      consumed_at   VARCHAR(40)  DEFAULT NULL,
      policy_id     VARCHAR(64)  DEFAULT NULL,
      UNIQUE KEY uniq_pair_code (pair_code),
      KEY idx_pair_code (pair_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_external_ingress_policies",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_external_ingress_policies (
      id            VARCHAR(64)  NOT NULL PRIMARY KEY,
      token         VARCHAR(128) NOT NULL,
      source        VARCHAR(128) NOT NULL,
      target        VARCHAR(255) NOT NULL,
      agent_id      VARCHAR(64)  NOT NULL,
      context_rules JSON         DEFAULT NULL,
      status        VARCHAR(32)  NOT NULL,
      created_at    VARCHAR(40)  NOT NULL,
      updated_at    VARCHAR(40)  NOT NULL,
      KEY idx_policy_token (id, token)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_external_bot_configs",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_external_bot_configs (
      provider   VARCHAR(32)  NOT NULL PRIMARY KEY,
      alias      VARCHAR(128) DEFAULT NULL,
      app_id     VARCHAR(128) NOT NULL,
      app_secret VARCHAR(255) DEFAULT NULL,
      domain     VARCHAR(128) DEFAULT NULL,
      enabled    TINYINT      NOT NULL DEFAULT 1,
      status     VARCHAR(32)  DEFAULT NULL,
      status_message VARCHAR(255) DEFAULT NULL,
      last_connected_at VARCHAR(40) DEFAULT NULL,
      created_at VARCHAR(40)  NOT NULL,
      updated_at VARCHAR(40)  NOT NULL,
      KEY idx_enabled (enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_external_bot_bindings",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_external_bot_bindings (
      id               VARCHAR(64)  NOT NULL PRIMARY KEY,
      provider         VARCHAR(32)  NOT NULL,
      tenant_key       VARCHAR(128) NOT NULL,
      chat_id          VARCHAR(128) NOT NULL,
      chat_type        VARCHAR(64)  DEFAULT NULL,
      default_target   VARCHAR(255) DEFAULT NULL,
      default_agent_id VARCHAR(64)  DEFAULT NULL,
      status           VARCHAR(32)  NOT NULL,
      created_at       VARCHAR(40)  NOT NULL,
      updated_at       VARCHAR(40)  NOT NULL,
      UNIQUE KEY uniq_provider_chat (provider, tenant_key, chat_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_external_message_links",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_external_message_links (
      id                       VARCHAR(64)  NOT NULL PRIMARY KEY,
      provider                 VARCHAR(32)  NOT NULL,
      external_conversation_id VARCHAR(255) NOT NULL,
      external_message_id      VARCHAR(255) DEFAULT NULL,
      message_id               VARCHAR(64)  NOT NULL,
      root_message_id          VARCHAR(64)  DEFAULT NULL,
      direction                VARCHAR(16)  NOT NULL,
      created_at               VARCHAR(40)  NOT NULL,
      KEY idx_message (message_id),
      KEY idx_external (provider, external_conversation_id, external_message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    name: "iteam_events",
    ddl: `CREATE TABLE IF NOT EXISTS iteam_events (
      id         VARCHAR(64) NOT NULL PRIMARY KEY,
      type       VARCHAR(64) NOT NULL,
      payload    JSON        NOT NULL,
      created_at VARCHAR(40) NOT NULL,
      KEY idx_type_created (type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  }
];
