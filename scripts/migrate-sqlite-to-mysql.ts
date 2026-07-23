/**
 * One-off migration: copy the local SQLite dataset (~/.iteam/state.db) into the
 * MySQL `iteam` backend.
 *
 * Usage (the iTeam server MUST be stopped first — otherwise it overwrites MySQL
 * with its own in-memory state):
 *   ITEAM_MYSQL_HOST=127.0.0.1 ITEAM_MYSQL_PORT=3306 \
 *   ITEAM_MYSQL_USER=iteam ITEAM_MYSQL_PASSWORD=iteam ITEAM_MYSQL_DATABASE=iteam \
 *     npx tsx scripts/migrate-sqlite-to-mysql.ts
 *
 * The script:
 *   1. boots SqliteStore from $ITEAM_HOME (default ~/.iteam) and loads State,
 *      including artifact content so nothing is dropped
 *   2. boots MysqlStore (creating schema / running column migrations if needed)
 *   3. atomically rewrites MySQL with the full SQLite snapshot
 *   4. re-opens MySQL and prints row counts on both sides for verification
 */
import { defaultHome } from "../packages/shared/src/lib.js";
import { SqliteStore } from "../packages/server/src/store/sqlite-store.js";
import { MysqlStore } from "../packages/server/src/store/mysql-store.js";
import type { State } from "../packages/shared/src/types.js";

async function main(): Promise<void> {
  const home = process.env.ITEAM_HOME || defaultHome();
  console.log(`[migrate] home: ${home}`);

  console.log("[migrate] opening SQLite source ...");
  const sqlite = new SqliteStore(home);
  // Include artifact content so file/output artifacts survive the copy.
  const sqliteSnapshot = sqlite.snapshot({ includeArtifactContent: true });
  printSummary("sqlite", sqliteSnapshot);

  console.log("[migrate] connecting MySQL target ...");
  const mysql = new MysqlStore(home);
  await mysql.prepare();
  printSummary("mysql (before)", mysql.snapshot());

  console.log("[migrate] writing snapshot to MySQL ...");
  mysql.mutate<void>(state => {
    // Copy every collection from the SQLite snapshot. Object.assign avoids a
    // hand-maintained field list (which previously missed `spaces`,
    // `scheduledTasks`, delivery events/artifacts, and external tables).
    Object.assign(state, sqliteSnapshot);
  });

  // Wait for the serial write chain to drain before exiting.
  await mysql.close();
  if (typeof sqlite.close === "function") await sqlite.close();

  // Re-open MySQL to verify counts round-trip.
  const verify = new MysqlStore(home);
  await verify.prepare();
  printSummary("mysql (after)", verify.snapshot());
  await verify.close();

  console.log("[migrate] done.");
}

function printSummary(label: string, state: State): void {
  console.log(
    `[${label}] spaces=${state.spaces?.length ?? 0} humans=${state.humans.length} ` +
      `computers=${state.computers.length} pending=${state.pendingComputerConnections.length} ` +
      `agents=${state.agents.length} channels=${state.channels.length} ` +
      `messages=${state.messages.length} tasks=${state.tasks.length} ` +
      `scheduledTasks=${state.scheduledTasks?.length ?? 0} deliveries=${state.deliveries.length} ` +
      `events=${state.events.length}`
  );
}

main().catch(err => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
