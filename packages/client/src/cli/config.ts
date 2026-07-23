// Persistent CLI configuration: multi-profile server URLs, session tokens, and
// the active space. Stored at $ITEAM_HOME/cli.json (default ~/.iteam/cli.json).
//
// Resolution order for any single value is: explicit flag (handled by the
// caller) > environment variable > config file > built-in default.

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { defaultHome } from "@iteam/shared";

export interface CliProfile {
  serverUrl: string;
  token?: string;
  spaceId?: string;
  [key: string]: string | undefined;
}

export interface CliConfig {
  activeProfile: string;
  profiles: Record<string, CliProfile>;
}

export interface ResolvedContext {
  serverUrl: string;
  token?: string;
  spaceId?: string;
  profileName: string;
}

const DEFAULT_SERVER_URL = "http://127.0.0.1:4318";
const DEFAULT_PROFILE = "default";

export function configPath(): string {
  return join(defaultHome(), "cli.json");
}

export function loadConfig(): CliConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    const profiles = parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {};
    const activeProfile = parsed.activeProfile && profiles[parsed.activeProfile] ? parsed.activeProfile : DEFAULT_PROFILE;
    if (!profiles[activeProfile]) profiles[activeProfile] = { serverUrl: DEFAULT_SERVER_URL };
    return { activeProfile, profiles };
  } catch {
    return { activeProfile: DEFAULT_PROFILE, profiles: { [DEFAULT_PROFILE]: { serverUrl: DEFAULT_SERVER_URL } } };
  }
}

export function saveConfig(config: CliConfig): void {
  const home = defaultHome();
  mkdirSync(home, { recursive: true });
  const file = configPath();
  writeFileSync(file, JSON.stringify(config, null, 2));
  // The file can hold a session token, so keep it owner-only.
  try { chmodSync(file, 0o600); } catch { /* best effort on platforms without chmod */ }
}

/** Return the active profile, creating a default one when missing. */
export function activeProfile(config: CliConfig): CliProfile {
  const profile = config.profiles[config.activeProfile];
  if (profile) return profile;
  const created: CliProfile = { serverUrl: DEFAULT_SERVER_URL };
  config.profiles[config.activeProfile] = created;
  return created;
}

export function updateActiveProfile(patch: Partial<CliProfile>): CliConfig {
  const config = loadConfig();
  const profile = activeProfile(config);
  config.profiles[config.activeProfile] = { ...profile, ...patch };
  saveConfig(config);
  return config;
}

export interface ContextOverrides {
  serverUrl?: string;
  token?: string;
  spaceId?: string;
}

/**
 * Merge flags, environment, and config into the concrete context used for a
 * single command invocation. Flags are passed in by the dispatcher.
 */
export function resolveContext(overrides: ContextOverrides = {}): ResolvedContext {
  const config = loadConfig();
  const profile = activeProfile(config);
  const serverUrl =
    overrides.serverUrl ||
    process.env.ITEAM_URL ||
    profile.serverUrl ||
    DEFAULT_SERVER_URL;
  const token = overrides.token || process.env.ITEAM_TOKEN || profile.token || undefined;
  const spaceId = overrides.spaceId || process.env.ITEAM_SPACE_ID || profile.spaceId || undefined;
  return {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    token,
    spaceId,
    profileName: config.activeProfile
  };
}
