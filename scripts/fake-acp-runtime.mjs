#!/usr/bin/env node

const sessions = new Map();
const pendingPrompts = new Map();
let nextSession = 1;

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message);
  }
});

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function result(id, value) {
  write({ id, result: value });
}

function notify(method, params) {
  write({ method, params });
}

function handle(message) {
  if (message.method === "initialize") {
    result(message.id, { protocolVersion: message.params?.protocolVersion ?? 1 });
    return;
  }

  if (message.method === "session/new") {
    const sessionId = `session-${nextSession++}`;
    sessions.set(sessionId, { prompts: 0 });
    result(message.id, { sessionId });
    return;
  }

  if (message.method === "session/prompt") {
    const sessionId = message.params?.sessionId;
    const promptText = (message.params?.prompt || [])
      .map(block => typeof block?.text === "string" ? block.text : "")
      .join("");
    const session = sessions.get(sessionId);
    if (!session) {
      write({ id: message.id, error: { code: -32001, message: `unknown session ${sessionId}` } });
      return;
    }
    session.prompts += 1;
    emitUpdates(sessionId, promptText, session.prompts);
    if (promptText.includes("wait-for-cancel")) {
      pendingPrompts.set(sessionId, message.id);
      return;
    }
    const delayMatch = promptText.match(/delay:(\d+)/);
    const delayMs = delayMatch ? Number(delayMatch[1]) : 0;
    if (delayMs > 0) {
      setTimeout(() => result(message.id, { stopReason: "stop" }), delayMs);
    } else {
      result(message.id, { stopReason: "stop" });
    }
    return;
  }

  if (message.method === "session/cancel") {
    const sessionId = message.params?.sessionId;
    const requestId = pendingPrompts.get(sessionId);
    if (requestId !== undefined) {
      pendingPrompts.delete(sessionId);
      result(requestId, { stopReason: "cancelled" });
    }
    return;
  }
}

function emitUpdates(sessionId, promptText, promptCount) {
  const base = { sessionId };
  const probeIndex = process.argv.indexOf("--runtime-cwd-probe");
  const profileArgCwd = probeIndex >= 0 ? process.argv[probeIndex + 1] || "" : "";
  notify("session/update", {
    ...base,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "text", text: `preamble:${sessionId}:${promptCount}` }]
    }
  });
  notify("session/update", {
    ...base,
    update: {
      sessionUpdate: "plan",
      entries: [{ content: `plan for ${promptText}`, status: "in_progress" }]
    }
  });
  notify("session/update", {
    ...base,
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: [{ type: "text", text: `thinking:${sessionId}:${promptCount}` }]
    }
  });
  notify("session/update", {
    ...base,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: `tool-${sessionId}-${promptCount}`,
      title: "shell",
      rawInput: { command: "echo fake-acp" }
    }
  });
  notify("session/update", {
    ...base,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: `tool-${sessionId}-${promptCount}`,
      status: "completed",
      rawOutput: { output: "ok" }
    }
  });
  notify("session/update", {
    ...base,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: [{
        type: "text",
        text: `reply:${sessionId}:${promptCount}:${process.cwd()}:${process.env.PWD}:${process.env.ITEAM_RUNTIME_CWD}:${process.env.PROFILE_RUNTIME_CWD || ""}:${profileArgCwd}:${promptText}`
      }]
    }
  });
}
