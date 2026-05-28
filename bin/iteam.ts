#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { requestJson } from "../src/http-client.js";
import { defaultHome, localComputerFingerprint, nowIso } from "../src/lib.js";
import type { Agent, Channel, Computer, Message, Task } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
// In source: bin/iteam.ts -> ../  (project root, src/server.ts ts-loadable via tsx).
// In published bundle: dist/cli/iteam.mjs -> ./  (sibling server.mjs etc.).
const root = resolve(here, "..");
const baseUrl = process.env.ITEAM_URL || "http://127.0.0.1:4318";
const [area, action, ...rest] = process.argv.slice(2);

function usage(): void {
  console.log(`iTeam local multi-agent workspace

Usage:
  iteam server start [--port 4318]
  iteam server status
  iteam agent-daemon connect --server-url <url> --connect-token <token> [--name computer-name]
  iteam web
  iteam computer list
  iteam agent create <name> [--runtime codex|claude|gemini|trae]
  iteam agent list
  iteam agent start <agent-id>
  iteam agent stop <agent-id>
  iteam channel list
  iteam message send <#channel> <message...>
  iteam message read <#channel>
  iteam task create <#channel> <title...> [--agent <agent-id>]
  iteam task list

Environment:
  ITEAM_HOME=${defaultHome()}
  ITEAM_URL=${baseUrl}`);
}

function readFlag(name: string, fallback: string | undefined = undefined): string | true | undefined {
  const i = rest.indexOf(name);
  if (i === -1) return fallback;
  return rest[i + 1] ?? true;
}

/**
 * Resolve a runtime entry. In dev (running from source via tsx) we point at
 * `src/<name>.ts`; in the published package we point at the bundled
 * `dist/cli/<name>.mjs` next to ourselves and run it with plain node.
 */
function resolveEntry(name: string): { argv: string[] } {
  const bundled = resolve(here, `${name}.mjs`);
  if (existsSync(bundled)) {
    return { argv: [process.execPath, bundled] };
  }
  // Dev fallback: spawn via tsx.
  const tsxBin = resolve(root, "node_modules/.bin/tsx");
  return { argv: [tsxBin, resolve(root, `src/${name}.ts`)] };
}

async function main(): Promise<void> {
  if (!area || area === "--help" || area === "-h") return usage();

  if ((area === "server" || area === "daemon") && action === "start") {
    const port = readFlag("--port", process.env.ITEAM_PORT || "4318");
    const entry = resolveEntry("server");
    const child = spawn(entry.argv[0], [...entry.argv.slice(1), "--port", String(port)], {
      stdio: "inherit",
      env: process.env
    });
    child.on("exit", code => process.exit(code ?? 0));
    return;
  }

  if ((area === "agent-daemon" || (area === "daemon" && action === "connect"))) {
    const isConnect = area === "agent-daemon" ? action === "connect" || action === undefined : true;
    if (!isConnect) {
      throw new Error("only `iteam agent-daemon connect` is supported");
    }
    const serverUrl = readFlag("--server-url", process.env.ITEAM_SERVER_URL);
    const connectToken = readFlag("--connect-token", process.env.ITEAM_CONNECT_TOKEN);
    if (!serverUrl || !connectToken) throw new Error("--server-url and --connect-token are required");
    const entry = resolveEntry("agent-daemon");
    const child = spawn(entry.argv[0], [
      ...entry.argv.slice(1),
      "--server-url", String(serverUrl),
      "--connect-token", String(connectToken),
      "--name", String(readFlag("--name", localComputerFingerprint().hostname))
    ], {
      stdio: "inherit",
      env: process.env
    });
    child.on("exit", code => process.exit(code ?? 0));
    return;
  }

  if (area === "web") {
    const child = spawn("npm", ["run", "dev"], {
      cwd: root,
      stdio: "inherit",
      env: process.env
    });
    child.on("exit", code => process.exit(code ?? 0));
    return;
  }

  if ((area === "server" || area === "daemon") && action === "status") {
    const health = await requestJson(`${baseUrl}/api/health`);
    console.log(JSON.stringify(health, null, 2));
    return;
  }

  if (area === "computer" && action === "list") {
    const computers = await requestJson<Computer[]>(`${baseUrl}/api/computers`);
    console.table(computers.map((c: Computer) => ({ id: c.id, name: c.name, status: c.status, agents: c.agentIds.length })));
    return;
  }

  if (area === "agent" && action === "create") {
    const name = rest[0];
    if (!name) throw new Error("agent name is required");
    const runtime = readFlag("--runtime", "codex");
    const body = { name, runtime, description: `${runtime} agent`, computerId: "local" };
    console.log(JSON.stringify(await requestJson(`${baseUrl}/api/agents`, { method: "POST", body }), null, 2));
    return;
  }

  if (area === "agent" && action === "list") {
    const agents = await requestJson<Agent[]>(`${baseUrl}/api/agents`);
    console.table(agents.map((a: Agent) => ({ id: a.id, name: a.name, runtime: a.runtime, status: a.status, model: a.model })));
    return;
  }

  if (area === "agent" && action && ["start", "stop"].includes(action)) {
    const id = rest[0];
    if (!id) throw new Error("agent id is required");
    console.log(JSON.stringify(await requestJson(`${baseUrl}/api/agents/${id}/${action}`, { method: "POST" }), null, 2));
    return;
  }

  if (area === "channel" && action === "list") {
    const channels = await requestJson<Channel[]>(`${baseUrl}/api/channels`);
    console.table(channels.map((c: Channel) => ({ id: c.id, name: c.name, kind: c.kind, members: c.memberIds.length })));
    return;
  }

  if (area === "message" && action === "send") {
    const target = rest[0];
    const text = rest.slice(1).join(" ");
    if (!target || !text) throw new Error("target and message are required");
    const body = { target, text, authorId: "human-local", createdAt: nowIso() };
    console.log(JSON.stringify(await requestJson(`${baseUrl}/api/messages`, { method: "POST", body }), null, 2));
    return;
  }

  if (area === "message" && action === "read") {
    const target = rest[0] || "#all";
    const [messages, agents, humans] = await Promise.all([
      requestJson<Message[]>(`${baseUrl}/api/messages?target=${encodeURIComponent(target)}&limit=30`),
      requestJson<Agent[]>(`${baseUrl}/api/agents`),
      requestJson<{ id: string; name: string }[]>(`${baseUrl}/api/humans`)
    ]);
    for (const m of messages) {
      const author = agents.find((a: Agent) => a.id === m.authorId)?.name || humans.find((h) => h.id === m.authorId)?.name || m.authorId;
      console.log(`[${m.createdAt}] ${author}: ${m.text}`);
    }
    return;
  }

  if (area === "task" && action === "create") {
    const target = rest[0];
    const agentIndex = rest.indexOf("--agent");
    const titleParts = agentIndex === -1 ? rest.slice(1) : rest.slice(1, agentIndex);
    if (!target || titleParts.length === 0) throw new Error("target and title are required");
    const body = { target, title: titleParts.join(" "), assigneeId: agentIndex === -1 ? null : rest[agentIndex + 1] };
    console.log(JSON.stringify(await requestJson(`${baseUrl}/api/tasks`, { method: "POST", body }), null, 2));
    return;
  }

  if (area === "task" && action === "list") {
    const tasks = await requestJson<Task[]>(`${baseUrl}/api/tasks`);
    console.table(tasks.map((t: Task) => ({ id: t.id, status: t.status, target: t.target, assignee: t.assigneeId || "", title: t.title })));
    return;
  }

  usage();
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
