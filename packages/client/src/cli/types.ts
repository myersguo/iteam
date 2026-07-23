import type { ApiClient } from "./client.js";
import type { Args } from "./args.js";
import type { OutputOptions } from "./output.js";
import type { ResolvedContext } from "./config.js";

/** Everything a command module needs to run one invocation. */
export interface CommandContext {
  client: ApiClient;
  ctx: ResolvedContext;
  args: Args;
  action: string | undefined;
  output: OutputOptions;
  /** Global overrides parsed by the dispatcher (server/space/token). */
  overrides: { serverUrl?: string; token?: string; spaceId?: string };
  /** True when --yes was passed; skips destructive-op confirmation. */
  assumeYes: boolean;
}

export type CommandHandler = (cmd: CommandContext) => Promise<void>;
