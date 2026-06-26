import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State } from "../types.js";
import { BaseStore, initialState } from "./base.js";

/**
 * Default backend: a single JSON file at <home>/state.json.
 */
export class JsonStore extends BaseStore {
  readonly file: string;

  constructor(home: string) {
    super(home);
    this.file = join(home, "state.json");
    const loaded = this.load();
    this.setStateAfterLoad(loaded);
  }

  protected load(): State {
    if (!existsSync(this.file)) {
      const seed = initialState();
      writeFileSync(this.file, JSON.stringify(seed, null, 2));
      return seed;
    }
    return JSON.parse(readFileSync(this.file, "utf8")) as State;
  }

  // TODO(perf): make this async and debounce; today only addresses atomicity.
  protected persist(state: State): void {
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`;
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, this.file);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup only.
      }
      throw error;
    }
  }
}
