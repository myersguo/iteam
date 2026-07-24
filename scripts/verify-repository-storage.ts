import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { IteamCore } from "../packages/server/src/core.js";
import { SqlIteamRepository } from "../packages/server/src/repository/sql-repository.js";
import { MysqlStore } from "../packages/server/src/store/mysql-store.js";
import { SqliteStore } from "../packages/server/src/store/sqlite-store.js";

const requireCjs = createRequire(import.meta.url);

interface SqliteDatabase {
  prepare(sql: string): {
    run: (...params: unknown[]) => unknown;
    get: (...params: unknown[]) => unknown;
  };
}

async function exerciseStore(store: SqliteStore | MysqlStore, db: {
  setMessageText(id: string, text: string): Promise<void> | void;
  getMessageText(id: string): Promise<string | undefined> | string | undefined;
}) {
  const core = await IteamCore.create({
    store,
    serverInviteRoot: process.cwd(),
    clock: () => "2026-01-01T00:00:00.000Z",
    idGenerator: (() => {
      let n = 0;
      return (prefix: string) => `${prefix}_${++n}`;
    })()
  });

  const message = core.createMessage({
    target: "#all",
    text: "from-memory",
    authorId: "human-local",
    spaceId: "space_default"
  });

  await db.setMessageText(message.id, "from-database");
  const messages = await core.listMessagesByTarget({
    target: "#all",
    spaceId: "space_default",
    limit: 10
  });
  const reloaded = messages.find(item => item.id === message.id);
  if (!reloaded) throw new Error("repository-backed message was not returned");
  if (reloaded.text !== "from-database") {
    throw new Error(`expected repository read from database, got ${JSON.stringify(reloaded.text)}`);
  }

  await db.setMessageText(message.id, "from-database-channel");
  const channelMessages = await core.listMessagesByChannel({
    channelId: "#all",
    spaceId: "space_default",
    limit: 10
  });
  const channelReloaded = channelMessages.find(item => item.id === message.id);
  if (channelReloaded?.text !== "from-database-channel") {
    throw new Error(`expected channel repository read from database, got ${JSON.stringify(channelReloaded?.text)}`);
  }

  const unrelated = core.createMessage({
    target: "#all",
    text: "unrelated-write",
    authorId: "human-local",
    spaceId: "space_default"
  });

  const beforeUnrelated = await core.listMessagesByTarget({
    target: "#all",
    spaceId: "space_default",
    limit: 10,
    before: unrelated.id
  });
  if (beforeUnrelated.some(item => item.id === unrelated.id)) {
    throw new Error("repository pagination included the cursor message");
  }
  if (!beforeUnrelated.some(item => item.id === message.id)) {
    throw new Error("repository pagination did not return messages before the cursor id");
  }

  const afterUnrelatedWrite = await db.getMessageText(message.id);
  if (afterUnrelatedWrite !== "from-database-channel") {
    throw new Error(`expected incremental SQL persist to preserve external DB edit, got ${JSON.stringify(afterUnrelatedWrite)}`);
  }

  await db.setMessageText(message.id, "from-database-state");
  const state = await core.readStateForSpace("space_default");
  const stateMessage = state.messages.find(item => item.id === message.id);
  if (stateMessage?.text !== "from-database-state") {
    throw new Error(`expected DB-backed state read, got ${JSON.stringify(stateMessage?.text)}`);
  }
}

async function verifySqlite() {
  const home = mkdtempSync(join(tmpdir(), "iteam-repository-storage-"));
  const dbFile = join(home, "state.db");
  const store = new SqliteStore(home, dbFile);
  try {
    const BetterSqlite3 = requireCjs("better-sqlite3") as new (path: string) => SqliteDatabase;
    const db = new BetterSqlite3(dbFile);
    await exerciseStore(store, {
      setMessageText: (id: string, text: string) => {
        db.prepare("UPDATE iteam_messages SET text = ? WHERE id = ?").run(text, id);
      },
      getMessageText: (id: string) => {
        const row = db.prepare("SELECT text FROM iteam_messages WHERE id = ?").get(id) as { text?: string } | undefined;
        return row?.text;
      }
    });
  } finally {
    await store.close?.();
    rmSync(home, { recursive: true, force: true });
  }
}

async function verifyMysqlIfConfigured() {
  const driver = requireCjs("mysql2/promise");
  const host = process.env.ITEAM_VERIFY_MYSQL_HOST || "127.0.0.1";
  const port = Number(process.env.ITEAM_VERIFY_MYSQL_PORT || "3306");
  const user = process.env.ITEAM_VERIFY_MYSQL_USER || "iteam";
  const password = process.env.ITEAM_VERIFY_MYSQL_PASSWORD || "iteam";
  const database = `iteam_verify_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const admin = await driver.createConnection({ host, port, user, password });
  const previous = {
    ITEAM_STORE: process.env.ITEAM_STORE,
    ITEAM_MYSQL_HOST: process.env.ITEAM_MYSQL_HOST,
    ITEAM_MYSQL_PORT: process.env.ITEAM_MYSQL_PORT,
    ITEAM_MYSQL_USER: process.env.ITEAM_MYSQL_USER,
    ITEAM_MYSQL_PASSWORD: process.env.ITEAM_MYSQL_PASSWORD,
    ITEAM_MYSQL_DATABASE: process.env.ITEAM_MYSQL_DATABASE
  };
  const home = mkdtempSync(join(tmpdir(), "iteam-repository-mysql-"));
  let store: MysqlStore | null = null;
  let createdDatabase = false;
  try {
    try {
      await admin.query(`CREATE DATABASE \`${database}\``);
      createdDatabase = true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ER_DBACCESS_DENIED_ERROR" || code === "ER_DB_CREATE_EXISTS") {
        console.log(`SKIP: MySQL repository storage verification needs CREATE DATABASE privilege (${code})`);
        return;
      }
      throw error;
    }
    process.env.ITEAM_MYSQL_HOST = host;
    process.env.ITEAM_MYSQL_PORT = String(port);
    process.env.ITEAM_MYSQL_USER = user;
    process.env.ITEAM_MYSQL_PASSWORD = password;
    process.env.ITEAM_MYSQL_DATABASE = database;
    store = new MysqlStore(home);
    await store.prepare();
    const conn = await driver.createConnection({ host, port, user, password, database });
    try {
      await exerciseStore(store, {
        setMessageText: async (id: string, text: string) => {
          await conn.query("UPDATE iteam_messages SET text = ? WHERE id = ?", [text, id]);
        },
        getMessageText: async (id: string) => {
          const [rows] = await conn.query("SELECT text FROM iteam_messages WHERE id = ?", [id]);
          return rows[0]?.text;
        }
      });
    } finally {
      await conn.end();
    }
    console.log("OK: repository-backed MySQL reads use database state");
  } finally {
    if (store) await store.close?.();
    if (createdDatabase) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function verifyMysqlRepositoryWithTemporaryTables() {
  const driver = requireCjs("mysql2/promise");
  const host = process.env.ITEAM_VERIFY_MYSQL_HOST || "127.0.0.1";
  const port = Number(process.env.ITEAM_VERIFY_MYSQL_PORT || "3306");
  const user = process.env.ITEAM_VERIFY_MYSQL_USER || "iteam";
  const password = process.env.ITEAM_VERIFY_MYSQL_PASSWORD || "iteam";
  const database = process.env.ITEAM_VERIFY_MYSQL_DATABASE || "iteam";
  const conn = await driver.createConnection({ host, port, user, password, database });
  try {
    await conn.query("CREATE TEMPORARY TABLE iteam_messages (id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(64), target VARCHAR(255), author_id VARCHAR(64), type VARCHAR(32), text MEDIUMTEXT, mentions JSON, created_at VARCHAR(40), thread_id VARCHAR(64), task_id VARCHAR(64))");
    await conn.query("CREATE TEMPORARY TABLE iteam_channels (id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(64), name VARCHAR(255), target VARCHAR(255), kind VARCHAR(32), description TEXT, default_agent_id VARCHAR(64), created_at VARCHAR(40))");
    await conn.query("CREATE TEMPORARY TABLE iteam_channel_members (channel_id VARCHAR(64), member_id VARCHAR(64), PRIMARY KEY (channel_id, member_id))");
    await conn.query("CREATE TEMPORARY TABLE iteam_deliveries (id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(64), message_id VARCHAR(64), root_message_id VARCHAR(64), parent_delivery_id VARCHAR(64), depth INT, agent_id VARCHAR(64), computer_id VARCHAR(64), target VARCHAR(255), session_key VARCHAR(255), source VARCHAR(64), status VARCHAR(32), attempts INT, created_at VARCHAR(40), updated_at VARCHAR(40), error MEDIUMTEXT, lifecycle JSON)");
    await conn.query("CREATE TEMPORARY TABLE iteam_delivery_events (id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(64), delivery_id VARCHAR(64), agent_id VARCHAR(64), target VARCHAR(255), kind VARCHAR(32), title TEXT, text MEDIUMTEXT, tool_name TEXT, tool_call_id TEXT, status VARCHAR(32), sequence INT, created_at VARCHAR(40), payload JSON)");
    await conn.query("CREATE TEMPORARY TABLE iteam_delivery_artifacts (id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(64), delivery_id VARCHAR(64), event_id VARCHAR(64), agent_id VARCHAR(64), target VARCHAR(255), kind VARCHAR(64), title VARCHAR(255), summary TEXT, mime VARCHAR(128), size INT, sha256 VARCHAR(64), storage VARCHAR(64), path TEXT, relative_path TEXT, content MEDIUMTEXT, metadata JSON, created_at VARCHAR(40))");
    await conn.query("INSERT INTO iteam_channels (id, space_id, name, target, kind, description, default_agent_id, created_at) VALUES ('chan_all', 'space_default', 'all', '#all', 'channel', 'All', NULL, '2026-01-01T00:00:00.000Z')");
    await conn.query("INSERT INTO iteam_messages (id, space_id, target, author_id, type, text, mentions, created_at, thread_id, task_id) VALUES ('msg_1', 'space_default', '#all', 'human-local', 'human', 'mysql-temp-message', '[]', '2026-01-01T00:00:01.000Z', NULL, NULL)");
    await conn.query("INSERT INTO iteam_deliveries (id, space_id, message_id, root_message_id, parent_delivery_id, depth, agent_id, computer_id, target, session_key, source, status, attempts, created_at, updated_at, error, lifecycle) VALUES ('delivery_1', 'space_default', 'msg_1', 'msg_1', NULL, 2, 'agent_1', 'computer_1', '#all', NULL, NULL, 'done', 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z', NULL, '[]')");
    await conn.query("INSERT INTO iteam_delivery_events (id, space_id, delivery_id, agent_id, target, kind, title, text, tool_name, tool_call_id, status, sequence, created_at, payload) VALUES ('event_1', 'space_default', 'delivery_1', 'agent_1', '#all', 'message_delta', 'Draft', 'mysql-temp-event', NULL, NULL, 'streaming', 1, '2026-01-01T00:00:03.000Z', JSON_OBJECT('ok', true))");
    await conn.query("INSERT INTO iteam_delivery_artifacts (id, space_id, delivery_id, event_id, agent_id, target, kind, title, summary, mime, size, sha256, storage, path, relative_path, content, metadata, created_at) VALUES ('artifact_1', 'space_default', 'delivery_1', 'event_1', 'agent_1', '#all', 'tool_output', 'Output', NULL, 'text/plain', 16, NULL, 'db', NULL, NULL, 'mysql-temp-artifact', JSON_OBJECT('kind', 'temp'), '2026-01-01T00:00:04.000Z')");
    const repository = new SqlIteamRepository({
      all: async <T = unknown>(sql: string, params: unknown[] = []) => {
        const [rows] = await conn.query(sql, params);
        return rows as T[];
      },
      get: async <T = unknown>(sql: string, params: unknown[] = []) => {
        const [rows] = await conn.query(sql, params);
        return Array.isArray(rows) && rows[0] ? rows[0] as T : null;
      }
    });
    const messages = await repository.listMessagesByTarget({ target: "#all", spaceId: "space_default", limit: 10 });
    if (messages[0]?.text !== "mysql-temp-message") throw new Error("MySQL temporary repository message read failed");
    const channelMessages = await repository.listMessagesByChannel({ channelId: "#all", spaceId: "space_default", limit: 10 });
    if (channelMessages[0]?.depth !== 2) throw new Error("MySQL temporary repository channel/depth read failed");
    const events = await repository.listDeliveryEvents({ deliveryId: "delivery_1", spaceId: "space_default", limit: 10 });
    if (events[0]?.text !== "mysql-temp-event") throw new Error("MySQL temporary repository event read failed");
    const artifact = await repository.getDeliveryArtifact("artifact_1", "space_default");
    if (artifact?.content !== "mysql-temp-artifact") throw new Error("MySQL temporary repository artifact read failed");
    console.log("OK: MySQL repository SQL works with temporary tables");
  } finally {
    await conn.end();
  }
}

async function main() {
  await verifySqlite();
  console.log("OK: repository-backed SQLite reads use database state");
  if (process.env.ITEAM_VERIFY_MYSQL === "1") {
    await verifyMysqlRepositoryWithTemporaryTables();
    await verifyMysqlIfConfigured();
  } else {
    console.log("SKIP: set ITEAM_VERIFY_MYSQL=1 to verify MySQL repository storage");
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
