import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createId, nowIso } from "./lib.js";
import type { Agent, ContextMessage, DeliveryWithContext, MentionRef, Message } from "./types.js";
import type { AgentDriver } from "./runtime/driver.js";
import { getRuntimeDescriptor, isPersistentRuntime } from "./runtime/registry.js";
import { resolveRuntimeProfile } from "./runtime/profiles.js";
import { agentEnv, prepareAgentWorkspace, type AgentWorkspaceLayout } from "./workspace.js";

interface RuntimeSpec {
  command: string;
  args: string[];
}

interface ChildEntry {
  child: ChildProcessWithoutNullStreams;
  launchId: string;
  spec: RuntimeSpec;
}

/**
 * Per-agent persistent driver. Long-lived drivers (AcpDriver) keep one ACP
 * session alive across deliveries; OneshotDriver entries here are unused
 * because they spin up a fresh subprocess per delivery.
 */
interface DriverEntry {
  driver: AgentDriver;
  launchId: string;
}

export type StatusReporter = (
  agentId: string,
  status: string,
  details: Record<string, unknown>
) => Promise<unknown>;

export interface AgentLauncherOptions {
  serverUrl: string;
  report: StatusReporter;
  reportDeliveryProgress?: (deliveryId: string, text: string) => Promise<unknown>;
  reportDeliveryRuntimeState?: (
    deliveryId: string,
    state: { phase: "queued" | "running"; queuePosition?: number; sessionKey?: string; processSlot?: number }
  ) => Promise<unknown>;
  /**
   * Lazy-resolved connect credentials. The daemon may not have a computer id
   * until the first heartbeat completes, so we read these on each launch.
   */
  getCredentials?: () => { computerId?: string; connectToken?: string };
}

export class AgentLauncher {
  serverUrl: string;
  report: StatusReporter;
  reportDeliveryProgress: (deliveryId: string, text: string) => Promise<unknown>;
  reportDeliveryRuntimeState: (
    deliveryId: string,
    state: { phase: "queued" | "running"; queuePosition?: number; sessionKey?: string; processSlot?: number }
  ) => Promise<unknown>;
  getCredentials: () => { computerId?: string; connectToken?: string };
  children: Map<string, ChildEntry>;
  drivers: Map<string, DriverEntry>;
  progressEventKeys: Map<string, number>;
  runtimeStateReports: Map<string, Promise<unknown>>;

  constructor({ serverUrl, report, reportDeliveryProgress, reportDeliveryRuntimeState, getCredentials }: AgentLauncherOptions) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.report = report;
    this.reportDeliveryProgress = reportDeliveryProgress || (async () => {});
    this.reportDeliveryRuntimeState = reportDeliveryRuntimeState || (async () => {});
    this.getCredentials = getCredentials || (() => ({}));
    this.children = new Map();
    this.drivers = new Map();
    this.progressEventKeys = new Map();
    this.runtimeStateReports = new Map();
  }

  has(agentId: string): boolean {
    return this.children.has(agentId) || this.drivers.has(agentId);
  }

  /**
   * Drop tracking entries whose underlying process has already exited. Called
   * by the watchdog after a heartbeat stall to recover from races where the
   * exit handler did not fire (e.g. node event loop blocked).
   */
  resetStale(): { removedChildren: number; removedDrivers: number } {
    let removedChildren = 0;
    for (const [agentId, entry] of this.children) {
      if (entry.child.killed || entry.child.exitCode !== null || entry.child.signalCode !== null) {
        this.children.delete(agentId);
        removedChildren++;
      }
    }
    let removedDrivers = 0;
    for (const [agentId, entry] of this.drivers) {
      if (entry.driver.isAlive && !entry.driver.isAlive()) {
        this.drivers.delete(agentId);
        removedDrivers++;
      }
    }
    return { removedChildren, removedDrivers };
  }

  async launch(agent: Agent): Promise<void> {
    if (isPersistentRuntime(agent.runtime)) {
      await this.launchPersistent(agent);
      return;
    }
    await this.launchLegacy(agent);
  }

  private async launchPersistent(agent: Agent): Promise<void> {
    const existing = this.drivers.get(agent.id);
    if (existing) {
      console.log(`[${nowIso()}] launch ${agent.id} (${agent.runtime}) reused existing driver launch=${existing.launchId}`);
      await this.report(agent.id, "online", {
        launchId: existing.launchId,
        pid: null,
        command: `${agent.runtime} ${existing.driver.capabilities.lifecycle} (${existing.driver.deliveryMode})`,
        workspacePath: agent.workspacePath
      });
      return;
    }
    const launchId = createId("launch");
    const descriptor = getRuntimeDescriptor(agent.runtime);
    const credentials = this.getCredentials();
    console.log(`[${nowIso()}] launch ${agent.id} (${agent.runtime}, persistent ${descriptor.capabilities.lifecycle}) launch=${launchId}`);
    const driver = descriptor.factory(agent.runtime, {
      serverUrl: this.serverUrl,
      launchId,
      computerId: credentials.computerId,
      connectToken: credentials.connectToken
    });
    this.subscribeDriver(agent, driver, launchId);
    this.drivers.set(agent.id, { driver, launchId });

    await this.report(agent.id, "starting", {
      launchId,
      pid: null,
      command: `${agent.runtime} ${descriptor.capabilities.lifecycle} serve`
    });
    try {
      // Pass the agent with a unique workspace path for the primary process, 
      // but only if the driver needs it. Since AcpDriver manages its own pool 
      // of processes and modifies the workspacePath internally during doStart,
      // we can just pass the original agent.
      await driver.start?.(agent);
      console.log(`[${nowIso()}] launch ${agent.id} online (launch=${launchId})`);
      await this.report(agent.id, "online", {
        launchId,
        pid: null,
        command: `${agent.runtime} ${descriptor.capabilities.lifecycle} serve`,
        workspacePath: agent.workspacePath
      });
    } catch (error) {
      this.drivers.delete(agent.id);
      console.error(`[${nowIso()}] launch ${agent.id} failed: ${(error as Error).message}`);
      await this.report(agent.id, "launch_failed", {
        launchId,
        error: (error as Error).message,
        command: `${agent.runtime} ${descriptor.capabilities.lifecycle} serve`
      }).catch(() => {});
      throw error;
    }
  }

  private subscribeDriver(agent: Agent, driver: AgentDriver, launchId: string): void {
    driver.on(event => {
      const progress = formatTaskRuntimeProgress(event);
      const progressKey = event.deliveryId && progress
        ? `${event.deliveryId}:${event.type}:${progress}`
        : "";
      const previousProgressAt = this.progressEventKeys.get(progressKey) || 0;
      const now = Date.now();
      if (
        event.deliveryId &&
        event.target?.includes(":msg_") &&
        progress &&
        now - previousProgressAt >= 10_000
      ) {
        this.progressEventKeys.set(progressKey, now);
        if (this.progressEventKeys.size > 1000) this.progressEventKeys.clear();
        this.reportDeliveryProgress(event.deliveryId, progress).catch(() => {});
      }
      switch (event.type) {
        case "delivery_queued":
          this.queueRuntimeStateReport(event.deliveryId, {
            phase: "queued",
            queuePosition: event.queuePosition,
            sessionKey: event.sessionKey,
            processSlot: event.processSlot
          });
          return;
        case "delivery_running":
          this.queueRuntimeStateReport(event.deliveryId, {
            phase: "running",
            sessionKey: event.sessionKey,
            processSlot: event.processSlot
          });
          return;
        case "session_started":
          this.report(agent.id, "output", {
            launchId,
            stream: "stdout",
            text: `[acp] session ${event.sessionId} ready\n`
          }).catch(() => {});
          return;
        case "error":
          this.report(agent.id, "output", {
            launchId,
            stream: "stderr",
            text: `[acp] error: ${event.message}\n`
          }).catch(() => {});
          return;
        case "exited":
          this.drivers.delete(agent.id);
          console.log(`[${nowIso()}] exit ${agent.id} (launch=${launchId}, code=${event.code}, signal=${event.signal})`);
          this.report(agent.id, "exited", {
            launchId,
            code: event.code,
            signal: event.signal
          }).catch(() => {});
          return;
        default:
          return;
      }
    });
  }

  private queueRuntimeStateReport(
    deliveryId: string,
    state: { phase: "queued" | "running"; queuePosition?: number; sessionKey?: string; processSlot?: number }
  ): void {
    const previous = this.runtimeStateReports.get(deliveryId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.reportDeliveryRuntimeState(deliveryId, state))
      .catch(error => {
        console.error(
          `[${nowIso()}] report ${deliveryId} runtime-state=${state.phase} failed: ${(error as Error).message}`
        );
      })
      .finally(() => {
        if (this.runtimeStateReports.get(deliveryId) === next) {
          this.runtimeStateReports.delete(deliveryId);
        }
      });
    this.runtimeStateReports.set(deliveryId, next);
  }

  private async launchLegacy(agent: Agent): Promise<void> {
    const existing = this.children.get(agent.id);
    if (existing) {
      console.log(`[${nowIso()}] launch ${agent.id} (${agent.runtime}) reused existing child pid=${existing.child.pid}`);
      await this.report(agent.id, "online", {
        launchId: existing.launchId,
        pid: existing.child.pid,
        command: printableCommand(existing.spec),
        workspacePath: agent.workspacePath
      });
      return;
    }
    const launchId = createId("launch");
    const credentials = this.getCredentials();
    const workspace = prepareAgentWorkspace({
      agent,
      serverUrl: this.serverUrl,
      launchId,
      computerId: credentials.computerId,
      connectToken: credentials.connectToken
    });
    const spec = buildRuntimeSpec({ agent, workspace, serverUrl: this.serverUrl, launchId });
    if (!spec) {
      // Pure deliver-on-demand runtime (e.g. gemini). There's no useful long
      // running process to spawn at launch time — the OneshotDriver will
      // spawn a fresh CLI per delivery with the prompt. Report online so the
      // server stops re-issuing launch requests every heartbeat.
      console.log(`[${nowIso()}] launch ${agent.id} (${agent.runtime}, oneshot) launch=${launchId} (no pre-spawn; deliver-on-demand)`);
      await this.report(agent.id, "online", {
        launchId,
        pid: null,
        command: `${agent.runtime} (deliver-on-demand)`,
        workspacePath: workspace.runtimeCwd
      });
      return;
    }
    console.log(`[${nowIso()}] launch ${agent.id} (${agent.runtime}, oneshot) launch=${launchId} cmd=${printableCommand(spec)}`);
    await this.report(agent.id, "starting", { launchId, pid: null, command: printableCommand(spec) });

    const child = spawn(spec.command, spec.args, {
      cwd: workspace.runtimeCwd,
      env: agentEnv({ agent, serverUrl: this.serverUrl, workspace }),
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    this.children.set(agent.id, { child, launchId, spec });

    child.stdout.on("data", (data: Buffer) => {
      this.report(agent.id, "output", { launchId, stream: "stdout", text: data.toString() }).catch(() => {});
    });
    child.stderr.on("data", (data: Buffer) => {
      this.report(agent.id, "output", { launchId, stream: "stderr", text: data.toString() }).catch(() => {});
    });
    child.on("spawn", () => {
      console.log(`[${nowIso()}] launch ${agent.id} online pid=${child.pid} (launch=${launchId})`);
      this.report(agent.id, "online", {
        launchId,
        pid: child.pid,
        command: printableCommand(spec),
        workspacePath: workspace.runtimeCwd
      }).catch(() => {});
    });
    child.on("error", (error: Error) => {
      this.children.delete(agent.id);
      console.error(`[${nowIso()}] launch ${agent.id} failed: ${error.message}`);
      this.report(agent.id, "launch_failed", {
        launchId,
        error: error.message,
        command: printableCommand(spec)
      }).catch(() => {});
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.children.delete(agent.id);
      console.log(`[${nowIso()}] exit ${agent.id} (launch=${launchId}, code=${code}, signal=${signal})`);
      this.report(agent.id, "exited", { launchId, code, signal }).catch(() => {});
    });
  }

  async stop(agent: Agent): Promise<void> {
    const driverEntry = this.drivers.get(agent.id);
    if (driverEntry) {
      console.log(`[${nowIso()}] stop ${agent.id} (${agent.runtime}, persistent) launch=${driverEntry.launchId}`);
      this.drivers.delete(agent.id);
      await driverEntry.driver.stop?.(agent).catch(() => {});
      await this.report(agent.id, "stopped", {
        launchId: driverEntry.launchId,
        pid: null,
        requestedAt: nowIso()
      });
      return;
    }
    const running = this.children.get(agent.id);
    if (running) {
      console.log(`[${nowIso()}] stop ${agent.id} (${agent.runtime}) pid=${running.child.pid} launch=${running.launchId}`);
      running.child.kill("SIGTERM");
      this.children.delete(agent.id);
      await this.report(agent.id, "stopped", { launchId: running.launchId, pid: null, requestedAt: nowIso() });
      return;
    }
    if (agent.pid) {
      console.log(`[${nowIso()}] stop ${agent.id} (${agent.runtime}) external pid=${agent.pid}`);
      try {
        process.kill(agent.pid, "SIGTERM");
      } catch {
        // The backend may have stale pid state after daemon restarts.
      }
    } else {
      console.log(`[${nowIso()}] stop ${agent.id} (${agent.runtime}) no running entry, marking stopped`);
    }
    await this.report(agent.id, "stopped", { launchId: agent.launchId || null, pid: null, requestedAt: nowIso() });
  }

  async cancelDelivery(deliveryId: string, agentId?: string): Promise<void> {
    const entries = agentId
      ? [...this.drivers.entries()].filter(([id]) => id === agentId)
      : [...this.drivers.entries()];
    await Promise.all(entries.map(([, entry]) =>
      entry.driver.cancelDelivery?.(deliveryId).catch(() => {})
    ));
  }

  async deliver(delivery: DeliveryWithContext): Promise<{ ok: true; text: string }> {
    const agent = delivery.agent;
    const message = delivery.message;
    if (!agent || !message) throw new Error("delivery is missing agent or message");
    const prompt = formatDeliveryPrompt({ agent, message, delivery });
    console.log(`[${nowIso()}] deliver ${delivery.id} prompt-bytes=${Buffer.byteLength(prompt, "utf8")} runtime=${agent.runtime}`);
    const driver = this.resolveDriver(agent);
    return driver.deliver(agent, delivery, prompt);
  }

  /**
   * Pick a driver for the given agent. Persistent runtimes reuse the long-
   * lived driver started in launch(); ephemeral ones get a fresh per-delivery
   * driver via the registry factory.
   */
  private resolveDriver(agent: Agent): AgentDriver {
    const credentials = this.getCredentials();
    if (isPersistentRuntime(agent.runtime)) {
      const entry = this.drivers.get(agent.id);
      if (entry) return entry.driver;
      // Fallback: lazily spawn a driver so deliveries arriving before launch()
      // still complete (the daemon may restart while a delivery is pending).
      const launchId = agent.launchId || createId("launch");
      const descriptor = getRuntimeDescriptor(agent.runtime);
      const driver = descriptor.factory(agent.runtime, {
        serverUrl: this.serverUrl,
        launchId,
        computerId: credentials.computerId,
        connectToken: credentials.connectToken
      });
      this.subscribeDriver(agent, driver, launchId);
      this.drivers.set(agent.id, { driver, launchId });
      return driver;
    }
    const descriptor = getRuntimeDescriptor(agent.runtime);
    return descriptor.factory(agent.runtime, {
      serverUrl: this.serverUrl,
      launchId: agent.launchId || createId("launch"),
      computerId: credentials.computerId,
      connectToken: credentials.connectToken
    });
  }
}

export function formatTaskRuntimeProgress(event: import("./runtime/events.js").AgentEvent): string | null {
  if (event.type === "tool_call") {
    const args = asRecord(event.arguments);
    if (event.toolName === "file_change") {
      const path = compactText(args.path, 240);
      const kind = compactText(args.kind, 40);
      return path ? `执行过程：${kind ? `${kind} ` : ""}文件 \`${path}\`。` : "执行过程：正在修改文件。";
    }
    if (event.toolName === "shell") {
      const command = compactText(args.command, 300);
      return command ? `执行过程：运行命令 \`${command}\`。` : "执行过程：正在运行命令。";
    }
    if (event.toolName === "web_search") {
      const query = compactText(args.query, 240);
      return query ? `执行过程：搜索 ${query}。` : "执行过程：正在搜索资料。";
    }
    if (event.toolName === "subagent_spawnAgent") {
      const prompt = compactText(args.prompt, 400);
      return prompt
        ? `执行过程：已启动 sub agent review：${prompt}`
        : "执行过程：已启动 sub agent review。";
    }
    if (event.toolName === "subagent_sendInput") return "执行过程：已向 sub agent 发送补充信息。";
    if (event.toolName === "subagent_wait") return "执行过程：正在等待 sub agent review。";
    if (event.toolName === "subagent_closeAgent") return "执行过程：review 完成，正在关闭 sub agent。";
    if (event.toolName.startsWith("mcp_chat_")) return null;
  }
  if (event.type === "tool_result") {
    const output = asRecord(event.output);
    const tool = compactText(output.tool, 80);
    if (tool && ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"].includes(tool)) {
      const messages = Object.values(asRecord(output.agentsStates))
        .map(value => compactText(asRecord(value).message, 700))
        .filter(Boolean);
      if (tool === "wait" && messages.length > 0) {
        return `执行过程：sub agent review 完成：${messages.join(" ").slice(0, 900)}`;
      }
      if (tool === "closeAgent") return event.ok ? "执行过程：sub agent 已关闭。" : "执行过程：关闭 sub agent 失败。";
      return event.ok
        ? `执行过程：sub agent ${tool} 完成。`
        : `执行过程：sub agent ${tool} 失败。`;
    }
  }
  if (event.type === "plan" && event.items.length > 0) {
    const summary = event.items
      .map(item => compactText(item.content, 120))
      .filter(Boolean)
      .slice(0, 3)
      .join("；");
    return summary ? `执行计划：${summary}` : "执行计划已更新。";
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function compactText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

interface BuildRuntimeSpecArgs {
  agent: Agent;
  workspace: AgentWorkspaceLayout;
  serverUrl: string;
  launchId: string;
}

function buildRuntimeSpec({ agent, workspace }: BuildRuntimeSpecArgs): RuntimeSpec | null {
  if (resolveRuntimeProfile(agent.runtime)) {
    return null;
  }

  if (agent.runtime === "claude") {
    const args = [
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--disallowed-tools", "EnterPlanMode,ExitPlanMode,ScheduleWakeup,CronCreate,CronList,CronDelete",
      "--append-system-prompt-file", workspace.systemPromptPath,
      "--mcp-config", workspace.claudeMcpConfigPath,
      "--strict-mcp-config"
    ];
    // Only pass --model if explicitly set; otherwise Claude CLI reads ANTHROPIC_MODEL
    // from the environment (useful for Ark/compatible endpoints with endpoint IDs).
    if (agent.model) args.push("--model", agent.model);
    return { command: "claude", args };
  }

  if (agent.runtime === "gemini") {
    // Bare `gemini` has no service mode; without a prompt on stdin it exits
    // immediately. Treat it as a pure deliver-on-demand runtime — the
    // OneshotDriver will spawn a fresh CLI per delivery.
    return null;
  }

  if (agent.runtime === "trae") {
    // Long-running Trae CLI via the Agent Client Protocol over stdio.
    // See: https://docs.trae.cn/cli/agent-client-protocol
    //      https://docs.trae.cn/cli/permission-mode
    return {
      command: "traecli",
      args: [
        "acp", "serve",
        "--add-dir", workspace.workspaceDir,
        "--yolo",
        "--disallowed-tool", "EnterPlanMode",
        "--disallowed-tool", "ExitPlanMode"
      ]
    };
  }

  throw new Error(`unsupported runtime: ${agent.runtime}`);
}

interface DeliveryPromptArgs {
  agent: Agent;
  message: Message;
  delivery: DeliveryWithContext;
}

function formatDeliveryPrompt({ agent, message, delivery }: DeliveryPromptArgs): string {
  const author = (delivery.author || {}) as Partial<MentionRef>;
  const replyTarget = delivery.target || message.target;
  const members = (delivery.members || [])
    .filter(member => member.id !== agent.id)
    .map(member => `- ${member.name} (@${member.handle})`)
    .join("\n");
  const history = formatConversationHistory(delivery.contextMessages || [], message.id);
  const activeDeliveries = formatActiveDeliveries(delivery.activeDeliveries || []);
  const taskMode = delivery.target.includes(":msg_") &&
    (message.type === "task" || (delivery.contextMessages || []).some(item => item.type === "task"));
  const taskInstructions = taskMode
    ? `\n**Long-running task mode:**\n- Continue working until the task is genuinely complete; do not stop merely because the work takes a long time.\n- Important semantic milestones, blockers, review findings, and material partial results should be posted to ${replyTarget} with the iteam_message_send tool while work continues.\n- For multi-round work, report the transition between rounds: initial implementation complete, sub agent/reviewer started, review result received, corrections applied, and verification complete.\n- Keep milestone updates concise. The daemon also posts structured tool/sub-agent events and periodic keepalive progress, so do not send repetitive status-only messages.\n`
    : "";
  return `You are ${agent.name}, an iTeam agent.

Reply to the current chat message in the indicated reply target. Use the conversation history for context, including what other agents have already said. Keep the reply concise and directly useful.
When another agent is mentioned, address them with their @handle, not their internal id. Ask at most one clear follow-up question.
Your shell working directory is the runtime process cwd. It defaults to the shared agent workspace, while iTeam's internal worker state stays in a separate pool directory. Use a runtime tool when you need the exact current path.
Treat prompt metadata as configuration rather than evidence. If the message asks for a current runtime fact that a tool can observe, use the appropriate tool and answer from its result; never imply that a command ran unless it actually did.
If this message depends on older context not shown below, use the local CLI: iteam-agent message read/search/check.
Return the primary reply to this delivery as your normal final response. Do not use iteam_message_send for that primary reply; reserve it for genuinely additional asynchronous updates while a longer task is still running.
${taskInstructions}

**Scheduled tasks:**
- If the current human message asks for a recurring cadence such as "每隔 10 分钟", "every 1 hour", or "工作日 09:00 到 19:00 每小时", decide whether a real scheduled task should be created.
- To create one, include exactly one valid JSON directive anywhere in your reply:
  <iteam_schedule>{"create":true,"intervalMs":600000,"prompt":"Describe what you should do on each scheduled run."}</iteam_schedule>
- For calendar schedules, use standard 5-field cron plus an IANA timezone, for example:
  <iteam_schedule>{"create":true,"cronExpression":"0 9-19 * * 1-5","timezone":"Asia/Shanghai","prompt":"Describe what you should do on each scheduled run."}</iteam_schedule>
- Use either intervalMs or cronExpression, never both. The directive prompt must be self-contained because it will be the only instruction on future scheduled runs. Preserve the user's concrete constraints that affect future runs, including initial state, capital/budget, market or universe, strategy, required data lookup, report fields, and output language.
- Do not narrow a broad user-specified universe into an arbitrary example. For example, if the user says "美股" or "US stocks" without naming a ticker, keep that universe or describe a selection rule; do not hard-code AAPL/MSFT/etc. unless the user explicitly specified them.
- Omit only pure one-time setup/acknowledgement text that is already complete. If no schedule should be created, omit the directive.
- The server strips this directive before displaying your reply and creates the timer. Do not explain or quote the directive to the user.
- You do not need to keep your own timer. Future scheduled runs will arrive as normal delivery messages from the server; answer them with the requested status update.

**@Mention rules:**
- Only @mention another teammate when you genuinely need their input. Do NOT @mention anyone just to acknowledge, confirm, or say you'll wait.
- If asked to stop, pause, or wait — confirm briefly and STOP. Do not @mention anyone.

	Message source target: ${message.target}
	Reply target: ${replyTarget}
	Session key: ${delivery.sessionKey || "(none)"}
	Message author: ${author.name || message.authorId}${author.handle ? ` (@${author.handle})` : ""}
Available members:
${members || "- No other members"}
Conversation history:
${history}

Other active deliveries for this agent in the same chat:
${activeDeliveries}

Current message text:
${message.text}
`;
}

function formatConversationHistory(messages: ContextMessage[], currentMessageId: string): string {
  if (!messages.length) return "- No previous messages.";
  return messages.map(item => {
    const author = item.author || ({} as Partial<MentionRef>);
    const marker = item.id === currentMessageId || item.isCurrent ? " <-- current" : "";
    const handle = author.handle ? ` @${author.handle}` : "";
    const text = String(item.text || "").replace(/\s+/g, " ").slice(0, 1200);
    return `- [${item.createdAt || "unknown time"}] ${author.name || "Unknown"}${handle}: ${text}${marker}`;
  }).join("\n");
}

function formatActiveDeliveries(deliveries: NonNullable<DeliveryWithContext["activeDeliveries"]>): string {
  if (!deliveries.length) return "- None.";
  return deliveries.map(delivery => {
    const queue = delivery.queuePosition !== undefined ? ` queue=#${delivery.queuePosition}` : "";
    return `- ${delivery.phase}${queue} since=${delivery.createdAt} request=${delivery.messageText}`;
  }).join("\n");
}

function printableCommand(spec: RuntimeSpec): string {
  return [spec.command, ...spec.args.map(shellQuote)].join(" ");
}

function shellQuote(value: string): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}
