#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { requestJson } from "./http-client.js";
import { nowIso } from "./lib.js";
import type { Message, State } from "./types.js";

const agentId = readArg("--agent-id");
const serverUrl = (readArg("--server-url", "http://127.0.0.1:4318") || "http://127.0.0.1:4318").replace(/\/$/, "");
const spaceId = readArg("--space-id", process.env.ITEAM_SPACE_ID) || "space_default";
const runtime = readArg("--runtime", "unknown") || "unknown";
const launchId = readArg("--launch-id", "") || "";
const computerId = readArg("--computer-id", process.env.ITEAM_COMPUTER_ID) || "";
const connectToken = readArg("--connect-token", process.env.ITEAM_CONNECT_TOKEN) || "";
const agentAuthToken = process.env.ITEAM_AGENT_AUTH_TOKEN || "";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "x-iteam-space": spaceId };
  if (computerId && agentId && agentAuthToken) {
    headers["x-iteam-agent-connection"] = `${computerId}:${agentId}:${agentAuthToken}`;
  } else if (computerId && connectToken) {
    headers["x-iteam-connection"] = `${computerId}:${connectToken}`;
  }
  return headers;
}

const server = new McpServer({
  name: "iteam-chat-bridge",
  version: "0.1.0"
});

server.registerTool("runtime_profile_migration_done", {
  title: "Runtime Profile Migration Done",
  description: "Record that a runtime profile compatibility step has completed."
}, async () => {
  await report("runtime_profile_migration_done", {});
  return textResult("Recorded.");
});

server.registerTool("iteam_runtime_heartbeat", {
  title: "iTeam Runtime Heartbeat",
  description: "Report that the local runtime bridge is still alive."
}, async () => {
  await report("heartbeat", {});
  return textResult(`Alive at ${nowIso()}.`);
});

server.registerTool("iteam_server_info", {
  title: "iTeam Server Info",
  description: "List local channels, humans, agents, and runtime status."
}, async () => {
  const state = await stateSnapshot();
  return textResult(formatServerInfo(state));
});

server.registerTool("iteam_message_read", {
  title: "Read iTeam Messages",
  description: "Read recent messages from a channel or thread target.",
  inputSchema: {
    target: z.string().default("#all"),
    limit: z.number().int().min(1).max(100).default(30),
    around: z.string().optional()
  }
}, async ({ target = "#all", limit = 30, around }: { target?: string; limit?: number; around?: string }) => {
  const state = await stateSnapshot();
  const messages = await fetchMessages(state, target, limit, around);
  return textResult(formatMessages(state, messages));
});

server.registerTool("iteam_message_search", {
  title: "Search iTeam Messages",
  description: "Search visible local iTeam messages.",
  inputSchema: {
    query: z.string(),
    target: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20)
  }
}, async ({ query, target, limit = 20 }: { query: string; target?: string; limit?: number }) => {
  const state = await stateSnapshot();
  const q = query.toLowerCase();
  const targets = target ? [target] : state.channels.map(channel => channel.target);
  const batches = await Promise.all(targets.map(item => fetchMessages(state, item, limit)));
  const messages = batches.flat()
    .filter(message => String(message.text || "").toLowerCase().includes(q))
    .slice(-limit);
  return textResult(formatMessages(state, messages));
});

server.registerTool("iteam_message_send", {
  title: "Send iTeam Message",
  description: "Send an additional asynchronous iTeam update. Do not use this for the current delivery's primary reply; return that as your normal final response.",
  inputSchema: {
    target: z.string().default("#all"),
    text: z.string()
  }
}, async ({ target = "#all", text }: { target?: string; text: string }) => {
  if (!agentId) return textResult("Cannot send: missing agent id.");
  const message = await requestJson<Message>(`${serverUrl}/api/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: { target, text, authorId: agentId }
  });
  return textResult(`sent ${message.id} to ${target}`);
});

// Don't block MCP handshake on the start-up phone-home. If the daemon is
// unreachable, awaiting this would deadlock `server.connect()` and the
// ACP host would see no MCP tools at all.
void report("bridge_started", {}).catch(() => {});
await server.connect(new StdioServerTransport());

// State fan-out (3 endpoints) is expensive on the server side — every
// `core.snapshot()` does a full `JSON.parse(JSON.stringify(state))` deep
// clone (store/base.ts). A single agent turn often calls multiple tools
// in quick succession; cache the fan-out for a short window and dedupe
// concurrent misses through a shared inflight promise.
const STATE_TTL_MS = 1500;
let stateCache: { value: State; expiresAt: number } | null = null;
let stateInflight: Promise<State> | null = null;

async function stateSnapshot(): Promise<State> {
  const now = Date.now();
  if (stateCache && stateCache.expiresAt > now) return stateCache.value;
  if (stateInflight) return stateInflight;
  const job = (async () => {
    const [agents, humans, channels] = await Promise.all([
      requestJson<State["agents"]>(`${serverUrl}/api/agents`, { headers: authHeaders() }),
      requestJson<State["humans"]>(`${serverUrl}/api/humans`, { headers: authHeaders() }),
      requestJson<State["channels"]>(`${serverUrl}/api/channels`, { headers: authHeaders() })
    ]);
    const value = { agents, humans, channels, messages: [] } as unknown as State;
    stateCache = { value, expiresAt: Date.now() + STATE_TTL_MS };
    return value;
  })();
  stateInflight = job;
  try {
    return await job;
  } finally {
    if (stateInflight === job) stateInflight = null;
  }
}

function messagesUrl(state: State, target: string, limit: number, around?: string): string {
  const before = around ? `&before=${encodeURIComponent(around)}` : "";
  const channel = state.channels.find(channel => channel.id === target || channel.target === target);
  if (channel) {
    return `${serverUrl}/api/messages/channel/${encodeURIComponent(channel.id)}?limit=${limit}${before}`;
  }
  return `${serverUrl}/api/messages?target=${encodeURIComponent(target)}&limit=${limit}${before}`;
}

async function fetchMessages(state: State, target: string, limit: number, around?: string): Promise<Message[]> {
  return requestJson<Message[]>(messagesUrl(state, target, limit, around), { headers: authHeaders() });
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

async function report(event: string, payload: unknown): Promise<void> {
  if (!agentId) return;
  try {
    await requestJson(`${serverUrl}/api/agents/${agentId}/runtime-event`, {
      method: "POST",
      headers: authHeaders(),
      body: { runtime, launchId, event, payload, createdAt: nowIso() }
    });
  } catch {
    // MCP stdio must stay quiet; daemon status will surface connection failures.
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function readArg(name: string, fallback: string | undefined = undefined): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

// Watchdog: exit if the parent closes our stdin (e.g. the ACP host process
// died). Prevents orphan chat-bridge processes from lingering. `close` is
// emitted after `end`, so a single listener covers both EOF and transport
// teardown.
process.stdin.once("close", () => {
  process.exit(0);
});
