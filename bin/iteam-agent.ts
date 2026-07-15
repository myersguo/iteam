#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestJson } from "../src/http-client.js";
import type { Message, State } from "../src/types.js";

const serverUrl = (process.env.ITEAM_SERVER_URL || process.env.ITEAM_URL || "http://127.0.0.1:4318").replace(/\/$/, "");
const agentId = process.env.ITEAM_AGENT_ID;
const spaceId = process.env.ITEAM_SPACE_ID || "space_default";
const computerId = process.env.ITEAM_COMPUTER_ID || "";
const connectToken = process.env.ITEAM_CONNECT_TOKEN || "";
const agentAuthToken = process.env.ITEAM_AGENT_AUTH_TOKEN || "";
const [area, action, ...rest] = process.argv.slice(2);

function usage(): void {
  console.log(`iTeam agent CLI

Usage:
  iteam-agent server info
  iteam-agent message check [--target #all] [--limit 20]
  iteam-agent message read --target #all [--limit 30] [--around msg_id]
  iteam-agent message search <query...> [--target #all] [--limit 20]
  iteam-agent message send --target #all [message...]

Environment:
  ITEAM_AGENT_ID=${agentId || "(missing)"}
  ITEAM_SERVER_URL=${serverUrl}`);
}

function readFlag(name: string, fallback: string | null | undefined = undefined): string | true | null | undefined {
  const index = rest.indexOf(name);
  if (index === -1) return fallback;
  return rest[index + 1] ?? true;
}

function positionalWithoutFlags(): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(rest[i]);
  }
  return out;
}

async function main(): Promise<void> {
  if (!area || area === "--help" || area === "-h") return usage();
  if (!agentId) throw new Error("ITEAM_AGENT_ID is required");

  if (area === "server" && action === "info") {
    const state = await stateSnapshot();
    console.log(formatServerInfo(state));
    return;
  }

  if (area === "message" && action === "read") {
    const target = String(readFlag("--target", rest[0] || "#all"));
    const limit = Number(readFlag("--limit", "30"));
    const around = readFlag("--around", null);
    const state = await stateSnapshot();
    const messages = await fetchMessages(state, target, limit, typeof around === "string" ? around : undefined);
    console.log(formatMessages(state, messages));
    return;
  }

  if (area === "message" && action === "check") {
    const target = String(readFlag("--target", "#all"));
    const limit = Number(readFlag("--limit", "20"));
    const state = await stateSnapshot();
    const checkedAt = getLastCheck(target);
    const messages = (await fetchMessages(state, target, limit))
      .filter((message: Message) => message.target === target && message.authorId !== agentId && (!checkedAt || message.createdAt > checkedAt))
      .slice(-limit);
    setLastCheck(target);
    if (!messages.length) {
      console.log(`No new messages for ${target}.`);
      return;
    }
    console.log(formatMessages(state, messages));
    return;
  }

  if (area === "message" && action === "search") {
    const target = readFlag("--target", null);
    const limit = Number(readFlag("--limit", "20"));
    const query = positionalWithoutFlags().join(" ").toLowerCase();
    if (!query) throw new Error("search query is required");
    const state = await stateSnapshot();
    const targets = target ? [String(target)] : state.channels.map(channel => channel.target);
    const messages = (await Promise.all(targets.map(item => fetchMessages(state, item, limit)))).flat()
      .filter((message: Message) => String(message.text || "").toLowerCase().includes(query))
      .slice(-limit);
    // 输出 messages,超过 200 用省略号表示
    const allMessages = formatMessages(state, messages);
    console.log(allMessages.length > 200 ? allMessages.slice(0, 200) + "..." : allMessages);
    return;
  }

  if (area === "message" && action === "send") {
    const target = readFlag("--target", rest[0]);
    if (!target) throw new Error("--target is required");
    const flagIndex = rest.indexOf("--target");
    const textParts = flagIndex === -1 ? rest.slice(1) : rest.slice(0, flagIndex).concat(rest.slice(flagIndex + 2));
    const text = textParts.join(" ").trim() || await readStdin();
    if (!text.trim()) throw new Error("message text is required on argv or stdin");
    const message = await requestJson<Message>(`${serverUrl}/api/messages`, {
      method: "POST",
      headers: spaceHeaders(),
      body: { target, text, authorId: agentId }
    });
    console.log(`sent ${message.id} to ${target}`);
    return;
  }

  usage();
}

async function stateSnapshot(): Promise<State> {
  const [agents, humans, channels] = await Promise.all([
    requestJson<State["agents"]>(`${serverUrl}/api/agents`, { headers: spaceHeaders() }),
    requestJson<State["humans"]>(`${serverUrl}/api/humans`, { headers: spaceHeaders() }),
    requestJson<State["channels"]>(`${serverUrl}/api/channels`, { headers: spaceHeaders() })
  ]);
  return { agents, humans, channels, messages: [] } as unknown as State;
}

async function fetchMessages(state: State, target: string, limit: number, around?: string): Promise<Message[]> {
  const channel = state.channels.find(channel => channel.id === target || channel.target === target);
  if (channel) {
    const before = around ? `&before=${encodeURIComponent(around)}` : "";
    return requestJson<Message[]>(`${serverUrl}/api/messages/channel/${encodeURIComponent(channel.id)}?limit=${limit}${before}`, { headers: spaceHeaders() });
  }
  const before = around ? `&before=${encodeURIComponent(around)}` : "";
  return requestJson<Message[]>(`${serverUrl}/api/messages?target=${encodeURIComponent(target)}&limit=${limit}${before}`, { headers: spaceHeaders() });
}

function spaceHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "x-iteam-space": spaceId };
  if (computerId && agentId && agentAuthToken) {
    headers["x-iteam-agent-connection"] = `${computerId}:${agentId}:${agentAuthToken}`;
  } else if (computerId && connectToken) {
    headers["x-iteam-connection"] = `${computerId}:${connectToken}`;
  }
  return headers;
}

function formatServerInfo(state: State): string {
  const agents = state.agents.map(agent => `- agent ${agent.name} (@${agent.handle}) id=${agent.id} runtime=${agent.runtime} status=${agent.status}`).join("\n") || "- none";
  const humans = state.humans.map(human => `- human ${human.name} (@${human.handle}) id=${human.id}`).join("\n") || "- none";
  const channels = state.channels.map(channel => `- ${channel.target} ${channel.description || ""} members=${channel.memberIds.length}`).join("\n") || "- none";
  return `Server\nChannels:\n${channels}\n\nAgents:\n${agents}\n\nHumans:\n${humans}`;
}

function formatMessages(state: State, messages: Message[]): string {
  if (!messages.length) return "No messages.";
  return messages.map(message => {
    const author = state.agents.find(agent => agent.id === message.authorId) || state.humans.find(human => human.id === message.authorId);
    const handle = author?.handle ? `@${author.handle}` : message.authorId;
    return `[target=${message.target} msg=${message.id} time=${message.createdAt} type=${message.type || "message"}] ${handle}: ${message.text}`;
  }).join("\n");
}

function statePath(): string {
  const base = process.env.ITEAM_AGENT_STATE_DIR || process.cwd();
  const dir = join(base, ".iteam");
  mkdirSync(dir, { recursive: true });
  return join(dir, "agent-cli-state.json");
}

function getLastCheck(target: string): string | null {
  const file = statePath();
  if (!existsSync(file)) return null;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { lastCheck?: Record<string, string> }).lastCheck?.[target] || null;
  } catch {
    return null;
  }
}

function setLastCheck(target: string): void {
  const file = statePath();
  let data: { lastCheck?: Record<string, string> } = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as typeof data;
    } catch {}
  }
  data.lastCheck ||= {};
  data.lastCheck[target] = new Date().toISOString();
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => raw += chunk);
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

main().catch((error: Error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }));
  process.exit(1);
});
