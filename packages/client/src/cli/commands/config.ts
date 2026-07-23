// `iteam config ...` — inspect and edit the persisted CLI config
// ($ITEAM_HOME/cli.json): server URL, active space, token, and profiles.

import { loadConfig, saveConfig, activeProfile, configPath } from "../config.js";
import { printResult, printMessage } from "../output.js";
import type { CommandContext } from "../types.js";

const SETTABLE = new Set(["serverUrl", "token", "spaceId"]);

export async function runConfig(cmd: CommandContext): Promise<void> {
  switch (cmd.action) {
    case "list":
    case undefined:
      return listConfig(cmd);
    case "get":
      return get(cmd);
    case "set":
      return set(cmd);
    case "use-profile":
      return useProfile(cmd);
    case "path":
      return printMessage(configPath(), cmd.output, { path: configPath() });
    default:
      throw new Error("usage: iteam config list|get <key>|set <key> <value>|use-profile <name>|path");
  }
}

/** Never print the raw token; show whether one is configured. */
function redact(config: ReturnType<typeof loadConfig>): unknown {
  const profiles: Record<string, unknown> = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    profiles[name] = { ...profile, token: profile.token ? "configured" : undefined };
  }
  return { activeProfile: config.activeProfile, profiles };
}

async function listConfig(cmd: CommandContext): Promise<void> {
  printResult(redact(loadConfig()), cmd.output);
}

async function get(cmd: CommandContext): Promise<void> {
  const key = cmd.args.positionals[0];
  if (!key) throw new Error("usage: iteam config get <serverUrl|token|spaceId|activeProfile>");
  const config = loadConfig();
  if (key === "activeProfile") return printMessage(config.activeProfile, cmd.output, { activeProfile: config.activeProfile });
  const profile = activeProfile(config);
  const value = key === "token" ? (profile.token ? "configured" : "") : profile[key];
  printMessage(String(value ?? ""), cmd.output, { [key]: value ?? null });
}

async function set(cmd: CommandContext): Promise<void> {
  const [key, value] = cmd.args.positionals;
  if (!key || value === undefined) throw new Error("usage: iteam config set <serverUrl|token|spaceId> <value>");
  if (!SETTABLE.has(key)) throw new Error(`unknown key "${key}"; settable: ${[...SETTABLE].join(", ")}`);
  const config = loadConfig();
  const profile = activeProfile(config);
  profile[key] = value;
  config.profiles[config.activeProfile] = profile;
  saveConfig(config);
  printMessage(`set ${key} on profile "${config.activeProfile}"`, cmd.output, { ok: true });
}

async function useProfile(cmd: CommandContext): Promise<void> {
  const name = cmd.args.positionals[0];
  if (!name) throw new Error("usage: iteam config use-profile <name>");
  const config = loadConfig();
  if (!config.profiles[name]) config.profiles[name] = { serverUrl: "http://127.0.0.1:4318" };
  config.activeProfile = name;
  saveConfig(config);
  printMessage(`active profile -> ${name}`, cmd.output, { activeProfile: name });
}
