import { defaultHome } from "@iteam/shared";
import { JsonStore } from "./json-store.js";
import { MysqlStore } from "./mysql-store.js";
import { SqliteStore } from "./sqlite-store.js";
import type { IStore } from "./types.js";

export type StoreBackend = "json" | "sqlite" | "mysql";

export interface CreateStoreOptions {
  home?: string;
  backend?: StoreBackend;
}

/**
 * Resolve which backend to use, in priority order:
 * 1. explicit options.backend
 * 2. ITEAM_STORE env var
 * 3. default → "sqlite" (local SQLite via better-sqlite3).
 *
 * JSON remains available only as a legacy/dev backend via ITEAM_STORE=json; it
 * does not implement the repository read model used by the supported SQL
 * backends.
 */
function resolveBackend(explicit?: StoreBackend): { backend: StoreBackend; explicit: boolean } {
  if (explicit) return { backend: explicit, explicit: true };
  const fromEnv = String(process.env.ITEAM_STORE || "").toLowerCase().trim();
  if (fromEnv === "sqlite" || fromEnv === "mysql" || fromEnv === "json") {
    return { backend: fromEnv, explicit: true };
  }
  return { backend: "sqlite", explicit: false };
}

/**
 * Create a Store instance. Async because the MySQL backend needs to await its
 * connection pool before the daemon starts using it.
 */
export async function createStore(options: CreateStoreOptions = {}): Promise<IStore> {
  const home = options.home || defaultHome();
  const { backend, explicit } = resolveBackend(options.backend);
  if (backend === "sqlite") {
    try {
      return new SqliteStore(home);
    } catch (error) {
      if (!explicit) {
        console.error(
          `[store] sqlite backend unavailable (${(error as Error).message}). ` +
          `Install better-sqlite3 or set ITEAM_STORE=json for legacy/dev-only local storage.`
        );
      }
      throw error;
    }
  }
  if (backend === "mysql") {
    const store = new MysqlStore(home);
    await store.prepare();
    return store;
  }
  return new JsonStore(home);
}
