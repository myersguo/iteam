import type { State, StoreEvent } from "@iteam/shared";
import type { IteamRepository } from "../repository/types.js";

export type StateMutator<T> = (state: State) => T;
export type StateListener = (event: StoreEvent) => void;

export interface MutateOptions {
  /**
   * Skip the automatic `state:changed` emit after this mutation. Used by
   * high-frequency writes (streaming delivery events) that emit their own
   * narrower event instead, so consumers don't trigger a full refresh per
   * token/delta. State is still persisted.
   */
  silent?: boolean;
}

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
  mutate<T>(fn: StateMutator<T>, options?: MutateOptions): T;
  /** Push an event into the state.events ring and notify subscribers. */
  emit(type: string, payload: unknown): void;
  /**
   * Notify subscribers of an event WITHOUT persisting the whole state. Used for
   * high-frequency notifications (streaming delivery events) whose durable data
   * was already written by a preceding mutate(); avoids a full-snapshot write
   * per delta.
   */
  notify(type: string, payload: unknown): void;
  /** Register a listener; returns an unsubscribe function. */
  subscribe(listener: StateListener): () => void;
  /**
   * Database-backed repository for persistent business reads. SQL backends
   * implement this so user-visible reads do not depend on the process-local
   * State snapshot. Legacy/dev stores may leave it undefined.
   */
  readonly repository?: IteamRepository;
  /** Rebuild persistent state from the backing store. SQL backends implement
   * this for DB-authoritative aggregate reads such as `/api/state`; legacy/dev
   * stores may omit it and continue using the in-memory snapshot. */
  readState?(): Promise<State>;
  /** Wait for queued asynchronous writes to reach the backing store. */
  flush?(): Promise<void>;
  /** Close any underlying resources (DB handles, etc). Optional for JSON. */
  close?(): Promise<void> | void;
}
