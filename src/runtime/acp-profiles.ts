import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Agent } from "../types.js";
import type { AgentWorkspaceLayout } from "../workspace.js";
import { expandProfileCwd } from "./profiles.js";

export interface AcpRuntimeProfile {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  poolSize?: number;
}

export interface ResolvedAcpRuntimeProfile extends AcpRuntimeProfile {
  name: string;
}

const TRAEX_ACP_RUNTIME_PROFILE: AcpRuntimeProfile = {
  command: "traex",
  args: [
    "{{modelConfigArgs}}",
    "--add-dir", "{{workspaceDir}}",
    "acp", "serve",
    "--yolo",
    "--disallowed-tool", "EnterPlanMode",
    "--disallowed-tool", "ExitPlanMode"
  ]
};

const BUILTIN_ACP_RUNTIME_PROFILES: Record<string, AcpRuntimeProfile> = {
  trae: {
    ...TRAEX_ACP_RUNTIME_PROFILE,
    command: "traecli"
  },
  traex: TRAEX_ACP_RUNTIME_PROFILE,
  gemini: {
    command: "gemini",
    args: ["{{modelArgs}}", "--acp", "--yolo", "--skip-trust", "--include-directories", "{{workspaceDir}}"]
  },
  hermes: {
    command: "hermes",
    args: ["acp"]
  }
};

export function resolveAcpRuntimeProfile(runtime: string): ResolvedAcpRuntimeProfile | null {
  const profiles = loadConfiguredAcpProfiles();
  const profile = profiles[runtime] || BUILTIN_ACP_RUNTIME_PROFILES[runtime];
  if (profile) return { name: runtime, ...profile };
  if (runtime && commandExists(runtime)) {
    return {
      name: runtime,
      command: runtime,
      args: ["acp", "serve"]
    };
  }
  return null;
}

export function listAcpRuntimeProfileNames(): string[] {
  return [...new Set([
    ...Object.keys(BUILTIN_ACP_RUNTIME_PROFILES),
    ...Object.keys(loadConfiguredAcpProfiles())
  ])].sort();
}

export function renderAcpProfileArgs(
  profile: AcpRuntimeProfile,
  params: { agent: Agent; workspace: AgentWorkspaceLayout; timeoutMs: number }
): string[] {
  return (profile.args || []).flatMap(arg => {
    if (/^\{\{\s*modelArgs\s*\}\}$/.test(arg)) {
      return params.agent.model ? ["-m", params.agent.model] : [];
    }
    if (/^\{\{\s*modelConfigArgs\s*\}\}$/.test(arg)) {
      return params.agent.model ? ["-c", `model=${JSON.stringify(params.agent.model)}`] : [];
    }
    const rendered = renderAcpProfileValue(arg, params);
    return rendered ? [rendered] : [];
  });
}

export function renderAcpProfileEnv(
  profile: AcpRuntimeProfile,
  params: { agent: Agent; workspace: AgentWorkspaceLayout; timeoutMs: number }
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(profile.env || {}).map(([key, value]) => [key, renderAcpProfileValue(value, params)])
  );
}

export function renderAcpProfileCwd(
  profile: AcpRuntimeProfile,
  params: { agent: Agent; workspace: AgentWorkspaceLayout; timeoutMs: number }
): string | undefined {
  return expandProfileCwd(profile.cwd ? renderAcpProfileValue(profile.cwd, params) : undefined);
}

function renderAcpProfileValue(
  value: string,
  params: { agent: Agent; workspace: AgentWorkspaceLayout; timeoutMs: number }
): string {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => {
    switch (key) {
      case "workspaceDir":
      case "workspacePath":
        return params.workspace.workspaceDir;
      case "stateDir":
        return params.workspace.dir;
      case "runtimeCwd":
        return params.workspace.runtimeCwd;
      case "agentId":
        return params.agent.id;
      case "agentName":
        return params.agent.name;
      case "model":
        return params.agent.model || "";
      case "modelArgs":
        return params.agent.model ? `-m ${params.agent.model}` : "";
      case "modelConfigArgs":
        return params.agent.model ? `-c model=${JSON.stringify(params.agent.model)}` : "";
      case "timeoutSeconds":
        return String(Math.floor(params.timeoutMs / 1000));
      default:
        if (key.startsWith("env.")) return process.env[key.slice(4)] || "";
        return match;
    }
  });
}

function commandExists(name: string): boolean {
  try {
    if (isAbsolute(name) || name.includes("/")) return existsSync(name);
    return (process.env.PATH || "")
      .split(":")
      .filter(Boolean)
      .some(dir => existsSync(join(dir, name)));
  } catch {
    return false;
  }
}

function loadConfiguredAcpProfiles(): Record<string, AcpRuntimeProfile> {
  const file = process.env.ITEAM_ACP_RUNTIMES;
  if (!file || !existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, AcpRuntimeProfile>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn(`[acp-profile] failed to read ${file}: ${(error as Error).message}`);
    return {};
  }
}
