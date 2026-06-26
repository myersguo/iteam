import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, DeliveryWithContext } from "../types.js";

export interface RuntimeProfile {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  output?: {
    includeStderr?: boolean;
    trim?: boolean;
    stripAnsi?: boolean;
  };
}

export interface ResolvedRuntimeProfile extends RuntimeProfile {
  name: string;
}

const BUILTIN_RUNTIME_PROFILES: Record<string, RuntimeProfile> = {
  opencode: {
    command: "opencode",
    args: ["run", "--", "{{prompt}}"],
    timeoutMs: 300_000
  }
};

export function resolveRuntimeProfile(runtime: string): ResolvedRuntimeProfile | null {
  const profiles = loadConfiguredProfiles();
  const profile = profiles[runtime] || BUILTIN_RUNTIME_PROFILES[runtime];
  return profile ? { name: runtime, ...profile } : null;
}

export function listRuntimeProfileNames(): string[] {
  return [...new Set([
    ...Object.keys(BUILTIN_RUNTIME_PROFILES),
    ...Object.keys(loadConfiguredProfiles())
  ])].sort();
}

export function renderProfileValue(
  value: string,
  params: { agent: Agent; delivery: DeliveryWithContext; prompt: string; timeoutMs: number }
): string {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => {
    switch (key) {
      case "prompt":
        return params.prompt;
      case "sessionKey":
        return params.delivery.sessionKey || "";
      case "safeSessionKey":
        return safeSessionKey(params.delivery.sessionKey || params.delivery.id);
      case "agentId":
        return params.agent.id;
      case "agentName":
        return params.agent.name;
      case "model":
        return params.agent.model || "";
      case "modelArgs":
        return params.agent.model ? `-m ${params.agent.model}` : "";
      case "timeoutSeconds":
        return String(Math.floor(params.timeoutMs / 1000));
      default:
        if (key.startsWith("env.")) return process.env[key.slice(4)] || "";
        return match;
    }
  });
}

export function renderProfileArgs(
  profile: RuntimeProfile,
  params: { agent: Agent; delivery: DeliveryWithContext; prompt: string; timeoutMs: number }
): string[] {
  return (profile.args || []).flatMap(arg => {
    const rendered = renderProfileValue(arg, params);
    return rendered ? [rendered] : [];
  });
}

export function renderProfileEnv(
  profile: RuntimeProfile,
  params: { agent: Agent; delivery: DeliveryWithContext; prompt: string; timeoutMs: number }
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(profile.env || {}).map(([key, value]) => [key, renderProfileValue(value, params)])
  );
}

function loadConfiguredProfiles(): Record<string, RuntimeProfile> {
  const file = process.env.ITEAM_RUNTIME_PROFILES;
  if (!file || !existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, RuntimeProfile>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn(`[runtime-profile] failed to read ${file}: ${(error as Error).message}`);
    return {};
  }
}

function safeSessionKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96) || "iteam";
}

export function expandProfileCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  if (cwd === "~") return process.env.HOME;
  if (cwd.startsWith("~/")) return process.env.HOME ? join(process.env.HOME, cwd.slice(2)) : cwd;
  return cwd;
}
