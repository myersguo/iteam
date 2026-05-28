import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeInfo } from "./types.js";

export function detectRuntimes(): RuntimeInfo[] {
  const path = process.env.PATH || "";
  const bins = path.split(":");
  const has = (name: string): boolean => bins.some(dir => {
    try {
      return existsSync(join(dir, name));
    } catch {
      return false;
    }
  });
  return [
    { id: "codex", name: "Codex CLI", installed: has("codex") },
    { id: "claude", name: "Claude Code", installed: has("claude") },
    { id: "gemini", name: "Gemini CLI", installed: has("gemini") },
    { id: "opencode", name: "OpenCode", installed: has("opencode") },
    { id: "trae", name: "Trae CLI (traecli)", installed: has("traecli") || has("traecli") || has("trae-agent") }
  ];
}
