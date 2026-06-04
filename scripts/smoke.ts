import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = resolve(root, "node_modules/.bin/tsx");
const home = mkdtempSync(join(tmpdir(), "iteam-smoke-"));
const port = 18000 + Math.floor(Math.random() * 10000);
const daemon = spawn(tsxBin, [resolve(root, "src/server.ts"), "--port", String(port)], {
  env: { ...process.env, ITEAM_HOME: home, ITEAM_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForHealth(port);
  let computers = await get(port, "/api/computers");
  if (computers.length !== 0) throw new Error("state should not contain seeded computers");
  const invite = await post(port, "/api/computers/connect-command", { serverUrl: `http://127.0.0.1:${port}` });
  if (!invite.command.includes("daemon connect")) throw new Error("connect command was not generated");
  const firstConnect = await post(port, "/api/computers/connect", {
    token: invite.token,
    name: "smoke-computer",
    fingerprint: { id: "SMOKE12345", hostname: "smoke-computer", os: "darwin", arch: "arm64" },
    daemonVersion: "0.1.0",
    runtimes: [{ id: "codex", name: "Codex CLI", installed: true }]
  });
  if (firstConnect.connectToken !== invite.token) {
    throw new Error("first connect should bind the invite token to the computer permanently");
  }
  const connectToken: string = firstConnect.connectToken;
  const computerId: string = firstConnect.id;
  // Re-auth with the same token returns the same record — single-token model:
  // server never rotates the token, so this is just another heartbeat.
  const reAuth = await post(port, "/api/computers/connect", {
    token: connectToken,
    name: "smoke-computer",
    fingerprint: { id: "SMOKE12345", hostname: "smoke-computer", os: "darwin", arch: "arm64" },
    daemonVersion: "0.1.0",
    runtimes: [{ id: "codex", name: "Codex CLI", installed: true }]
  });
  if (reAuth.connectToken !== connectToken) throw new Error("re-auth must return the same persistent token");
  if (reAuth.id !== computerId) throw new Error("re-auth must return the same computer id");
  const wrongTokenStatus = await postStatus(port, "/api/computers/connect", {
    token: "bogus",
    fingerprint: { id: "SMOKE12345", hostname: "smoke-computer", os: "darwin", arch: "arm64" }
  });
  if (wrongTokenStatus !== 401) throw new Error(`expected 401 for wrong token, got ${wrongTokenStatus}`);
  computers = await get(port, "/api/computers");
  if (!computers.some((c: any) => c.name === "smoke-computer" && c.connectionId === invite.id)) {
    throw new Error("computer did not connect");
  }
  const agent = await post(port, "/api/agents", {
    name: "codex",
    runtime: "codex",
    model: "gpt-5.5",
    computerId: computerId
  });
  if (agent.status !== "registered" || agent.desiredStatus !== "running") throw new Error("agent was not registered for launch");
  const dm = await post(port, `/api/direct-messages/agents/${encodeURIComponent(agent.id)}`, {});
  if (dm.kind !== "dm" || dm.target !== `dm:${agent.id}` || !dm.memberIds.includes(agent.id)) {
    throw new Error("agent DM channel was not created");
  }
  const dmMessage = await post(port, "/api/messages", {
    target: dm.target,
    text: "direct hello",
    authorId: "human-local",
    defaultAgentId: agent.id
  });
  if (dmMessage.threadId !== null) throw new Error("direct messages must not be parsed as threads");
  const dmMessages = await get(port, `/api/messages/channel/${encodeURIComponent(dm.id)}?limit=10`);
  if (!dmMessages.some((message: any) => message.id === dmMessage.id && message.target === dm.target)) {
    throw new Error("direct message was not stored in the DM channel");
  }
  const heartbeat = await post(port, "/api/computers/connect", {
    token: invite.token,
    name: "smoke-computer",
    fingerprint: { id: "SMOKE12345", hostname: "smoke-computer", os: "darwin", arch: "arm64" },
    daemonVersion: "0.1.0",
    runtimes: [{ id: "codex", name: "Codex CLI", installed: true }]
  });
  if (!heartbeat.launchAgents.some((item: any) => item.id === agent.id)) throw new Error("registered agent was not assigned to computer daemon");
  // runtime-status is a computer-scoped callback: requires X-Iteam-Connection
  const noAuthStatus = await postStatus(port, `/api/agents/${encodeURIComponent(agent.id)}/runtime-status`, {
    status: "online"
  });
  if (noAuthStatus !== 401) throw new Error(`runtime-status without auth header should be 401, got ${noAuthStatus}`);
  const wrongAuthStatus = await postStatus(port, `/api/agents/${encodeURIComponent(agent.id)}/runtime-status`, {
    status: "online"
  }, { "x-iteam-connection": `${computerId}:not-the-token` });
  if (wrongAuthStatus !== 401) throw new Error(`runtime-status with wrong token should be 401, got ${wrongAuthStatus}`);
  await post(port, `/api/agents/${encodeURIComponent(agent.id)}/runtime-status`, {
    status: "online"
  }, { "x-iteam-connection": `${computerId}:${connectToken}` });
  const computerAuth = { "x-iteam-connection": `${computerId}:${connectToken}` };
  // Phase 4: SSE push channel — open the stream and verify a delivery push
  // arrives in real time when a new mention is created.
  const sse = await openSse(port, computerId, connectToken);
  try {
    const ready = await sse.waitFor("ready", 2_000);
    if (!ready || ready.computerId !== computerId) throw new Error("SSE ready event missing computerId");
    // missing auth → 401
    const noAuthSse = await fetch(`http://127.0.0.1:${port}/api/computers/${encodeURIComponent(computerId)}/stream`);
    if (noAuthSse.status !== 401) throw new Error(`SSE without auth should be 401, got ${noAuthSse.status}`);
    await noAuthSse.body?.cancel();
    const naturalScheduledMessage = await post(port, "/api/messages", {
      target: dm.target,
      text: `@${agent.handle} 每隔 10 分钟汇报交易进度，包括现金和持仓。`,
      authorId: "human-local"
    });
    const naturalMentionDelivery = await sse.waitFor("delivery", 2_000);
    if (!naturalMentionDelivery || naturalMentionDelivery.messageId !== naturalScheduledMessage.id) {
      throw new Error("natural scheduled request did not deliver original mention");
    }
    const beforeDirectiveSchedules = await get(port, "/api/scheduled-tasks");
    if (beforeDirectiveSchedules.length !== 0) {
      throw new Error("schedule should not be created before the agent returns a directive");
    }
    await post(port, `/api/deliveries/${encodeURIComponent(naturalMentionDelivery.id)}/result`, {
      ok: true,
      text: '收到，我会按计划汇报。<iteam_schedule>{"create":true,"intervalMs":600000,"prompt":"汇报交易进度，包括现金和持仓。"}</iteam_schedule>'
    }, computerAuth);
    const naturalSchedules = await get(port, "/api/scheduled-tasks");
    const naturalSchedule = naturalSchedules.find((item: any) =>
      item.agentId === agent.id &&
      item.target === dm.target &&
      item.intervalMs === 600_000 &&
      String(item.prompt || "").includes("交易进度")
    );
    if (!naturalSchedule) throw new Error("natural language scheduled request did not create a scheduled task");
    const naturalReplies = await get(port, `/api/messages/channel/${encodeURIComponent(dm.id)}?limit=20`);
    if (naturalReplies.some((message: any) => String(message.text || "").includes("iteam_schedule"))) {
      throw new Error("schedule directive should be stripped from visible agent replies");
    }
    const directAgentSchedule = await post(port, "/api/messages", {
      target: dm.target,
      authorId: agent.id,
      text: '直接发送也应创建。<iteam_schedule>{"create":true,"intervalMs":120000,"prompt":"direct agent schedule"}</iteam_schedule>'
    });
    if (String(directAgentSchedule.text || "").includes("iteam_schedule")) {
      throw new Error("direct agent message should strip schedule directive");
    }
    const directSchedules = await get(port, "/api/scheduled-tasks");
    if (!directSchedules.some((item: any) => item.agentId === agent.id && item.intervalMs === 120_000 && item.prompt === "direct agent schedule")) {
      throw new Error("direct agent message with schedule directive did not create a scheduled task");
    }
    // Scheduled tasks are server-owned timers: when due, the backend creates
    // a system message that mentions the agent and reuses the normal delivery
    // path to wake it.
    const scheduled = await post(port, "/api/scheduled-tasks", {
      target: dm.target,
      agentId: agent.id,
      prompt: "scheduled smoke report",
      intervalMs: 600_000,
      nextRunAt: new Date(Date.now() - 1000).toISOString()
    });
    if (scheduled.status !== "active") throw new Error("scheduled task was not created active");
    const scheduledDelivery = await sse.waitFor("delivery", 4_000);
    if (!scheduledDelivery) throw new Error("scheduled task did not push a delivery");
    if (scheduledDelivery.agentId !== agent.id) throw new Error("scheduled delivery targeted wrong agent");
    const scheduledTasks = await get(port, "/api/scheduled-tasks");
    const updatedSchedule = scheduledTasks.find((item: any) => item.id === scheduled.id);
    if (!updatedSchedule || updatedSchedule.runCount !== 1 || !updatedSchedule.lastMessageId) {
      throw new Error("scheduled task run metadata was not updated");
    }
    const editedNextRunAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const editedSchedule = await patch(port, `/api/scheduled-tasks/${encodeURIComponent(scheduled.id)}`, {
      status: "paused",
      prompt: "edited scheduled smoke report",
      intervalMs: 120_000,
      nextRunAt: editedNextRunAt
    });
    if (
      editedSchedule.status !== "paused" ||
      editedSchedule.prompt !== "edited scheduled smoke report" ||
      editedSchedule.intervalMs !== 120_000 ||
      editedSchedule.nextRunAt !== editedNextRunAt
    ) {
      throw new Error("scheduled task manual edit patch did not persist");
    }
    // Sending a message that mentions the running agent should push a
    // delivery event to our subscriber.
    const pushed = post(port, "/api/messages", {
      target: dm.target,
      text: `@${agent.handle} hello via push`,
      authorId: "human-local"
    });
    const deliveryEvent = await sse.waitFor("delivery", 2_000);
    if (!deliveryEvent) throw new Error("delivery push event was not received");
    if (deliveryEvent.agentId !== agent.id) throw new Error("delivery push event targeted wrong agent");
    await pushed;
  } finally {
    sse.close();
  }
  const task = await post(port, "/api/tasks", {
    target: "#all",
    title: "Write smoke task",
    assigneeId: agent.id
  });
  if (task.status !== "todo" || !task.messageId || !task.threadTarget) throw new Error("task metadata was not created");
  const channels = await get(port, "/api/channels");
  const allChannel = channels.find((channel: any) => channel.target === "#all");
  if (!allChannel) throw new Error("#all channel was not created");
  const messages = await get(port, `/api/messages/channel/${encodeURIComponent(allChannel.id)}?limit=50`);
  if (!messages.some((message: any) => message.id === task.messageId && message.type === "task")) throw new Error("task root message was not created");
  const channel = await post(port, "/api/channels", { name: "rename-source", description: "before" });
  const channelMessage = await post(port, "/api/messages", {
    target: channel.target,
    text: "rename smoke",
    authorId: "human-local"
  });
  const renamedChannel = await patch(port, `/api/channels/${encodeURIComponent(channel.id)}`, {
    name: "rename-dest",
    description: "after"
  });
  if (renamedChannel.target !== "#rename-dest") throw new Error("channel target was not renamed");
  const renamedMessages = await get(port, `/api/messages/channel/${encodeURIComponent(channel.id)}?limit=50`);
  if (!renamedMessages.some((message: any) => message.id === channelMessage.id && message.target === "#rename-dest")) {
    throw new Error("channel messages were not migrated after rename");
  }
  const chineseChannel = await post(port, "/api/channels", { name: "我的", description: "" });
  if (chineseChannel.name !== "我的" || chineseChannel.target !== "#我的") {
    throw new Error("unicode channel names should be preserved");
  }
  const renamedChineseChannel = await patch(port, `/api/channels/${encodeURIComponent(chineseChannel.id)}`, {
    name: "中文 频道"
  });
  if (renamedChineseChannel.target !== "#中文-频道") {
    throw new Error("unicode channel rename should preserve non-ascii letters");
  }
  const taskHeartbeat = await post(port, "/api/computers/connect", {
    token: invite.token,
    name: "smoke-computer",
    fingerprint: { id: "SMOKE12345", hostname: "smoke-computer", os: "darwin", arch: "arm64" },
    daemonVersion: "0.1.0",
    runtimes: [{ id: "codex", name: "Codex CLI", installed: true }]
  });
  if (!taskHeartbeat.deliveries.some((delivery: any) => delivery.target === task.threadTarget && delivery.messageId === task.messageId)) {
    throw new Error("assigned task was not delivered to its thread");
  }
  const reply = await post(port, "/api/messages", {
    target: task.threadTarget,
    text: "thread reply",
    authorId: "human-local"
  });
  if (reply.threadId !== task.messageId) throw new Error("thread reply did not keep root thread id");
  const messagesAfterReply = await get(port, `/api/messages/channel/${encodeURIComponent(allChannel.id)}?limit=50`);
  const taskRootAfterReply = messagesAfterReply.find((message: any) => message.id === task.messageId);
  if (taskRootAfterReply?.replyCount !== 1) throw new Error("channel messages should include thread reply counts");
  await patch(port, `/api/tasks/${task.id}`, { status: "in_review" });
  const tasks = await get(port, "/api/tasks");
  if (!tasks.some((item: any) => item.id === task.id && item.status === "in_review")) throw new Error("task status was not updated");

  // <thread> marker routes an otherwise-channel-level agent reply into a thread
  // anchored on the human's original mention. Verifies stripThreadMarker +
  // applyDeliveryResult routing in core.ts.
  const threadChannel = await post(port, "/api/channels", { name: "thread-marker", description: "" });
  const deepMention = await post(port, "/api/messages", {
    target: threadChannel.target,
    text: `@${agent.handle} deep dive`,
    authorId: "human-local"
  });
  const deepDelivery = (await get(port, "/api/deliveries"))
    .find((d: any) => d.messageId === deepMention.id && d.agentId === agent.id);
  if (!deepDelivery) throw new Error("channel mention did not create delivery");
  await post(port, `/api/deliveries/${encodeURIComponent(deepDelivery.id)}/result`,
    { ok: true, text: "<thread>\nlong-form reply" }, computerAuth);
  const threadTarget = `${threadChannel.target}:${deepMention.id}`;
  const threadReplies = await get(port, `/api/messages?target=${encodeURIComponent(threadTarget)}&limit=50`);
  const threadReply = threadReplies.find((m: any) => m.authorId === agent.id);
  if (!threadReply) throw new Error("agent reply with marker did not land in thread");
  if (threadReply.threadId !== deepMention.id) throw new Error("thread reply threadId must be original mention id");
  if (threadReply.text.includes("<thread>")) throw new Error("thread marker was not stripped from agent reply");
  if (!threadReply.text.includes("long-form reply")) throw new Error("agent reply text was truncated");

  // No marker → reply stays at channel level.
  const flatMention = await post(port, "/api/messages", {
    target: threadChannel.target,
    text: `@${agent.handle} quick ack`,
    authorId: "human-local"
  });
  const flatDelivery = (await get(port, "/api/deliveries"))
    .find((d: any) => d.messageId === flatMention.id && d.agentId === agent.id);
  if (!flatDelivery) throw new Error("second mention did not create delivery");
  await post(port, `/api/deliveries/${encodeURIComponent(flatDelivery.id)}/result`,
    { ok: true, text: "ack" }, computerAuth);
  const channelMsgs = await get(port, `/api/messages/channel/${encodeURIComponent(threadChannel.id)}?limit=50`);
  if (!channelMsgs.some((m: any) =>
    m.authorId === agent.id && m.target === threadChannel.target && m.text === "ack" && !m.threadId)) {
    throw new Error("agent reply without marker should stay at channel level");
  }

  console.log("smoke ok");
} finally {
  daemon.kill("SIGTERM");
  rmSync(home, { recursive: true, force: true });
}

async function waitForHealth(port: number): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    try {
      const health = await get(port, "/api/health");
      if (health.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

async function get(port: number, path: string): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.json();
}

async function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${response.status} ${path}: ${await response.text()}`);
  return response.json();
}

async function postStatus(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return response.status;
}

async function patch(port: number, path: string, body: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${response.status} ${path}: ${await response.text()}`);
  return response.json();
}

interface SseHandle {
  waitFor(type: string, timeoutMs: number): Promise<any>;
  close(): void;
}

async function openSse(port: number, computerId: string, token: string): Promise<SseHandle> {
  const controller = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${port}/api/computers/${encodeURIComponent(computerId)}/stream`,
    {
      headers: {
        accept: "text/event-stream",
        "x-iteam-connection": `${computerId}:${token}`
      },
      signal: controller.signal
    }
  );
  if (!response.ok || !response.body) throw new Error(`SSE open failed: ${response.status}`);

  const queue: Array<{ type: string; data: any }> = [];
  const waiters: Array<{ type: string; resolve: (event: any) => void }> = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  const dispatch = (type: string, data: any): void => {
    const idx = waiters.findIndex(w => w.type === type);
    if (idx !== -1) {
      const waiter = waiters.splice(idx, 1)[0];
      waiter.resolve(data);
    } else {
      queue.push({ type, data });
    }
  };

  (async () => {
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const rawEvent = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          let type = "message";
          let data = "";
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim();
          }
          if (data) {
            try {
              dispatch(type, JSON.parse(data));
            } catch {
              // ignore parse errors in smoke test
            }
          }
          separator = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // ignore — close() handles teardown
    }
  })();

  return {
    waitFor(type, timeoutMs) {
      return new Promise(resolve => {
        const idx = queue.findIndex(item => item.type === type);
        if (idx !== -1) {
          resolve(queue.splice(idx, 1)[0].data);
          return;
        }
        const timer = setTimeout(() => {
          const waiterIdx = waiters.findIndex(w => w.resolve === wrapped);
          if (waiterIdx !== -1) waiters.splice(waiterIdx, 1);
          resolve(null);
        }, timeoutMs);
        const wrapped = (data: any) => {
          clearTimeout(timer);
          resolve(data);
        };
        waiters.push({ type, resolve: wrapped });
      });
    },
    close() {
      closed = true;
      controller.abort();
    }
  };
}
