// `iteam message ...` — send, read, watch (poll for new messages).

import { printMessage, printResult } from "../output.js";
import { flagString } from "../args.js";
import { nowIso } from "@iteam/shared";
import type { CommandContext } from "../types.js";
import type { Agent, Message } from "@iteam/shared";

export async function runMessage(cmd: CommandContext): Promise<void> {
  switch (cmd.action) {
    case "send":
      return send(cmd);
    case "read":
      return read(cmd);
    case "watch":
      return watch(cmd);
    default:
      throw new Error("usage: iteam message send <target> <text...>|read <target>|watch <target>");
  }
}

async function send(cmd: CommandContext): Promise<void> {
  const target = cmd.args.positionals[0];
  const text = cmd.args.positionals.slice(1).join(" ");
  if (!target || !text) throw new Error("usage: iteam message send <#channel|dm:agentId> <text...>");
  const body = {
    target,
    text,
    authorId: flagString(cmd.args, "as") || "human-local",
    createdAt: nowIso()
  };
  const message = await cmd.client.post<Message>("/api/messages", body);
  if (cmd.output.json) return printResult(message, cmd.output);
  printMessage(`sent to ${target} (message ${message.id})`, cmd.output, message);
}

async function loadAuthors(cmd: CommandContext): Promise<Map<string, string>> {
  const [agents, humans] = await Promise.all([
    cmd.client.get<Agent[]>("/api/agents").catch(() => [] as Agent[]),
    cmd.client.get<{ id: string; name: string }[]>("/api/humans").catch(() => [])
  ]);
  const authors = new Map<string, string>();
  for (const a of agents) authors.set(a.id, a.name);
  for (const h of humans) authors.set(h.id, h.name);
  return authors;
}

async function read(cmd: CommandContext): Promise<void> {
  const target = cmd.args.positionals[0] || "#all";
  const limit = flagString(cmd.args, "limit") || "30";
  const messages = await cmd.client.get<Message[]>(
    `/api/messages?target=${encodeURIComponent(target)}&limit=${encodeURIComponent(limit)}`
  );
  if (cmd.output.json) return printResult(messages, cmd.output);
  const authors = await loadAuthors(cmd);
  for (const m of messages) {
    console.log(`[${m.createdAt}] ${authors.get(m.authorId) || m.authorId}: ${m.text}`);
  }
}

async function watch(cmd: CommandContext): Promise<void> {
  const target = cmd.args.positionals[0] || "#all";
  const intervalMs = Number(flagString(cmd.args, "interval") || "2000");
  const authors = await loadAuthors(cmd);
  const seen = new Set<string>();
  // Seed with the current tail so we only print messages that arrive after we
  // start watching.
  const initial = await cmd.client.get<Message[]>(
    `/api/messages?target=${encodeURIComponent(target)}&limit=30`
  );
  for (const m of initial) seen.add(m.id);
  if (!cmd.output.json) console.log(`watching ${target} (Ctrl-C to stop)…`);

  for (;;) {
    await sleep(intervalMs);
    let latest: Message[];
    try {
      latest = await cmd.client.get<Message[]>(
        `/api/messages?target=${encodeURIComponent(target)}&limit=30`
      );
    } catch (error) {
      if (!cmd.output.json) console.error(`poll failed: ${(error as Error).message}`);
      continue;
    }
    for (const m of latest) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (!authors.has(m.authorId)) authors.set(m.authorId, m.authorId);
      if (cmd.output.json) {
        process.stdout.write(JSON.stringify(m) + "\n");
      } else {
        console.log(`[${m.createdAt}] ${authors.get(m.authorId) || m.authorId}: ${m.text}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
