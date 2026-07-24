/**
 * Backward-compatible re-export. The implementation lives in `./store/`
 * and is selected at runtime via `createStore()` (default backend: SQLite).
 *
 * Legacy code path:  `import { Store } from "./store.js"`
 *   → still works; `Store` is the concrete JsonStore class, retained only for
 *     legacy/dev-only local storage.
 *
 * Preferred path:    `import { createStore } from "./store/index.js"`
 *   → returns an `IStore` whose backend is picked by `ITEAM_STORE`; SQLite and
 *     MySQL are the supported repository-backed backends.
 */
export { JsonStore as Store } from "./store/json-store.js";
export {
  createStore,
  BaseStore,
  initialState,
  sanitizeState,
  JsonStore,
  SqliteStore,
  MysqlStore
} from "./store/index.js";
export type {
  IStore,
  StateListener,
  StateMutator,
  StoreBackend,
  CreateStoreOptions
} from "./store/index.js";
