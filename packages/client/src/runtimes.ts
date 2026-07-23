import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { RuntimeInfo } from "@iteam/shared";
import { listAcpRuntimeProfileNames, resolveAcpRuntimeProfile } from "./runtime/acp-profiles.js";
import { listRuntimeProfileNames, resolveRuntimeProfile } from "./runtime/profiles.js";

export function detectRuntimes(): RuntimeInfo[] {
  const path = process.env.PATH || "";
  const bins = path.split(":").filter(Boolean);
  const has = (name: string): boolean => {
    try {
      if (isAbsolute(name) || name.includes("/")) return existsSync(name);
      return bins.some(dir => existsSync(join(dir, name)));
    } catch {
      return false;
    }
  };
  const builtins: RuntimeInfo[] = [
    { id: "codex", name: "Codex CLI", installed: has("codex") },
    { id: "claude", name: "Claude Code", installed: has("claude") },
    { id: "gemini", name: "Gemini CLI", installed: has("gemini") },
    { id: "opencode", name: "OpenCode", installed: has("opencode") },
    { id: "trae", name: "Trae CLI (traecli)", installed: has("traecli") || has("trae-agent") }
  ];
  const byId = new Map(builtins.map(runtime => [runtime.id, runtime]));
  for (const id of listAcpRuntimeProfileNames()) {
    const profile = resolveAcpRuntimeProfile(id);
    if (!profile) continue;
    byId.set(id, {
      id,
      name: `${id} (ACP)`,
      installed: has(profile.command)
    });
  }
  for (const id of listRuntimeProfileNames()) {
    const profile = resolveRuntimeProfile(id);
    if (!profile || byId.has(id)) continue;
    byId.set(id, {
      id,
      name: `${id} (profile)`,
      installed: has(profile.command)
    });
  }
  return [...byId.values()];
}
