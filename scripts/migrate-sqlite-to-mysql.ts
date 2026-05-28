/**
 * One-off migration: copy ~/.iteam/state.db (SQLite, 10 tables) → MySQL `iteam` (10 tables).
 *
 * Usage:
 *   ITEAM_MYSQL_URL=mysql://root:pwd@127.0.0.1:3306/iteam \
 *     npx tsx scripts/migrate-sqlite-to-mysql.ts
 *
 * The script:
 *   1. boots SqliteStore from $ITEAM_HOME (default ~/.iteam) and loads State
 *   2. boots MysqlStore (creating schema if needed)
 *   3. atomically rewrites MySQL with the SQLite snapshot
 *   4. prints row counts on both sides for verification
 */
import { defaultHome } from "../src/lib.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { MysqlStore } from "../src/store/mysql-store.js";
import type { State } from "../src/types.js";

async function main(): Promise<void> {
  const home = process.env.ITEAM_HOME || defaultHome();
  console.log(`[migrate] home: ${home}`);

  console.log("[migrate] opening SQLite source ...");
  const sqlite = new SqliteStore(home);
  const sqliteSnapshot = sqlite.snapshot();
  printSummary("sqlite", sqliteSnapshot);

  console.log("[migrate] connecting MySQL target ...");
  const mysql = new MysqlStore(home);
  await mysql.prepare();
  const mysqlBefore = mysql.snapshot();
  printSummary("mysql (before)", mysqlBefore);

  console.log("[migrate] writing snapshot to MySQL ...");
  mysql.mutate<void>(state => {
    // wipe in-memory and copy each collection across
    state.meta = sqliteSnapshot.meta;
    state.computers = sqliteSnapshot.computers;
    state.pendingComputerConnections = sqliteSnapshot.pendingComputerConnections;
    state.humans = sqliteSnapshot.humans;
    state.agents = sqliteSnapshot.agents;
    state.channels = sqliteSnapshot.channels;
    state.messages = sqliteSnapshot.messages;
    state.deliveries = sqliteSnapshot.deliveries;
    state.tasks = sqliteSnapshot.tasks;
    state.events = sqliteSnapshot.events;
  });

  // wait for the serial write chain to drain before exiting
  await mysql.close();
  sqlite.close();

  // Re-open MySQL to verify counts
  const verify = new MysqlStore(home);
  await verify.prepare();
  printSummary("mysql (after)", verify.snapshot());
  await verify.close();

  console.log("[migrate] done.");
}

function printSummary(label: string, state: State): void {
  console.log(
    `[${label}] humans=${state.humans.length} computers=${state.computers.length} ` +
      `pending=${state.pendingComputerConnections.length} agents=${state.agents.length} ` +
      `channels=${state.channels.length} messages=${state.messages.length} ` +
      `tasks=${state.tasks.length} deliveries=${state.deliveries.length} ` +
      `events=${state.events.length}`
  );
}

main().catch(err => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
