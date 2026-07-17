import type { State, StoreEvent } from "../types.js";

export type StateMutator<T> = (state: State) => T;
export type StateListener = (event: StoreEvent) => void;

/**
 * Common interface every storage backend has to implement.
 * Backends differ only in how they persist `state` — the in-memory shape and
 * mutate/emit/subscribe semantics stay identical so callers (daemon / runtime
 * / workspace) never have to special-case the backend.
 */
export interface IStore {
  /** iTeam home directory (where ./agents lives). Always file-system path. */
  readonly home: string;
  /** Per-agent workspace root, derived from `home`. */
  readonly agentRoot: string;
  /** Returns a deep-cloned snapshot, safe to hand to consumers. */
  snapshot(options?: { includeArtifactContent?: boolean }): State;
  /** Atomically run a state mutation. The returned value is forwarded as-is. */
  mutate<T>(fn: StateMutator<T>): T;
  /** Push an event into the state.events ring and notify subscribers. */
  emit(type: string, payload: unknown): void;
  /** Register a listener; returns an unsubscribe function. */
  subscribe(listener: StateListener): () => void;
  /** Close any underlying resources (DB handles, etc). Optional for JSON. */
  close?(): Promise<void> | void;
}
