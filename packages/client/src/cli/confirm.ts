// Interactive confirmation for destructive commands. Skipped when --yes is set
// or when stdin is not a TTY (so scripted/piped usage never blocks — callers
// must pass --yes explicitly in that case).

import { createInterface } from "node:readline";
import type { CommandContext } from "./types.js";

export function confirmDestructive(cmd: CommandContext, action: string): Promise<boolean> {
  if (cmd.assumeYes) return Promise.resolve(true);
  if (!process.stdin.isTTY) {
    throw new Error(`refusing to ${action} without confirmation; re-run with --yes`);
  }
  return new Promise<boolean>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Are you sure you want to ${action}? [y/N] `, answer => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
