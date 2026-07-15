// OneshotDriver — wraps runtimes that re-spawn a fresh CLI per delivery turn.
//
// This is the "none" busy-delivery mode in https://blog.openviking.ai/post/agent-runtime/?lang=zh:
// the process is one-shot, queue messages while it runs, restart with the
// next prompt afterwards. It covers codex/trae's `-p` paths today;
// long-lived ACP/stream-json drivers will replace some of these later.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { nowIso } from "../lib.js";
import { agentEnv, prepareAgentWorkspace, type AgentWorkspaceLayout } from "../workspace.js";
import type { Agent, DeliveryWithContext } from "../types.js";
import type { AgentDriver, AgentEventListener, DeliverResult, DeliveryMode, DriverCapabilities } from "./driver.js";
import type { AgentEvent } from "./events.js";
import {
  expandProfileCwd,
  renderProfileArgs,
  renderProfileEnv,
  renderProfileValue,
  resolveRuntimeProfile,
  type ResolvedRuntimeProfile
} from "./profiles.js";

interface RuntimeSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  profile?: ResolvedRuntimeProfile;
}

export interface OneshotDriverOptions {
  serverUrl: string;
  launchId: string;
  computerId?: string;
  connectToken?: string;
}

export class OneshotDriver implements AgentDriver {
  readonly runtime: string;
  readonly deliveryMode: DeliveryMode = "none";
  readonly capabilities: DriverCapabilities = {
    lifecycle: "ephemeral",
    inFlightWake: "spawn_new",
    supportsResume: false
  };
  private listeners: Set<AgentEventListener> = new Set();
  private serverUrl: string;
  private launchId: string;
  private computerId?: string;
  private connectToken?: string;

  constructor(runtime: string, opts: OneshotDriverOptions) {
    this.runtime = runtime;
    this.serverUrl = opts.serverUrl;
    this.launchId = opts.launchId;
    this.computerId = opts.computerId;
    this.connectToken = opts.connectToken;
  }

  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async deliver(agent: Agent, delivery: DeliveryWithContext, prompt: string): Promise<DeliverResult> {
    const workspace = prepareAgentWorkspace({
      agent,
      serverUrl: this.serverUrl,
      launchId: this.launchId,
      computerId: this.computerId,
      connectToken: this.connectToken
    });
    const cwd = workspace.runtimeCwd;
    const spec = buildOneShotSpec(agent, delivery, prompt);
    const effectiveCwd = resolveEffectiveCwd(spec.cwd, cwd);
    const tag = `[Agent ${agent.id} ${agent.runtime}]`;
    console.log(`[${nowIso()}] ${tag} Delivery received (delivery=${delivery.id}, prompt-bytes=${prompt.length})`);
    const startedAt = Date.now();
    try {
      const text = await runOneShot({
        agent,
        spec,
        cwd: effectiveCwd,
        workspace,
        serverUrl: this.serverUrl,
        onEvent: ev => this.emit(ev),
        launchId: this.launchId,
        tag
      });
      const trimmed = text.trim() || "(No response)";
      console.log(`[${nowIso()}] ${tag} Turn completed (delivery=${delivery.id}, text-length=${trimmed.length}, took=${Date.now() - startedAt}ms)`);
      this.emit({
        type: "turn_end",
        agentId: agent.id,
        launchId: this.launchId,
        at: nowIso(),
        text: trimmed
      });
      return { ok: true, text: trimmed };
    } catch (error) {
      const errMsg = (error as Error).message;
      console.error(`[${nowIso()}] ${tag} Turn failed (delivery=${delivery.id}, took=${Date.now() - startedAt}ms): ${errMsg.length > 200 ? errMsg.slice(0, 200) + "..." : errMsg}`);
      throw error;
    }
  }
}

interface RunOneShotArgs {
  agent: Agent;
  spec: RuntimeSpec;
  cwd: string;
  workspace: AgentWorkspaceLayout;
  serverUrl: string;
  onEvent: (event: AgentEvent) => void;
  launchId: string;
  tag: string;
}

function runOneShot({ agent, spec, cwd, workspace, serverUrl, onEvent, launchId, tag }: RunOneShotArgs): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const env = {
      ...agentEnv({ agent, serverUrl, workspace }),
      ...(spec.env || {}),
      ITEAM_RUNTIME_CWD: cwd,
      PWD: cwd
    };
    const child: ChildProcess = spawn(spec.command, spec.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    console.log(`[${nowIso()}] ${tag} Process started (pid=${child.pid})`);
    let stdout = "";
    let stderr = "";
    const timeoutMs = spec.timeoutMs || oneshotTimeoutMs(agent.runtime);
    let lastActivity = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastActivity < timeoutMs) return;
      clearInterval(timer);
      console.warn(`[${nowIso()}] ${tag} Response timed out after ${timeoutMs}ms; killing pid=${child.pid}`);
      child.kill("SIGTERM");
      onEvent({
        type: "error",
        agentId: agent.id,
        launchId,
        at: nowIso(),
        message: `${agent.runtime} response timed out`
      });
      reject(new Error(`${agent.runtime} response timed out`));
    }, 5000);
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      lastActivity = Date.now();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      lastActivity = Date.now();
    });
    child.on("error", (error: Error) => {
      clearInterval(timer);
      console.error(`[${nowIso()}] ${tag} Process error: ${error.message}`);
      onEvent({
        type: "error",
        agentId: agent.id,
        launchId,
        at: nowIso(),
        message: error.message
      });
      reject(error);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      clearInterval(timer);
      console.log(`[${nowIso()}] ${tag} Process exited (code=${code}, signal=${signal}, pid=${child.pid})`);
      onEvent({
        type: "exited",
        agentId: agent.id,
        launchId,
        at: nowIso(),
        code,
        signal
      });
      
      let isSuccess = code === 0;
      if (agent.runtime === "codex" && code !== 0) {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as {
              msg?: { type?: string };
              type?: string;
            };
            if (event.msg?.type === "agent_message" || event.type === "agent_message") {
              isSuccess = true;
              break;
            }
          } catch {}
        }
      }

      if (isSuccess) {
        const reply = extractReply(agent.runtime, stdout);
        const failure = detectRuntimeFailure(agent.runtime, stdout, stderr, reply);
        if (failure) {
          reject(new Error(failure));
        } else {
          resolvePromise(reply);
        }
      } else {
        reject(new Error(extractRuntimeError(agent.runtime, stdout, stderr) || `${agent.runtime} exited with code ${code}`));
      }
    });
  });
}

function resolveEffectiveCwd(profileCwd: string | undefined, fallback: string): string {
  const candidate = resolve(profileCwd || fallback);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`runtime profile cwd must be an existing directory: ${candidate}`);
  }
  return candidate;
}

function oneshotTimeoutMs(runtime: string): number {
  const fromEnv = Number(process.env.ITEAM_ONESHOT_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (runtime === "trae") return 600000;
  return 300000;
}

function buildOneShotSpec(agent: Agent, delivery: DeliveryWithContext, prompt: string): RuntimeSpec {
  const profile = resolveRuntimeProfile(agent.runtime);
  if (profile) {
    const timeoutMs = profile.timeoutMs || oneshotTimeoutMs(agent.runtime);
    const params = { agent, delivery, prompt, timeoutMs };
    return {
      command: renderProfileValue(profile.command, params),
      args: renderProfileArgs(profile, params),
      cwd: expandProfileCwd(profile.cwd ? renderProfileValue(profile.cwd, params) : undefined),
      env: renderProfileEnv(profile, params),
      timeoutMs,
      profile
    };
  }
  if (agent.runtime === "codex") {
    const codexArgs = ["exec", "--skip-git-repo-check", "--sandbox", "read-only"];
    if (agent.model) codexArgs.push("-m", agent.model);
    codexArgs.push(prompt);
    return { command: "codex", args: codexArgs };
  }
  if (agent.runtime === "trae") {
    // One-shot via `traecli -p <prompt>` with JSON output and YOLO mode.
    const timeoutMs = oneshotTimeoutMs("trae");
    return {
      command: "traecli",
      args: [
        "-p",
        "--output-format", "json",
        "--yolo",
        "--query-timeout", `${Math.floor(timeoutMs / 1000)}s`,
        prompt
      ]
    };
  }
  throw new Error(`unsupported runtime: ${agent.runtime}`);
}

export function extractReply(runtime: string, stdout: string): string {
  if (runtime === "trae") {
    // `traecli -p --output-format json` emits a single JSON document.
    const trimmed = stdout.trim();
    if (!trimmed) return "";
    try {
      const parsed = JSON.parse(trimmed) as {
        message?: { content?: string } | string;
        result?: string;
        text?: string;
        response?: string;
        content?: string;
      };
      if (parsed && typeof parsed.message === "object" && parsed.message?.content) {
        return parsed.message.content;
      }
      return (
        parsed.result ||
        (typeof parsed.message === "string" ? parsed.message : "") ||
        parsed.text ||
        parsed.response ||
        parsed.content ||
        trimmed
      );
    } catch {
      return trimmed;
    }
  }
  if (runtime !== "codex") return stdout.trim();
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const jsonReplies: string[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as {
        msg?: { type?: string; message?: string };
        type?: string;
        message?: string;
      };
      if (event.msg?.type === "agent_message" && typeof event.msg.message === "string") jsonReplies.push(event.msg.message);
      if (event.type === "agent_message" && typeof event.message === "string") jsonReplies.push(event.message);
    } catch {}
  }
  return jsonReplies.at(-1) || stdout.trim();
}

function extractRuntimeError(runtime: string, stdout: string, stderr: string): string {
  if (runtime === "codex") {
    // If we can extract a valid reply from stdout, ignore stderr warnings
    const reply = extractReply(runtime, stdout);
    if (reply.trim().length > 0) {
      return "";
    }
  }

  const err = stderr.trim();
  if (err) return err;
  return stdout.trim();
}

/**
 * Detects runtime-level failures that the CLI signalled by exiting 0 with
 * an error written to stdout (codex prints "ERROR: You've hit your usage
 * limit..." this way and still exits cleanly). Returning a non-empty string
 * causes the driver to fail the delivery so the user sees a system message.
 */
function detectRuntimeFailure(runtime: string, stdout: string, _stderr: string, reply: string): string | null {
  if (runtime === "codex") {
    // If extractReply already got a valid non-error reply, it's a success.
    // This handles both JSON-line output (app-server mode) and plain text
    // (one-shot exec mode) — no need to re-scan stdout for agent_message.
    const trimmed = reply.trim();
    if (trimmed.length > 0 && !/(ERROR:|Error:|usage limit|rate limit)/i.test(trimmed)) {
      return null;
    }

    // No valid reply — check for JSON error events in stdout
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const errorLines: string[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as {
          msg?: { type?: string; message?: string };
          type?: string;
          message?: string;
        };
        if (event.msg?.type === "error" && typeof event.msg.message === "string") {
          errorLines.push(event.msg.message);
        }
        if (event.type === "error" && typeof event.message === "string") {
          errorLines.push(event.message);
        }
      } catch {
        if (/^(ERROR:|Error:)/.test(line)) errorLines.push(line);
      }
    }
    if (errorLines.length) return errorLines.join("\n");
    const candidate = trimmed || stdout.trim();
    if (/(ERROR:|Error:|usage limit|rate limit)/i.test(candidate)) return candidate;
    return "codex produced no agent_message: " + candidate;
  }
  return null;
}

function printableCommand(spec: RuntimeSpec): string {
  return [spec.command, ...spec.args.map(shellQuote)].join(" ");
}

function shellQuote(value: string): string {
  const text = String(value);
  if (text.length > 200) return `'<${text.length} bytes>'`;
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}
