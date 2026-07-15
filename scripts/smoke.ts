import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "../src/types.js";
import { deriveAgentAuthToken } from "../src/lib.js";
import { formatTaskRuntimeProgress } from "../src/agent-launcher.js";
import { AcpDriver } from "../src/runtime/acp-driver.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import {
  MYSQL_SPACE_BACKFILL_QUERIES,
  planMysqlChannelUniqueMigration
} from "../src/store/mysql-store.js";
import { MYSQL_TABLES } from "../src/store/mysql-schema.js";
import { notificationBelongsToThread } from "../src/runtime/codex-driver.js";
import { detectRuntimes } from "../src/runtimes.js";
import { deliveryAffinityIndex } from "../src/runtime/driver.js";
import { renderAcpProfileArgs, resolveAcpRuntimeProfile } from "../src/runtime/acp-profiles.js";
import { renderProfileArgs, resolveRuntimeProfile } from "../src/runtime/profiles.js";
import { parseIteamCommand, stripLarkBotMention } from "../src/integrations/lark.js";
import { legacyIteamMcpServerNames } from "../src/legacy-traex-mcp.js";
import { agentEnv, prepareAgentWorkspace, shellSingleQuote } from "../src/workspace.js";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = resolve(root, "node_modules/.bin/tsx");
const home = mkdtempSync(join(tmpdir(), "iteam-smoke-"));
const runtimeProfilesFile = join(home, "runtime-profiles.json");
const acpProfilesFile = join(home, "acp-runtimes.json");
const fakeAcpScript = resolve(root, "scripts/fake-acp-runtime.mjs");
const profileCwd = join(home, "profile-cwd");
const binDir = join(home, "bin");
const genericAcpBin = join(binDir, "generic_acp");
delete process.env.ITEAM_RUNTIME_CWD;
mkdirSync(binDir, { recursive: true });
mkdirSync(profileCwd, { recursive: true });
writeFileSync(genericAcpBin, `#!/usr/bin/env sh
exec "${process.execPath}" "${fakeAcpScript}" "$@"
`);
chmodSync(genericAcpBin, 0o755);
process.env.PATH = `${binDir}:${process.env.PATH || ""}`;
writeFileSync(runtimeProfilesFile, JSON.stringify({
  custom: {
    command: "echo",
    args: ["{{sessionKey}}", "{{safeSessionKey}}", "{{agentName}}", "{{prompt}}"]
  },
  custom_cwd: {
    command: process.execPath,
    args: [
      "-e",
      "console.log(JSON.stringify({cwd:process.cwd(),pwd:process.env.PWD,runtimeCwd:process.env.ITEAM_RUNTIME_CWD}))"
    ],
    cwd: profileCwd
  }
}, null, 2));
writeFileSync(acpProfilesFile, JSON.stringify({
  hermes_test: {
    command: "hermes",
    args: ["acp", "--workspace", "{{workspaceDir}}", "{{modelArgs}}"],
    poolSize: 1
  },
  fake_acp: {
    command: process.execPath,
    args: [fakeAcpScript],
    poolSize: 1
  },
  fake_acp_cwd: {
    command: process.execPath,
    args: [fakeAcpScript, "--runtime-cwd-probe", "{{runtimeCwd}}"],
    cwd: profileCwd,
    env: { PROFILE_RUNTIME_CWD: "{{runtimeCwd}}" },
    poolSize: 1
  },
  fake_acp_parallel: {
    command: process.execPath,
    args: [fakeAcpScript],
    poolSize: 50
  },
  fake_acp_queue: {
    command: process.execPath,
    args: [fakeAcpScript],
    poolSize: 2
  }
}, null, 2));
process.env.ITEAM_RUNTIME_PROFILES = runtimeProfilesFile;
process.env.ITEAM_ACP_RUNTIMES = acpProfilesFile;
const smokeRuntimes = [
  { id: "codex", name: "Codex CLI", installed: true },
  { id: "custom", name: "Custom profile", installed: true },
  { id: "fake_acp", name: "Fake ACP", installed: true },
  { id: "daemon_only", name: "Daemon-only runtime", installed: true }
];
const port = 18000 + Math.floor(Math.random() * 10000);
const daemon = spawn(tsxBin, [resolve(root, "src/server.ts"), "--port", String(port)], {
  env: { ...process.env, ITEAM_HOME: home, ITEAM_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  const larkRouteCommand = parseIteamCommand("/all @codex 帮我看一下这个问题");
  if (larkRouteCommand.kind !== "message" || larkRouteCommand.target !== "#all" || larkRouteCommand.text !== "@codex 帮我看一下这个问题") {
    throw new Error("Lark /all route command was not parsed");
  }
  const larkBindCommand = parseIteamCommand("/iteam bind #all");
  if (larkBindCommand.kind !== "bind" || larkBindCommand.target !== "#all") {
    throw new Error("Lark /iteam bind command was not parsed");
  }
  const larkMentionedBindCommand = parseIteamCommand("@iteam /iteam bind #all");
  if (larkMentionedBindCommand.kind !== "bind" || larkMentionedBindCommand.target !== "#all") {
    throw new Error("Lark bot-mentioned /iteam bind command was not parsed");
  }
  const strippedBotMention = stripLarkBotMention("@_user_1 /iteam bind #all", [
    { key: "@_user_1", name: "iteam", mentioned_type: "bot" }
  ]);
  if (strippedBotMention !== "/iteam bind #all" || parseIteamCommand(strippedBotMention).kind !== "bind") {
    throw new Error("Lark bot mention key was not stripped before bind parsing");
  }
  const larkTaskCommand = parseIteamCommand("/task /all @codex 帮我看一下这个问题");
  if (larkTaskCommand.kind !== "task" || larkTaskCommand.target !== "#all" || larkTaskCommand.text !== "@codex 帮我看一下这个问题") {
    throw new Error("Lark /task route command was not parsed");
  }
  const bareAgentCommand = parseIteamCommand("codex: 帮我分析一下");
  if (bareAgentCommand.kind !== "message" || bareAgentCommand.target || bareAgentCommand.agentHandle !== "codex" || bareAgentCommand.text !== "帮我分析一下") {
    throw new Error("bare `handle:` prefix was not parsed as agent selector");
  }
  const bareAgentNoSpace = parseIteamCommand("aiden:hi");
  if (bareAgentNoSpace.kind !== "message" || bareAgentNoSpace.target || bareAgentNoSpace.agentHandle !== "aiden" || bareAgentNoSpace.text !== "hi") {
    throw new Error("`handle:` without a space after the colon should still route to the agent");
  }
  const channelAgentCommand = parseIteamCommand("/ops codex: 复现下这个 bug");
  if (channelAgentCommand.kind !== "message" || channelAgentCommand.target !== "#ops" || channelAgentCommand.agentHandle !== "codex" || channelAgentCommand.text !== "复现下这个 bug") {
    throw new Error("`/channel handle:` combo was not parsed");
  }
  const taskWithAgent = parseIteamCommand("/task codex: 记个待办");
  if (taskWithAgent.kind !== "task" || taskWithAgent.agentHandle !== "codex" || taskWithAgent.text !== "记个待办") {
    throw new Error("`/task handle:` combo was not parsed");
  }
  const bindWithAgent = parseIteamCommand("/iteam bind #all codex");
  if (bindWithAgent.kind !== "bind" || bindWithAgent.target !== "#all" || bindWithAgent.agentHandle !== "codex") {
    throw new Error("/iteam bind #all codex was not parsed with agent");
  }
  const bindWithoutAgent = parseIteamCommand("/iteam bind #all");
  if (bindWithoutAgent.kind !== "bind" || bindWithoutAgent.target !== "#all" || bindWithoutAgent.agentHandle) {
    throw new Error("/iteam bind #all should not attach an agent when none is given");
  }
  const linkText = parseIteamCommand("https://example.com/foo");
  if (linkText.kind !== "message" || linkText.agentHandle || linkText.text !== "https://example.com/foo") {
    throw new Error("plain URLs must not be treated as agent selectors");
  }
  const mailtoText = parseIteamCommand("mailto:a@b.com");
  if (mailtoText.kind !== "message" || mailtoText.agentHandle || mailtoText.text !== "mailto:a@b.com") {
    throw new Error("mailto links must not be treated as agent selectors");
  }
  const gitSchemeText = parseIteamCommand("git://example.com/repo.git");
  if (gitSchemeText.kind !== "message" || gitSchemeText.agentHandle || gitSchemeText.text !== "git://example.com/repo.git") {
    throw new Error("scheme://... URLs must not be treated as agent selectors");
  }
  const affinityA = deliveryAffinityIndex({
    id: "delivery_a",
    spaceId: "space_default",
    target: "#all:msg_task",
    messageId: "msg_task",
    rootMessageId: "msg_task",
    parentDeliveryId: null,
    depth: 0,
    agentId: "agent_test",
    computerId: "computer_test",
    status: "delivering",
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, 3);
  const affinityB = deliveryAffinityIndex({
    id: "delivery_b",
    spaceId: "space_default",
    target: "#all:msg_task",
    messageId: "msg_followup",
    rootMessageId: "msg_task",
    parentDeliveryId: null,
    depth: 0,
    agentId: "agent_test",
    computerId: "computer_test",
    status: "delivering",
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, 3);
  if (affinityA !== affinityB) throw new Error("same task thread must keep runtime session affinity");
  const affinitySessionA = deliveryAffinityIndex({
    id: "delivery_session_a",
    spaceId: "space_default",
    target: "#all",
    messageId: "msg_a",
    rootMessageId: "msg_a",
    parentDeliveryId: null,
    depth: 0,
    agentId: "agent_test",
    computerId: "computer_test",
    sessionKey: "sticky-session",
    status: "delivering",
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, 3);
  const affinitySessionB = deliveryAffinityIndex({
    id: "delivery_session_b",
    spaceId: "space_default",
    target: "#random",
    messageId: "msg_b",
    rootMessageId: "msg_b",
    parentDeliveryId: null,
    depth: 0,
    agentId: "agent_test",
    computerId: "computer_test",
    sessionKey: "sticky-session",
    status: "delivering",
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, 3);
  if (affinitySessionA !== affinitySessionB) throw new Error("explicit sessionKey must control runtime affinity");
  const customProfile = resolveRuntimeProfile("custom");
  if (!customProfile) throw new Error("runtime profile file was not loaded");
  const renderedArgs = renderProfileArgs(customProfile, {
    agent: { id: "agent_test", spaceId: "space_default", name: "Profile Agent", handle: "profile", description: "", runtime: "opencode", model: null, computerId: "computer_test", status: "online", desiredStatus: "running", launchId: null, pid: null, workspacePath: "", createdAt: "", updatedAt: "" },
    delivery: {
      id: "delivery_profile",
      spaceId: "space_default",
      target: "#all",
      messageId: "msg_profile",
      rootMessageId: "msg_profile",
      parentDeliveryId: null,
      depth: 0,
      agentId: "agent_test",
      computerId: "computer_test",
      sessionKey: "Hello Session!",
      status: "delivering",
      attempts: 0,
      createdAt: "",
      updatedAt: ""
    },
    prompt: "profile prompt",
    timeoutMs: 1000
  });
  if (renderedArgs[0] !== "Hello Session!" || renderedArgs[1] !== "hello-session" || renderedArgs[3] !== "profile prompt") {
    throw new Error("runtime profile templates did not render session/prompt values");
  }
  const acpProfile = resolveAcpRuntimeProfile("hermes_test");
  if (!acpProfile) throw new Error("ACP runtime profile file was not loaded");
  const renderedAcpArgs = renderAcpProfileArgs(acpProfile, {
    agent: { id: "agent_test", spaceId: "space_default", name: "ACP Agent", handle: "acp", description: "", runtime: "hermes_test", model: "test-model", computerId: "computer_test", status: "online", desiredStatus: "running", launchId: null, pid: null, workspacePath: "", createdAt: "", updatedAt: "" },
    workspace: {
      workspaceDir: "/workspace/acp",
      dir: "/workspace/acp-pool-0",
      runtimeCwd: "/runtime/cwd",
      internal: "/workspace/acp-pool-0/.iteam",
      memoryPath: "",
      systemPromptPath: "",
      claudeMcpConfigPath: "",
      traeMcpConfigPath: "",
      bridgePath: "",
      bridgeArgs: [],
      bridgeCommand: "node",
      runtimeAuthEnv: {},
      wrapperPath: "",
      promptPath: ""
    },
    timeoutMs: 1000
  });
  if (renderedAcpArgs.join(" ") !== "acp --workspace /workspace/acp -m test-model") {
    throw new Error("ACP runtime profile templates did not render workspace/model values");
  }
  const workspaceAgent: Agent = {
    id: "agent_workspace",
    spaceId: "space_workspace",
    name: "Workspace Agent",
    handle: "workspace-agent",
    description: "",
    runtime: "fake_acp",
    model: null,
    computerId: "computer_test",
    status: "online",
    desiredStatus: "running",
    launchId: null,
    pid: null,
    workspacePath: join(home, "workspace-agent-state"),
    createdAt: "",
    updatedAt: ""
  };
  const preparedWorkspace = prepareAgentWorkspace({
    agent: workspaceAgent,
    serverUrl: "http://127.0.0.1:4318",
    launchId: "launch_workspace",
    stateSuffix: "-pool-0",
    computerId: "computer_workspace",
    connectToken: "connect_workspace"
  });
  if (
    preparedWorkspace.workspaceDir !== workspaceAgent.workspacePath ||
    preparedWorkspace.runtimeCwd !== workspaceAgent.workspacePath ||
    preparedWorkspace.dir !== `${workspaceAgent.workspacePath}-pool-0` ||
    preparedWorkspace.memoryPath !== join(workspaceAgent.workspacePath, "MEMORY.md") ||
    !preparedWorkspace.bridgeArgs.includes("--space-id") ||
    !preparedWorkspace.bridgeArgs.includes("space_workspace")
  ) {
    throw new Error("agent workspace did not separate shared workspace, worker state, or space id");
  }
  const workspacePrompt = readFileSync(preparedWorkspace.systemPromptPath, "utf8");
  if (
    !workspacePrompt.includes(`Working directory: ${workspaceAgent.workspacePath}`) ||
    !workspacePrompt.includes(`iTeam state directory: ${workspaceAgent.workspacePath}-pool-0`) ||
    !workspacePrompt.includes("When a question asks about a current value that a shell or runtime tool can observe")
  ) {
    throw new Error("agent system prompt did not distinguish runtime cwd or require observable fact verification");
  }
  const overriddenWorkspace = prepareAgentWorkspace({
    agent: { ...workspaceAgent, env: { ITEAM_RUNTIME_CWD: home } },
    serverUrl: "http://127.0.0.1:4318",
    launchId: "launch_workspace_override",
    stateSuffix: "-pool-1"
  });
  if (overriddenWorkspace.runtimeCwd !== workspaceAgent.workspacePath) {
    throw new Error("server-provided agent env unexpectedly overrode the base workspace");
  }
  const preparedEnv = agentEnv({
    agent: workspaceAgent,
    serverUrl: "http://127.0.0.1:4318",
    workspace: preparedWorkspace
  });
  if (
    preparedEnv.PWD !== workspaceAgent.workspacePath ||
    preparedEnv.ITEAM_AGENT_STATE_DIR !== `${workspaceAgent.workspacePath}-pool-0`
  ) {
    throw new Error("agent environment did not preserve logical workspace PWD and isolated worker state");
  }
  const expectedModes = [
    [preparedWorkspace.dir, 0o700],
    [preparedWorkspace.internal, 0o700],
    [preparedWorkspace.memoryPath, 0o600],
    [preparedWorkspace.systemPromptPath, 0o600],
    [preparedWorkspace.claudeMcpConfigPath, 0o600],
    [preparedWorkspace.traeMcpConfigPath, 0o600],
    [preparedWorkspace.wrapperPath, 0o700]
  ] as const;
  for (const [path, expectedMode] of expectedModes) {
    if ((statSync(path).mode & 0o777) !== expectedMode) {
      throw new Error(`sensitive workspace path has incorrect mode: ${path}`);
    }
  }
  const quoteProbe = `spaces and 'quotes'; echo unsafe`;
  const quoteResult = await execFileText("/bin/sh", [
    "-c",
    `value=${shellSingleQuote(quoteProbe)}; printf '%s' "$value"`
  ], {});
  if (quoteResult !== quoteProbe) {
    throw new Error("workspace shell escaping did not preserve a hostile-looking literal");
  }
  const workspaceWrapper = readFileSync(preparedWorkspace.wrapperPath, "utf8");
  const credentialFiles = [
    workspaceWrapper,
    readFileSync(preparedWorkspace.claudeMcpConfigPath, "utf8"),
    readFileSync(preparedWorkspace.traeMcpConfigPath, "utf8")
  ];
  if (credentialFiles.some(content => content.includes("connect_workspace"))) {
    throw new Error("permanent computer credential was persisted in agent files");
  }
  if (
    preparedWorkspace.runtimeAuthEnv.ITEAM_COMPUTER_ID !== "computer_workspace" ||
    preparedWorkspace.runtimeAuthEnv.ITEAM_AGENT_AUTH_TOKEN !==
      deriveAgentAuthToken("connect_workspace", workspaceAgent.id) ||
    "ITEAM_CONNECT_TOKEN" in preparedWorkspace.runtimeAuthEnv
  ) {
    throw new Error("runtime authentication was not retained in memory");
  }
  let invalidRuntimeCwdRejected = false;
  const previousRuntimeCwd = process.env.ITEAM_RUNTIME_CWD;
  try {
    process.env.ITEAM_RUNTIME_CWD = join(home, "missing-runtime-cwd");
    prepareAgentWorkspace({
      agent: workspaceAgent,
      serverUrl: "http://127.0.0.1:4318",
      launchId: "launch_workspace_invalid"
    });
  } catch (error) {
    invalidRuntimeCwdRejected = String((error as Error).message).includes("must be an existing directory");
  } finally {
    if (previousRuntimeCwd === undefined) delete process.env.ITEAM_RUNTIME_CWD;
    else process.env.ITEAM_RUNTIME_CWD = previousRuntimeCwd;
  }
  if (!invalidRuntimeCwdRejected) {
    throw new Error("invalid ITEAM_RUNTIME_CWD did not fail fast");
  }
  const remoteWorkspace = join(home, "remote-readonly-workspace");
  mkdirSync(join(remoteWorkspace, ".iteam"), { recursive: true });
  mkdirSync(join(remoteWorkspace, "MEMORY.md"));
  const fallbackAgent = {
    ...workspaceAgent,
    id: "agent_workspace_fallback",
    workspacePath: remoteWorkspace
  };
  const localFallbackWorkspace = join(home, "fallback-home", "agents", fallbackAgent.id);
  const previousHome = process.env.ITEAM_HOME;
  process.env.ITEAM_HOME = join(home, "fallback-home");
  let fallbackWorkspace;
  try {
    fallbackWorkspace = prepareAgentWorkspace({
      agent: fallbackAgent,
      serverUrl: "http://127.0.0.1:4318",
      launchId: "launch_workspace_fallback",
      stateSuffix: "-pool-0"
    });
  } finally {
    if (previousHome === undefined) delete process.env.ITEAM_HOME;
    else process.env.ITEAM_HOME = previousHome;
  }
  if (
    fallbackWorkspace.workspaceDir !== localFallbackWorkspace ||
    fallbackWorkspace.runtimeCwd !== localFallbackWorkspace
  ) {
    throw new Error("unwritable remote workspace did not fall back to the local agent workspace");
  }
  const legacyMcpNames = legacyIteamMcpServerNames([
    {
      name: "iteam-chat-agent_workspace",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["/tmp/chat-bridge.mjs", "--agent-id", "agent_workspace"]
      }
    },
    {
      name: "iteam-chat-agent_unrelated",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["/tmp/not-chat.mjs"]
      }
    },
    {
      name: "filesystem",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["/tmp/chat-bridge.mjs"]
      }
    }
  ]);
  if (legacyMcpNames.join(",") !== "iteam-chat-agent_workspace") {
    throw new Error("legacy Traex MCP cleanup filter matched the wrong servers");
  }
  const detectedRuntimeMap = new Map(detectRuntimes().map(runtime => [runtime.id, runtime]));
  if (!detectedRuntimeMap.get("custom")?.installed) {
    throw new Error("configured runtime profile was not reported as installed");
  }
  if (!detectedRuntimeMap.get("fake_acp")?.installed) {
    throw new Error("configured ACP runtime with absolute command was not reported as installed");
  }
  const genericAcpProfile = resolveAcpRuntimeProfile("generic_acp");
  if (!genericAcpProfile || genericAcpProfile.command !== "generic_acp" || genericAcpProfile.args?.join(" ") !== "acp serve") {
    throw new Error("executable ACP runtime did not get a default ACP profile");
  }
  await verifyAcpDriverWithFakeRuntime(home, "fake_acp");
  await verifyAcpDriverWithFakeRuntime(home, "generic_acp");
  await verifyAcpDriverWithFakeRuntime(home, "fake_acp_cwd", profileCwd);
  await verifyOneShotProfileCwd(home, profileCwd);
  await verifyAcpDriverParallelism(home);
  await verifyAcpQueuedPromotion(home);
  verifySqliteSpacePersistence(home);
  const mysqlSpaceBackfillSql = MYSQL_SPACE_BACKFILL_QUERIES.join("\n");
  for (const table of ["iteam_channels", "iteam_deliveries", "iteam_messages", "iteam_tasks", "iteam_scheduled_tasks"]) {
    if (!mysqlSpaceBackfillSql.includes(`UPDATE ${table}`)) {
      throw new Error(`MySQL space migration is missing ${table}`);
    }
  }
  const mysqlSchemaSql = MYSQL_TABLES.map(table => table.ddl).join("\n");
  const mysqlStoreSource = readFileSync(resolve(root, "src/store/mysql-store.ts"), "utf8");
  if (
    !mysqlSchemaSql.includes("CREATE TABLE IF NOT EXISTS iteam_spaces") ||
    !mysqlStoreSource.includes("FROM iteam_spaces") ||
    !mysqlStoreSource.includes("INSERT INTO iteam_spaces") ||
    !mysqlStoreSource.includes("UNION ALL SELECT space_id FROM iteam_channels")
  ) {
    throw new Error("MySQL spaces load/write symmetry is incomplete");
  }
  const legacyChannelPlan = planMysqlChannelUniqueMigration([
    { INDEX_NAME: "PRIMARY", COLUMN_NAME: "id", SEQ_IN_INDEX: 1, NON_UNIQUE: 0 },
    { INDEX_NAME: "uniq_target", COLUMN_NAME: "target", SEQ_IN_INDEX: 1, NON_UNIQUE: 0 }
  ]);
  if (
    legacyChannelPlan.hasSpaceTarget ||
    legacyChannelPlan.legacyIndexNames.join(",") !== "uniq_target"
  ) {
    throw new Error("MySQL legacy channel unique index migration was not planned correctly");
  }
  const currentChannelPlan = planMysqlChannelUniqueMigration([
    { INDEX_NAME: "uniq_space_target", COLUMN_NAME: "target", SEQ_IN_INDEX: 2, NON_UNIQUE: 0 },
    { INDEX_NAME: "uniq_space_target", COLUMN_NAME: "space_id", SEQ_IN_INDEX: 1, NON_UNIQUE: 0 }
  ]);
  if (!currentChannelPlan.hasSpaceTarget || currentChannelPlan.legacyIndexNames.length) {
    throw new Error("MySQL current channel unique index was not recognized");
  }
  const subagentStarted = formatTaskRuntimeProgress({
    type: "tool_call",
    agentId: "agent_test",
    launchId: "launch_test",
    deliveryId: "delivery_test",
    target: "#all:msg_task",
    at: new Date().toISOString(),
    toolName: "subagent_spawnAgent",
    toolCallId: "call_test",
    arguments: { prompt: "Review quick_sort.py for correctness and edge cases." }
  });
  if (!subagentStarted?.includes("已启动 sub agent review")) {
    throw new Error("sub agent start should produce readable task progress");
  }
  const subagentCompleted = formatTaskRuntimeProgress({
    type: "tool_result",
    agentId: "agent_test",
    launchId: "launch_test",
    deliveryId: "delivery_test",
    target: "#all:msg_task",
    at: new Date().toISOString(),
    toolCallId: "call_test",
    ok: true,
    output: {
      tool: "wait",
      status: "completed",
      agentsStates: {
        reviewThread: { status: "completed", message: "Handle duplicate values without losing elements." }
      }
    }
  });
  if (!subagentCompleted?.includes("Handle duplicate values")) {
    throw new Error("sub agent result should include the review summary");
  }
  if (notificationBelongsToThread({ threadId: "subagent_thread" }, "parent_thread")) {
    throw new Error("sub agent notifications must not complete or pollute the parent task turn");
  }
  if (!notificationBelongsToThread({ threadId: "parent_thread" }, "parent_thread")) {
    throw new Error("parent task notifications should remain visible to the parent turn");
  }

  await waitForHealth(port);
  const renamedHuman = await patch(port, "/api/humans/human-local", { name: "Smoke Human" });
  if (renamedHuman.name !== "Smoke Human" || renamedHuman.handle !== "you") {
    throw new Error("local human rename did not preserve identity and handle");
  }
  const humans = await get(port, "/api/humans");
  if (!humans.some((human: any) => human.id === "human-local" && human.name === "Smoke Human")) {
    throw new Error("renamed local human was not persisted");
  }
  let computers = await get(port, "/api/computers");
  if (computers.length !== 0) throw new Error("state should not contain seeded computers");
  const invite = await post(port, "/api/computers/connect-command", { serverUrl: `http://127.0.0.1:${port}` });
  if (!invite.command.includes("daemon connect")) throw new Error("connect command was not generated");
  const cliDaemon = spawn(tsxBin, [
    resolve(root, "bin/iteam.ts"),
    "daemon",
    "connect",
    "--server-url",
    `http://127.0.0.1:${port}`,
    "--connect-token",
    "invalid-cli-forwarding-token",
    "--space-id",
    "space_default",
    "--runtime-cwd",
    home
  ], {
    env: { ...process.env, ITEAM_ACP_RUNTIMES: join(home, "missing-acp-runtimes.json") },
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const daemonStartup = await waitForChildOutput(
    cliDaemon,
    output => output.includes(`agent runtime working directory ${home}; expected space space_default`),
    4_000
  );
  if (!daemonStartup.includes(`agent runtime working directory ${home}; expected space space_default`)) {
    throw new Error("iteam CLI did not forward --runtime-cwd and --space-id to agent-daemon");
  }
  await waitForChildExit(cliDaemon, 4_000);
  if (cliDaemon.exitCode === null) {
    cliDaemon.kill("SIGKILL");
    throw new Error("agent-daemon CLI forwarding check did not exit after invalid token rejection");
  }
  const firstConnect = await post(port, "/api/computers/connect", {
    token: invite.token,
    name: "smoke-computer",
    fingerprint: { id: "SMOKE12345", hostname: "smoke-computer", os: "darwin", arch: "arm64" },
    daemonVersion: "0.1.0",
    runtimes: smokeRuntimes
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
    runtimes: smokeRuntimes
  });
  if (reAuth.connectToken !== connectToken) throw new Error("re-auth must return the same persistent token");
  if (reAuth.id !== computerId) throw new Error("re-auth must return the same computer id");
  const secondInvite = await post(port, "/api/computers/connect-command", {
    serverUrl: `http://127.0.0.1:${port}`
  });
  const secondComputer = await post(port, "/api/computers/connect", {
    token: secondInvite.token,
    name: "smoke-computer-two",
    fingerprint: { id: "SMOKE67890", hostname: "smoke-computer-two", os: "linux", arch: "x64" },
    daemonVersion: "0.1.0",
    runtimes: smokeRuntimes
  });
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
  const profileAgent = await post(port, "/api/agents", {
    name: "profile-agent",
    runtime: "custom",
    computerId: computerId
  });
  if (profileAgent.runtime !== "custom") throw new Error("configured runtime profile was not accepted by agent creation");
  const daemonOnlyAgent = await post(port, "/api/agents", {
    name: "daemon-only-agent",
    runtime: "daemon_only",
    computerId: computerId
  });
  if (daemonOnlyAgent.runtime !== "daemon_only") throw new Error("daemon-reported runtime was rejected by server allowlist");
  const typedRuntimeAgent = await post(port, "/api/agents", {
    name: "typed-runtime-agent",
    runtime: "typed_runtime",
    computerId: computerId
  });
  if (typedRuntimeAgent.runtime !== "typed_runtime") throw new Error("typed custom runtime was rejected during agent creation");
  const defaultRuntimeAgent = await post(port, "/api/agents", {
    name: "default-runtime-agent",
    computerId: computerId
  });
  if (defaultRuntimeAgent.runtime !== "fake_acp") throw new Error(`default runtime should prefer ACP, got ${defaultRuntimeAgent.runtime}`);
  const siblingAgent = await post(port, "/api/agents", {
    name: "sibling-agent",
    runtime: "codex",
    computerId: computerId
  });
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
    runtimes: smokeRuntimes
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
  const agentAuth = {
    "x-iteam-agent-connection": `${computerId}:${agent.id}:${deriveAgentAuthToken(connectToken, agent.id)}`
  };
  const siblingImpersonation = await postStatus(port, "/api/messages", {
    target: "#all",
    text: "sibling impersonation",
    authorId: siblingAgent.id
  }, agentAuth);
  if (siblingImpersonation !== 403) {
    throw new Error(`sibling agent impersonation should be 403, got ${siblingImpersonation}`);
  }
  const dmDelivery = heartbeat.deliveries.find((delivery: any) => delivery.messageId === dmMessage.id);
  if (!dmDelivery) throw new Error("DM delivery was not claimed by the computer heartbeat");
  await post(port, `/api/deliveries/${encodeURIComponent(dmDelivery.id)}/runtime-state`, {
    phase: "queued",
    queuePosition: 2,
    sessionKey: dm.target,
    processSlot: 1
  }, computerAuth);
  await post(port, `/api/deliveries/${encodeURIComponent(dmDelivery.id)}/runtime-state`, {
    phase: "running",
    sessionKey: dm.target,
    processSlot: 1
  }, computerAuth);
  const secondDmMessage = await post(port, "/api/messages", {
    target: dm.target,
    text: "second direct message",
    authorId: "human-local",
    defaultAgentId: agent.id
  });
  const secondHeartbeat = await post(port, "/api/computers/connect", {
    token: invite.token,
    name: "smoke-computer",
    fingerprint: { id: "SMOKE12345", hostname: "smoke-computer", os: "darwin", arch: "arm64" },
    daemonVersion: "0.1.0",
    runtimes: smokeRuntimes
  });
  const secondDmDelivery = secondHeartbeat.deliveries.find(
    (delivery: any) => delivery.messageId === secondDmMessage.id
  );
  const activeDmDelivery = secondDmDelivery?.activeDeliveries?.find(
    (delivery: any) => delivery.id === dmDelivery.id
  );
  if (
    !secondDmDelivery ||
    !activeDmDelivery ||
    activeDmDelivery.phase !== "running" ||
    activeDmDelivery.messageText !== "direct hello"
  ) {
    throw new Error("delivery payload did not include the other active delivery in the same chat");
  }
  const deliveriesWithRuntimeState = await get(port, "/api/deliveries");
  const persistedRuntimeState = deliveriesWithRuntimeState.find((delivery: any) => delivery.id === dmDelivery.id);
  const queuedLifecycle = persistedRuntimeState?.lifecycle?.find((item: any) => item.intent === "delivery.queued");
  const runningLifecycle = persistedRuntimeState?.lifecycle?.find((item: any) => item.intent === "delivery.running");
  if (
    !queuedLifecycle ||
    queuedLifecycle.details?.queuePosition !== 2 ||
    queuedLifecycle.details?.processSlot !== 1 ||
    !runningLifecycle ||
    runningLifecycle.details?.sessionKey !== dm.target
  ) {
    throw new Error("delivery queued/running lifecycle was not persisted for the UI");
  }
  const savedBotConfig = await post(port, "/api/external/bot-configs", {
    provider: "lark",
    alias: "Smoke Bot",
    appId: "cli_smoke",
    appSecret: "secret_smoke",
    enabled: true
  });
  if (savedBotConfig.appSecret !== "configured") throw new Error("bot config save should not echo raw app secret");
  if (savedBotConfig.alias !== "Smoke Bot") throw new Error("bot config alias was not saved");
  const botConfigs = await get(port, "/api/external/bot-configs");
  if (!botConfigs.some((config: any) => String(config.provider).startsWith("lark") && config.appId === "cli_smoke" && String(config.appSecret).includes("…"))) {
    throw new Error("saved bot config was not listed with a masked secret");
  }
  if (savedBotConfig.status !== "pending") throw new Error("valid saved bot config should wait for pairing");
  const invalidBotConfig = await post(port, "/api/external/bot-configs", {
    provider: "lark",
    appId: "not-a-real-app-id",
    appSecret: "bad_secret",
    enabled: true
  });
  if (invalidBotConfig.status !== "invalid") throw new Error("invalid Lark App ID should be saved with invalid status");
  await del(port, `/api/external/bot-configs/${encodeURIComponent(invalidBotConfig.provider)}`);
  const botConfigsAfterDelete = await get(port, "/api/external/bot-configs");
  if (botConfigsAfterDelete.some((config: any) => config.provider === invalidBotConfig.provider)) {
    throw new Error("deleted bot config was still listed");
  }
  const secondBotConfig = await post(port, "/api/external/bot-configs", {
    provider: "lark",
    appId: "cli_smoke_two",
    appSecret: "secret_smoke_two",
    enabled: true
  });
  if (secondBotConfig.provider === savedBotConfig.provider) throw new Error("second Lark bot config overwrote the first config");
  const botConfigsAfterSecond = await get(port, "/api/external/bot-configs");
  if (botConfigsAfterSecond.filter((config: any) => String(config.provider).startsWith("lark")).length < 2) {
    throw new Error("multiple Lark bot configs were not persisted");
  }
  await post(port, "/api/external/bot-configs", {
    provider: savedBotConfig.provider,
    appId: "cli_smoke_three",
    appSecret: "secret_smoke_three",
    enabled: true
  });
  const botConfigsAfterStaleProviderCreate = await get(port, "/api/external/bot-configs");
  if (!botConfigsAfterStaleProviderCreate.some((config: any) => config.provider === savedBotConfig.provider && config.appId === "cli_smoke")) {
    throw new Error("stale selected provider should not overwrite the original Lark bot config");
  }
  if (!botConfigsAfterStaleProviderCreate.some((config: any) => config.appId === "cli_smoke_three")) {
    throw new Error("stale selected provider with a new App ID should create a separate Lark bot config");
  }
  const cliConfig = await execFileText(tsxBin, [
    resolve(root, "bin/iteam.ts"),
    "bot",
    "lark",
    "config",
    "--app-id",
    "cli_from_smoke",
    "--app-secret",
    "cli_secret"
  ], { ITEAM_URL: `http://127.0.0.1:${port}` });
  if (cliConfig.includes("cli_secret")) throw new Error("bot CLI config echoed raw app secret");
  const cliList = await execFileText(tsxBin, [
    resolve(root, "bin/iteam.ts"),
    "bot",
    "lark",
    "list"
  ], { ITEAM_URL: `http://127.0.0.1:${port}` });
  if (!cliList.includes("cli_from_smoke") || cliList.includes("cli_secret")) {
    throw new Error("bot CLI list did not show masked config");
  }
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
    const crossComputerSse = await fetch(
      `http://127.0.0.1:${port}/api/computers/${encodeURIComponent(secondComputer.id)}/stream`,
      { headers: { "x-iteam-connection": `${computerId}:${connectToken}` } }
    );
    if (crossComputerSse.status !== 403) {
      throw new Error(`SSE credentials for another computer should be 403, got ${crossComputerSse.status}`);
    }
    await crossComputerSse.body?.cancel();
    const larkExplicitSend = post(port, "/api/external/routed-messages", {
      provider: "lark",
      tenantKey: "tenant-smoke",
      chatId: "chat-smoke",
      externalMessageId: "lark-msg-explicit",
      target: "#all",
      text: `@${agent.handle} explicit lark route`
    });
    const larkExplicitDelivery = await sse.waitFor("delivery", 2_000);
    const larkExplicitMessage = await larkExplicitSend;
    if (!larkExplicitMessage.ok || larkExplicitDelivery?.messageId !== larkExplicitMessage.message.id) {
      throw new Error("explicit Lark routed message did not push a delivery");
    }
    if (larkExplicitDelivery.target !== "#all" || larkExplicitDelivery.source !== "lark") {
      throw new Error("explicit Lark routed delivery did not keep #all/source");
    }
    const larkDefaultSend = post(port, "/api/external/routed-messages", {
      provider: "lark",
      tenantKey: "tenant-smoke",
      chatId: "chat-smoke",
      externalMessageId: "lark-msg-default-agent",
      target: "#all",
      text: "default agent lark route"
    });
    const larkDefaultDelivery = await sse.waitFor("delivery", 2_000);
    const larkDefaultMessage = await larkDefaultSend;
    if (!larkDefaultMessage.ok || larkDefaultDelivery?.messageId !== larkDefaultMessage.message.id) {
      throw new Error("Lark /all message without explicit agent did not use channel default/fallback agent");
    }
    if (larkDefaultDelivery.agentId !== agent.id || larkDefaultDelivery.target !== "#all") {
      throw new Error("Lark /all fallback delivery should target the first running #all agent");
    }
    const larkDmSend = post(port, "/api/external/routed-messages", {
      provider: "lark",
      tenantKey: "tenant-smoke",
      chatId: "chat-smoke-dm",
      externalMessageId: "lark-msg-dm",
      text: `@${agent.handle} no default should be dm`
    });
    const larkDmDelivery = await sse.waitFor("delivery", 2_000);
    const larkDmMessage = await larkDmSend;
    if (!larkDmMessage.ok || larkDmDelivery?.messageId !== larkDmMessage.message.id) {
      throw new Error("Lark single-agent message without channel/default did not push a DM delivery");
    }
    if (larkDmDelivery.target !== `dm:${agent.id}` || !String(larkDmDelivery.sessionKey || "").includes(`dm:${agent.id}`)) {
      throw new Error("Lark no-channel single-agent message should route to agent DM");
    }
    const larkBinding = await post(port, "/api/external/bot-bindings", {
      provider: "lark",
      tenantKey: "tenant-smoke",
      chatId: "chat-bound",
      defaultTarget: "#all"
    });
    if (larkBinding.defaultTarget !== "#all") throw new Error("Lark bind did not persist default channel");
    const larkBoundSend = post(port, "/api/external/routed-messages", {
      provider: "lark",
      tenantKey: "tenant-smoke",
      chatId: "chat-bound",
      externalMessageId: "lark-msg-bound",
      text: `@${agent.handle} bound channel route`
    });
    const larkBoundDelivery = await sse.waitFor("delivery", 2_000);
    const larkBoundMessage = await larkBoundSend;
    if (!larkBoundMessage.ok || larkBoundDelivery?.messageId !== larkBoundMessage.message.id || larkBoundDelivery.target !== "#all") {
      throw new Error("Lark bound chat did not route no-selector message to default #all");
    }
    await post(port, `/api/deliveries/${encodeURIComponent(larkBoundDelivery.id)}/result`,
      { ok: true, text: "lark bound reply" }, computerAuth);
    const larkLinks = await get(port, "/api/external/message-links");
    if (!larkLinks.some((link: any) => link.direction === "out" && link.rootMessageId === larkBoundMessage.message.id)) {
      throw new Error("Lark inbound root did not create an outbound reply link");
    }
    const larkTaskSend = post(port, "/api/external/routed-messages", {
      provider: "lark",
      tenantKey: "tenant-smoke",
      chatId: "chat-bound",
      externalMessageId: "lark-msg-task",
      target: "#all",
      text: `@${agent.handle} lark task title`,
      asTask: true
    });
    const larkTaskDelivery = await sse.waitFor("delivery", 2_000);
    const larkTaskMessage = await larkTaskSend;
    if (!larkTaskMessage.ok || !larkTaskMessage.task || larkTaskMessage.message?.type !== "task") {
      throw new Error("Lark task route did not create a task root message");
    }
    if (larkTaskMessage.task.assigneeId !== agent.id || larkTaskDelivery?.messageId !== larkTaskMessage.message.id) {
      throw new Error("Lark task route did not assign and deliver to the mentioned agent");
    }
    const larkTaskThreadReply = await post(port, "/api/messages", {
      target: larkTaskMessage.task.threadTarget,
      text: "intermediate task update",
      authorId: agent.id
    }, agentAuth);
    const larkTaskLinks = await get(port, "/api/external/message-links");
    if (!larkTaskLinks.some((link: any) => link.direction === "out" && link.messageId === larkTaskThreadReply.id && link.rootMessageId === larkTaskMessage.message.id)) {
      throw new Error("agent task thread update was not linked back to the Lark root");
    }
    const larkBackfill = await post(port, "/api/external/message-links/backfill", {
      rootMessageId: larkTaskMessage.message.id
    });
    if (!larkBackfill.ok || larkBackfill.rootMessageId !== larkTaskMessage.message.id) {
      throw new Error("Lark external link backfill endpoint failed");
    }
    const ingressPairing = await post(port, "/api/ingress/pairing-codes", {
      target: dm.target,
      agentId: agent.id,
      label: "smoke ingress",
      contextRules: { project: ["alpha"] }
    });
    if (!ingressPairing.pairCode || !String(ingressPairing.connectUrl || "").startsWith("iteam://ingress/pair")) {
      throw new Error("ingress pairing code did not return a connect URL");
    }
    const ingressPolicy = await post(port, "/api/ingress/pair", {
      pairCode: ingressPairing.pairCode,
      source: "smoke-webhook"
    });
    if (!ingressPolicy.id || !ingressPolicy.token) throw new Error("ingress pairing did not create a policy token");
    const badIngressStatus = await postStatus(port, "/api/ingress/messages", {
      policyId: ingressPolicy.id,
      token: ingressPolicy.token,
      text: "wrong project",
      context: { project: "beta" }
    });
    if (badIngressStatus !== 403) throw new Error(`ingress context rules should reject beta, got ${badIngressStatus}`);
    const ingressSend = post(port, "/api/ingress/messages", {
      text: "external hello",
      context: { project: "alpha" },
      sessionKey: "smoke-external-session"
    }, { "x-iteam-ingress": `${ingressPolicy.id}:${ingressPolicy.token}` });
    const ingressDelivery = await sse.waitFor("delivery", 2_000);
    const ingressMessage = await ingressSend;
    if (!ingressDelivery || ingressDelivery.messageId !== ingressMessage.id) {
      throw new Error("ingress message did not push a delivery");
    }
    if (ingressDelivery.sessionKey !== "smoke-external-session" || ingressDelivery.source !== "external") {
      throw new Error("ingress delivery did not carry explicit session/source");
    }
    if (!ingressDelivery.lifecycle?.some((item: any) => item.intent === "delivery.dispatch")) {
      throw new Error("ingress delivery did not include dispatch lifecycle");
    }
    await post(port, `/api/deliveries/${encodeURIComponent(ingressDelivery.id)}/help-needed`, {
      text: "Need webhook approval",
      reason: "approval_required"
    }, computerAuth);
    const helpedDelivery = (await get(port, "/api/deliveries")).find((item: any) => item.id === ingressDelivery.id);
    if (
      helpedDelivery?.status !== "help_needed" ||
      !helpedDelivery.lifecycle?.some((item: any) => item.intent === "delivery.help_needed")
    ) {
      throw new Error("delivery help-needed lifecycle was not persisted");
    }
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
    }, agentAuth);
    if (String(directAgentSchedule.text || "").includes("iteam_schedule")) {
      throw new Error("direct agent message should strip schedule directive");
    }
    if (directAgentSchedule.type !== "agent") {
      throw new Error("messages authored by agents should default to agent type");
    }
    const directSchedules = await get(port, "/api/scheduled-tasks");
    if (!directSchedules.some((item: any) => item.agentId === agent.id && item.intervalMs === 120_000 && item.prompt === "direct agent schedule")) {
      throw new Error("direct agent message with schedule directive did not create a scheduled task");
    }
    await post(port, "/api/messages", {
      target: dm.target,
      authorId: agent.id,
      text: '工作日定时。<iteam_schedule>{"create":true,"cronExpression":"0 9-19 * * 1-5","timezone":"Asia/Shanghai","prompt":"weekday cron report"}</iteam_schedule>'
    }, agentAuth);
    const cronSchedules = await get(port, "/api/scheduled-tasks");
    const cronSchedule = cronSchedules.find((item: any) =>
      item.agentId === agent.id &&
      item.cronExpression === "0 9-19 * * 1-5" &&
      item.timezone === "Asia/Shanghai" &&
      item.intervalMs === null
    );
    if (!cronSchedule) throw new Error("cron schedule directive did not create a cron task");
    const invalidCronStatus = await postStatus(port, "/api/scheduled-tasks", {
      target: dm.target,
      agentId: agent.id,
      prompt: "invalid cron",
      cronExpression: "0 0 9-19 * * 1-5",
      timezone: "Asia/Shanghai"
    });
    if (invalidCronStatus !== 400) throw new Error(`six-field cron should be rejected, got ${invalidCronStatus}`);
    const ambiguousScheduleStatus = await postStatus(port, "/api/scheduled-tasks", {
      target: dm.target,
      agentId: agent.id,
      prompt: "ambiguous schedule",
      intervalMs: 60_000,
      cronExpression: "0 9-19 * * 1-5",
      timezone: "Asia/Shanghai"
    });
    if (ambiguousScheduleStatus !== 400) {
      throw new Error(`interval plus cron should be rejected, got ${ambiguousScheduleStatus}`);
    }
    await patch(port, `/api/scheduled-tasks/${encodeURIComponent(cronSchedule.id)}`, {
      nextRunAt: new Date(Date.now() - 1000).toISOString()
    });
    const cronDelivery = await sse.waitFor("delivery", 4_000);
    if (!cronDelivery || cronDelivery.agentId !== agent.id) {
      throw new Error("due cron task did not push a delivery");
    }
    const ranCronSchedules = await get(port, "/api/scheduled-tasks");
    const ranCronSchedule = ranCronSchedules.find((item: any) => item.id === cronSchedule.id);
    if (
      !ranCronSchedule ||
      ranCronSchedule.runCount !== 1 ||
      Date.parse(ranCronSchedule.nextRunAt) <= Date.now()
    ) {
      throw new Error("cron task did not calculate its next run after delivery");
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
    runtimes: smokeRuntimes
  });
  const taskDelivery = taskHeartbeat.deliveries.find(
    (delivery: any) => delivery.target === task.threadTarget && delivery.messageId === task.messageId
  );
  if (!taskDelivery) {
    throw new Error("assigned task was not delivered to its thread");
  }
  const noAuthProgress = await postStatus(
    port,
    `/api/deliveries/${encodeURIComponent(taskDelivery.id)}/progress`,
    { text: "Progress: still working (1s elapsed).", elapsedMs: 1000 }
  );
  if (noAuthProgress !== 401) throw new Error(`delivery progress without auth should be 401, got ${noAuthProgress}`);
  await post(port, `/api/deliveries/${encodeURIComponent(taskDelivery.id)}/progress`, {
    text: "Progress: still working (1s elapsed).",
    elapsedMs: 1000
  }, computerAuth);
  await post(port, `/api/deliveries/${encodeURIComponent(taskDelivery.id)}/progress`, {
    text: "Progress: still working (2s elapsed).",
    elapsedMs: 2000
  }, computerAuth);
  const taskProgressMessages = await get(
    port,
    `/api/messages?target=${encodeURIComponent(task.threadTarget)}&limit=50`
  );
  if (taskProgressMessages.filter((message: any) =>
    message.authorId === agent.id && message.text.startsWith("Progress: still working")
  ).length !== 2) {
    throw new Error("task progress updates were not written to the task thread as the agent");
  }
  const tasksAfterProgress = await get(port, "/api/tasks");
  if (!tasksAfterProgress.some((item: any) => item.id === task.id && item.status === "in_progress")) {
    throw new Error("first task progress update should move the task to in_progress");
  }
  const reply = await post(port, "/api/messages", {
    target: task.threadTarget,
    text: "thread reply",
    authorId: "human-local"
  });
  if (reply.threadId !== task.messageId) throw new Error("thread reply did not keep root thread id");
  const messagesAfterReply = await get(port, `/api/messages/channel/${encodeURIComponent(allChannel.id)}?limit=50`);
  const taskRootAfterReply = messagesAfterReply.find((message: any) => message.id === task.messageId);
  if (taskRootAfterReply?.replyCount !== 3) throw new Error("channel messages should include task progress and thread reply counts");
  await post(port, `/api/deliveries/${encodeURIComponent(taskDelivery.id)}/result`,
    { ok: true, text: "task smoke complete" }, computerAuth);
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
  const cancelMention = await post(port, "/api/messages", {
    target: threadChannel.target,
    text: `@${agent.handle} cancellable`,
    authorId: "human-local"
  });
  const cancelDelivery = (await get(port, "/api/deliveries"))
    .find((d: any) => d.messageId === cancelMention.id && d.agentId === agent.id);
  if (!cancelDelivery) throw new Error("cancellable mention did not create delivery");
  const cancelled = await post(port, `/api/deliveries/${encodeURIComponent(cancelDelivery.id)}/cancel`, {
    reason: "smoke cancel"
  });
  if (
    cancelled.status !== "cancelled" ||
    !cancelled.lifecycle?.some((item: any) => item.intent === "delivery.cancel")
  ) {
    throw new Error("delivery cancel lifecycle was not persisted");
  }
  const afterCancelResult = await post(port, `/api/deliveries/${encodeURIComponent(cancelDelivery.id)}/result`,
    { ok: true, text: "late cancelled result" }, computerAuth);
  if (afterCancelResult.status !== "cancelled") {
    throw new Error("late delivery result should not overwrite cancelled status");
  }

  await verifySpaceIsolation(port, {
    computerId,
    connectToken,
    agentId: agent.id,
    agentAuthToken: deriveAgentAuthToken(connectToken, agent.id)
  });

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

async function waitForChildOutput(
  child: ReturnType<typeof spawn>,
  predicate: (output: string) => boolean,
  timeoutMs: number
): Promise<string> {
  let output = "";
  const append = (chunk: Buffer | string) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(output)) return output;
    if (child.exitCode !== null) {
      throw new Error(`child exited before expected output (${child.exitCode}): ${output}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for child output: ${output}`);
}

async function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>(resolvePromise => child.once("exit", () => resolvePromise())),
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, timeoutMs))
  ]);
}

async function verifySpaceIsolation(
  port: number,
  auth: { computerId: string; connectToken: string; agentId: string; agentAuthToken: string }
): Promise<void> {
  const before = await get(port, "/api/spaces");
  if (!Array.isArray(before) || !before.some((space: any) => space.id === "space_default")) {
    throw new Error("default space is missing from GET /api/spaces");
  }
  const alpha = await post(port, "/api/spaces", { name: "Space Alpha" });
  if (!alpha.id || alpha.slug !== "space-alpha") throw new Error("space alpha was not created");
  const beta = await post(port, "/api/spaces", { name: "Space Beta" });
  if (!beta.id || beta.slug !== "space-beta") throw new Error("space beta was not created");

  // Legacy SQL schemas still enforce UNIQUE(target). Use distinct targets per
  // space until the schema migrates to (space_id, target) uniqueness.
  const alphaChannel = await post(port, "/api/channels", { name: "sales-alpha", spaceId: alpha.id });
  const betaChannel = await post(port, "/api/channels", { name: "sales-beta", spaceId: beta.id });
  if (alphaChannel.spaceId !== alpha.id || betaChannel.spaceId !== beta.id) {
    throw new Error("channel spaceId not persisted");
  }

  const alphaAllChannels = await getWithSpace(port, "/api/channels", alpha.id);
  const betaAllChannels = await getWithSpace(port, "/api/channels", beta.id);
  if (alphaAllChannels.some((channel: any) => channel.id === betaChannel.id)) {
    throw new Error("beta channel leaked into alpha listing");
  }
  if (betaAllChannels.some((channel: any) => channel.id === alphaChannel.id)) {
    throw new Error("alpha channel leaked into beta listing");
  }

  const alphaMessage = await post(port, "/api/messages", {
    spaceId: alpha.id,
    target: alphaChannel.target,
    text: "hello from alpha",
    authorId: "human-local"
  });
  if (alphaMessage.spaceId !== alpha.id) throw new Error("message spaceId not stamped");
  const betaMessages = await getWithSpace(port, `/api/messages?target=${encodeURIComponent(alphaChannel.target)}&limit=50`, beta.id);
  if (betaMessages.some((message: any) => message.id === alphaMessage.id)) {
    throw new Error("alpha message leaked into beta space");
  }

  const alphaState = await getWithSpace(port, "/api/state", alpha.id);
  if (!alphaState.channels.some((channel: any) => channel.id === alphaChannel.id)) {
    throw new Error("alpha /api/state missing alpha channel");
  }
  if (alphaState.channels.some((channel: any) => channel.spaceId === beta.id)) {
    throw new Error("alpha /api/state leaked beta channels");
  }
  if (!Array.isArray(alphaState.spaces) || alphaState.spaces.length < 3) {
    throw new Error("alpha /api/state must include the global spaces list");
  }

  const badChannel = await postStatus(port, "/api/channels", { name: "junk", spaceId: "space_missing" });
  if (badChannel < 400) throw new Error("unknown spaceId must reject with 4xx");

  const computerAuth = { "x-iteam-connection": `${auth.computerId}:${auth.connectToken}` };
  const crossSpaceRead = await fetch(`http://127.0.0.1:${port}/api/channels`, {
    headers: { ...computerAuth, "x-iteam-space": alpha.id }
  });
  if (crossSpaceRead.status !== 403) {
    throw new Error(`authenticated computer cross-space read should be 403, got ${crossSpaceRead.status}`);
  }
  const crossSpaceChannelCreate = await postStatus(port, "/api/channels", {
    name: "forbidden-cross-space-channel",
    spaceId: alpha.id
  }, computerAuth);
  if (crossSpaceChannelCreate !== 403) {
    throw new Error(`cross-space channel create should be 403, got ${crossSpaceChannelCreate}`);
  }
  const crossSpaceDelete = await deleteStatus(
    port,
    `/api/spaces/${encodeURIComponent(alpha.id)}`,
    computerAuth
  );
  if (crossSpaceDelete !== 403) {
    throw new Error(`cross-space space delete should be 403, got ${crossSpaceDelete}`);
  }
  const unauthenticatedAgentPost = await postStatus(port, "/api/messages", {
    target: "#all",
    text: "spoofed agent post",
    authorId: auth.agentId
  });
  if (unauthenticatedAgentPost !== 401) {
    throw new Error(`agent-authored message without computer auth should be 401, got ${unauthenticatedAgentPost}`);
  }
  const crossSpaceAgentPost = await postStatus(port, "/api/messages", {
    spaceId: alpha.id,
    target: alphaChannel.target,
    text: "cross-space agent post",
    authorId: auth.agentId
  }, {
    "x-iteam-agent-connection": `${auth.computerId}:${auth.agentId}:${auth.agentAuthToken}`
  });
  if (crossSpaceAgentPost !== 403) {
    throw new Error(`authenticated agent cross-space post should be 403, got ${crossSpaceAgentPost}`);
  }
  const alphaInvite = await post(port, "/api/computers/connect-command", {
    spaceId: alpha.id,
    serverUrl: `http://127.0.0.1:${port}`
  });
  const alphaComputer = await post(port, "/api/computers/connect", {
    token: alphaInvite.token,
    name: "alpha-computer",
    fingerprint: { id: "ALPHA12345", hostname: "alpha-computer", os: "linux", arch: "x64" },
    daemonVersion: "0.1.0",
    runtimes: smokeRuntimes
  });
  const alphaAgent = await post(port, "/api/agents", {
    spaceId: alpha.id,
    name: "alpha-agent",
    runtime: "codex",
    computerId: alphaComputer.id
  });
  const alphaMention = await post(port, "/api/messages", {
    spaceId: alpha.id,
    target: alphaChannel.target,
    text: `@${alphaAgent.handle} alpha delivery`,
    authorId: "human-local"
  });
  const alphaDelivery = (await getWithSpace(port, "/api/deliveries", alpha.id))
    .find((delivery: any) => delivery.messageId === alphaMention.id);
  if (!alphaDelivery) throw new Error("alpha mention did not create a delivery");
  const crossSpaceChannelPatch = await patchStatus(
    port,
    `/api/channels/${encodeURIComponent(alphaChannel.id)}`,
    { description: "forbidden" },
    computerAuth
  );
  if (crossSpaceChannelPatch !== 403) {
    throw new Error(`cross-space channel patch should be 403, got ${crossSpaceChannelPatch}`);
  }
  const crossSpaceAgentStop = await postStatus(
    port,
    `/api/agents/${encodeURIComponent(alphaAgent.id)}/stop`,
    {},
    computerAuth
  );
  if (crossSpaceAgentStop !== 403) {
    throw new Error(`cross-space agent stop should be 403, got ${crossSpaceAgentStop}`);
  }
  const crossSpaceDeliveryCancel = await postStatus(
    port,
    `/api/deliveries/${encodeURIComponent(alphaDelivery.id)}/cancel`,
    { reason: "forbidden" },
    computerAuth
  );
  if (crossSpaceDeliveryCancel !== 403) {
    throw new Error(`cross-space delivery cancel should be 403, got ${crossSpaceDeliveryCancel}`);
  }
}

async function getWithSpace(port: number, path: string, spaceId: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "X-Iteam-Space": spaceId }
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function verifyAcpDriverWithFakeRuntime(
  home: string,
  runtime = "fake_acp",
  expectedCwd?: string
): Promise<void> {
  const agent: Agent = {
    id: `agent_${runtime}`,
    spaceId: "space_default",
    name: "Fake ACP",
    handle: "fake-acp",
    description: "",
    runtime,
    model: null,
    computerId: "computer_test",
    status: "online",
    desiredStatus: "running",
    launchId: null,
    pid: null,
    workspacePath: join(home, "fake-acp-agent"),
    createdAt: "",
    updatedAt: ""
  };
  const driver = new AcpDriver(runtime, {
    serverUrl: "http://127.0.0.1:0",
    launchId: `launch_${runtime}`
  });
  const events: any[] = [];
  driver.on(event => events.push(event));

  const deliveryA = fakeDelivery("delivery_fake_a", "session-alpha", "#all:msg_fake", agent);
  const first = await driver.deliver(agent, deliveryA, "first");
  const second = await driver.deliver(agent, fakeDelivery("delivery_fake_b", "session-alpha", "#elsewhere", agent), "second");
  const third = await driver.deliver(agent, fakeDelivery("delivery_fake_c", "session-beta", "#all:msg_fake", agent), "third");

  const firstSession = extractReplySession(first.text);
  const secondSession = extractReplySession(second.text);
  const thirdSession = extractReplySession(third.text);
  const firstRunning = events.find(event =>
    event.type === "delivery_running" && event.deliveryId === deliveryA.id
  );
  const secondRunning = events.find(event =>
    event.type === "delivery_running" && event.deliveryId === "delivery_fake_b"
  );
  const thirdRunning = events.find(event =>
    event.type === "delivery_running" && event.deliveryId === "delivery_fake_c"
  );
  if (!firstSession || firstSession !== secondSession) {
    throw new Error("AcpDriver did not reuse the same ACP session for the same sessionKey");
  }
  if (first.text.includes("preamble:")) {
    throw new Error("AcpDriver final response included process commentary emitted before a tool call");
  }
  const resolvedExpectedCwd = expectedCwd || agent.workspacePath;
  const expectedProfileRuntimeCwd = expectedCwd ? resolvedExpectedCwd : "";
  const expectedProfileArgCwd = expectedCwd ? resolvedExpectedCwd : "";
  if (!first.text.includes(
    `:${resolvedExpectedCwd}:${resolvedExpectedCwd}:${resolvedExpectedCwd}:${expectedProfileRuntimeCwd}:${expectedProfileArgCwd}:first`
  )) {
    throw new Error(`AcpDriver cwd/env did not match the effective runtime cwd: ${first.text}`);
  }
  if (!firstRunning || !secondRunning || firstRunning.processSlot !== secondRunning.processSlot) {
    throw new Error("AcpDriver did not preserve process affinity for the same sessionKey");
  }
  if (
    !thirdSession ||
    !thirdRunning ||
    (thirdSession === firstSession && thirdRunning.processSlot === firstRunning.processSlot)
  ) {
    throw new Error("AcpDriver did not create a distinct ACP session for a distinct sessionKey");
  }

  const correlated = events.filter(event => event.deliveryId === deliveryA.id);
  if (!correlated.some(event => event.type === "message_chunk" && event.text.includes("reply:"))) {
    throw new Error("fake ACP message chunks were not normalized with delivery correlation");
  }
  if (!correlated.some(event => event.type === "thinking" && event.text.includes("thinking:"))) {
    throw new Error("fake ACP thought chunks were not normalized");
  }
  if (!correlated.some(event => event.type === "tool_call" && event.toolName === "shell")) {
    throw new Error("fake ACP tool calls were not normalized");
  }
  if (!correlated.some(event => event.type === "tool_result" && event.ok === true)) {
    throw new Error("fake ACP tool results were not normalized");
  }
  if (!correlated.some(event => event.type === "plan" && event.items?.[0]?.content?.includes("first"))) {
    throw new Error("fake ACP plan updates were not normalized");
  }

  const cancelDelivery = fakeDelivery("delivery_fake_cancel", "session-cancel", "#all:msg_cancel", agent);
  const pending = driver.deliver(agent, cancelDelivery, "wait-for-cancel");
  await waitForEvent(events, event =>
    event.type === "message_chunk" && event.deliveryId === cancelDelivery.id,
    2_000
  );
  await driver.cancelDelivery(cancelDelivery.id);
  const cancelResult = await pending.then(
    () => "resolved",
    error => String((error as Error).message)
  );
  if (!cancelResult.includes("cancelled")) {
    throw new Error(`AcpDriver active cancellation should reject cancelled delivery, got ${cancelResult}`);
  }
  await driver.stop(agent);
}

async function verifyOneShotProfileCwd(home: string, expectedCwd: string): Promise<void> {
  const agent: Agent = {
    id: "agent_custom_cwd",
    spaceId: "space_default",
    name: "Custom cwd",
    handle: "custom-cwd",
    description: "",
    runtime: "custom_cwd",
    model: null,
    computerId: "computer_test",
    status: "online",
    desiredStatus: "running",
    launchId: null,
    pid: null,
    workspacePath: join(home, "custom-cwd-agent"),
    createdAt: "",
    updatedAt: ""
  };
  const driver = new (await import("../src/runtime/oneshot-driver.js")).OneshotDriver("custom_cwd", {
    serverUrl: "http://127.0.0.1:0",
    launchId: "launch_custom_cwd"
  });
  const result = await driver.deliver(
    agent,
    fakeDelivery("delivery_custom_cwd", "custom-cwd", "#custom-cwd", agent),
    "check cwd"
  );
  const observed = JSON.parse(result.text) as { cwd: string; pwd: string; runtimeCwd: string };
  if (
    observed.cwd !== expectedCwd ||
    observed.pwd !== expectedCwd ||
    observed.runtimeCwd !== expectedCwd
  ) {
    throw new Error(`one-shot profile cwd/env mismatch: ${result.text}`);
  }
}

async function verifyAcpDriverParallelism(home: string): Promise<void> {
  const runtime = "fake_acp_parallel";
  const agent: Agent = {
    id: "agent_fake_acp_parallel",
    spaceId: "space_default",
    name: "Fake ACP Parallel",
    handle: "fake-acp-parallel",
    description: "",
    runtime,
    model: null,
    computerId: "computer_test",
    status: "online",
    desiredStatus: "running",
    launchId: null,
    pid: null,
    workspacePath: join(home, "fake-acp-parallel-agent"),
    createdAt: "",
    updatedAt: ""
  };
  const driver = new AcpDriver(runtime, {
    serverUrl: "http://127.0.0.1:0",
    launchId: "launch_fake_acp_parallel"
  });
  const events: any[] = [];
  driver.on(event => events.push(event));

  const channelFirst = fakeDelivery("delivery_parallel_channel_1", "channel-root:#parallel:msg_root_1", "#parallel", agent);
  const channelSecond = fakeDelivery("delivery_parallel_channel_2", "channel-root:#parallel:msg_root_2", "#parallel", agent);
  const startedAt = Date.now();
  const channelFirstPromise = driver.deliver(agent, channelFirst, "delay:350 channel-first");
  await waitForEvent(events, event =>
    event.type === "delivery_running" && event.deliveryId === channelFirst.id,
    2_000
  );
  const channelSecondResult = await driver.deliver(agent, channelSecond, "delay:40 channel-second");
  const channelSecondElapsedMs = Date.now() - startedAt;
  if (channelSecondElapsedMs >= 300) {
    throw new Error(`independent channel roots should run in parallel; second root took ${channelSecondElapsedMs}ms`);
  }
  await channelFirstPromise;

  const runningEvents = events.filter(event => event.type === "delivery_running");
  const channelFirstRunning = runningEvents.find(event => event.deliveryId === channelFirst.id);
  const channelSecondRunning = runningEvents.find(event => event.deliveryId === channelSecond.id);
  if (!channelFirstRunning || !channelSecondRunning) {
    throw new Error("parallel ACP deliveries did not emit running lifecycle events");
  }
  if (channelFirstRunning.processSlot === channelSecondRunning.processSlot) {
    throw new Error("independent channel roots were not spread across ACP process slots");
  }
  if (!channelSecondResult.text.includes("channel-second")) {
    throw new Error("parallel channel root did not complete with the expected response");
  }

  const channelThird = fakeDelivery(
    "delivery_parallel_channel_3",
    "channel-root:#parallel:msg_root_3",
    "#parallel",
    agent
  );
  const channelFourth = fakeDelivery(
    "delivery_parallel_channel_4",
    "channel-root:#parallel:msg_root_4",
    "#parallel",
    agent
  );
  const channelFifth = fakeDelivery(
    "delivery_parallel_channel_5",
    "channel-root:#parallel:msg_root_5",
    "#parallel",
    agent
  );
  const firstAgain = driver.deliver(agent, channelFourth, "delay:250 first-again");
  const secondAgain = driver.deliver(agent, channelFifth, "delay:250 second-again");
  await waitForEvent(events, event =>
    event.type === "delivery_running" && event.deliveryId === channelFourth.id,
    2_000
  );
  await waitForEvent(events, event =>
    event.type === "delivery_running" && event.deliveryId === channelFifth.id,
    2_000
  );
  const thirdResult = await driver.deliver(agent, channelThird, "delay:20 channel-third");
  const thirdRunning = events.find(event =>
    event.type === "delivery_running" && event.deliveryId === channelThird.id
  );
  if (
    !thirdRunning ||
    thirdRunning.processSlot < 2 ||
    !thirdResult.text.includes("channel-third")
  ) {
    throw new Error("ACP pool did not grow on demand for a third concurrent channel root");
  }
  await firstAgain;
  await secondAgain;

  const threadKey = "#parallel:msg_thread_root";
  const threadFirst = fakeDelivery("delivery_parallel_thread_1", threadKey, threadKey, agent);
  const threadSecond = fakeDelivery("delivery_parallel_thread_2", threadKey, threadKey, agent);
  const threadFirstPromise = driver.deliver(agent, threadFirst, "delay:150 thread-first");
  await waitForEvent(events, event =>
    event.type === "delivery_running" && event.deliveryId === threadFirst.id,
    2_000
  );
  const threadSecondPromise = driver.deliver(agent, threadSecond, "thread-second");
  await waitForEvent(events, event =>
    event.type === "delivery_queued" && event.deliveryId === threadSecond.id,
    2_000
  );
  const queuedThreadSecond = events.find(event =>
    event.type === "delivery_queued" && event.deliveryId === threadSecond.id
  );
  if (!queuedThreadSecond || queuedThreadSecond.queuePosition < 1) {
    throw new Error("same-thread follow-up did not report a queue position");
  }
  await threadFirstPromise;
  await threadSecondPromise;
  const threadFirstRunning = events.find(event =>
    event.type === "delivery_running" && event.deliveryId === threadFirst.id
  );
  const threadSecondRunning = events.find(event =>
    event.type === "delivery_running" && event.deliveryId === threadSecond.id
  );
  if (
    !threadFirstRunning ||
    !threadSecondRunning ||
    events.indexOf(threadSecondRunning) <= events.indexOf(threadFirstRunning)
  ) {
    throw new Error("same-thread deliveries did not preserve FIFO ordering");
  }
  await driver.stop(agent);
}

async function verifyAcpQueuedPromotion(home: string): Promise<void> {
  const runtime = "fake_acp_queue";
  const agent: Agent = {
    id: "agent_fake_acp_queue",
    spaceId: "space_default",
    name: "Fake ACP Queue",
    handle: "fake-acp-queue",
    description: "",
    runtime,
    model: null,
    computerId: "computer_test",
    status: "online",
    desiredStatus: "running",
    launchId: null,
    pid: null,
    workspacePath: join(home, "fake-acp-queue-agent"),
    createdAt: "",
    updatedAt: ""
  };
  const driver = new AcpDriver(runtime, {
    serverUrl: "http://127.0.0.1:0",
    launchId: "launch_fake_acp_queue"
  });
  const events: any[] = [];
  driver.on(event => events.push(event));
  const first = fakeDelivery("delivery_queue_1", "channel-root:#queue:msg_1", "#queue", agent);
  const second = fakeDelivery("delivery_queue_2", "channel-root:#queue:msg_2", "#queue", agent);
  const third = fakeDelivery("delivery_queue_3", "channel-root:#queue:msg_3", "#queue", agent);
  const firstPromise = driver.deliver(agent, first, "delay:180 first");
  const secondPromise = driver.deliver(agent, second, "delay:320 second");
  await waitForEvent(events, event =>
    event.type === "delivery_running" && event.deliveryId === second.id,
    2_000
  );
  const thirdPromise = driver.deliver(agent, third, "third");
  await waitForEvent(events, event =>
    event.type === "delivery_queued" && event.deliveryId === third.id,
    2_000
  );
  const queued = events.find(event =>
    event.type === "delivery_queued" && event.deliveryId === third.id
  );
  if (!queued || queued.queuePosition < 1) {
    throw new Error("third delivery should be queued when the two-worker pool is full");
  }
  await firstPromise;
  await waitForEvent(events, event =>
    event.type === "delivery_running" && event.deliveryId === third.id,
    2_000
  );
  await thirdPromise;
  await secondPromise;
  await driver.stop(agent);
}

function verifySqliteSpacePersistence(home: string): void {
  const sqliteHome = join(home, "sqlite-space-persistence");
  const sqliteFile = join(sqliteHome, "state.db");
  mkdirSync(sqliteHome, { recursive: true });
  const spaceId = "space_persisted";
  const computerId = "computer_persisted";
  const inviteId = "computer_invite_persisted";
  const agentId = "agent_persisted";
  const channelId = "channel_persisted";
  const messageId = "msg_persisted";
  const channelMessageId = "msg_persisted_channel";
  const legacyAgentMessageId = "msg_persisted_legacy_agent";
  const deliveryId = "delivery_persisted";
  const taskId = "task_persisted";
  const scheduleId = "schedule_persisted";
  const now = new Date().toISOString();
  const first = new SqliteStore(sqliteHome, sqliteFile);
  first.mutate(state => {
    state.spaces.push({
      id: spaceId,
      name: "Persisted",
      slug: "persisted",
      description: "",
      createdAt: now,
      updatedAt: now
    });
    state.pendingComputerConnections.push({
      id: inviteId,
      spaceId,
      token: "connect_persisted",
      status: "connected",
      createdAt: now,
      connectedComputerId: computerId,
      label: "Persisted computer",
      connectedAt: now
    });
    state.computers.push({
      id: computerId,
      spaceId,
      name: "persisted-computer",
      fingerprint: { id: "PERSISTED", hostname: "persisted-computer", os: "linux", arch: "x64" },
      status: "online",
      daemonVersion: "test",
      runtimes: [],
      agentIds: [agentId],
      connectionId: inviteId,
      connectToken: "connect_persisted",
      createdAt: now,
      firstConnectedAt: now,
      lastSeenAt: now
    });
    state.agents.push({
      id: agentId,
      spaceId,
      name: "persisted-agent",
      handle: "persisted-agent",
      description: "",
      runtime: "fake_acp",
      model: null,
      computerId,
      status: "online",
      desiredStatus: "running",
      launchId: null,
      pid: null,
      workspacePath: join(sqliteHome, "agents", agentId),
      createdAt: now,
      updatedAt: now
    });
    state.channels.push({
      id: channelId,
      spaceId: "space_default",
      name: "persisted",
      target: "#persisted",
      kind: "channel",
      description: "",
      memberIds: ["human-local", agentId],
      defaultAgentId: agentId,
      createdAt: now
    });
    state.messages.push({
      id: messageId,
      spaceId: "space_default",
      target: "#persisted",
      authorId: "human-local",
      type: "human",
      text: "persisted message",
      mentions: [],
      createdAt: now,
      threadId: null
    });
    state.messages.push({
      id: channelMessageId,
      spaceId: "space_default",
      target: "#persisted",
      authorId: "human-local",
      type: "human",
      text: "legacy human channel message",
      mentions: [],
      createdAt: now,
      threadId: null
    });
    state.messages.push({
      id: legacyAgentMessageId,
      spaceId: "space_default",
      target: "#persisted",
      authorId: agentId,
      type: "human",
      text: "legacy agent message",
      mentions: [],
      createdAt: now,
      threadId: null
    });
    state.deliveries.push({
      id: deliveryId,
      spaceId: "space_default",
      messageId,
      rootMessageId: messageId,
      parentDeliveryId: null,
      depth: 0,
      agentId,
      computerId,
      target: "#persisted",
      sessionKey: "persisted-session",
      source: "message",
      status: "done",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      lifecycle: []
    });
    state.tasks.push({
      id: taskId,
      spaceId: "space_default",
      number: 1,
      target: "#persisted",
      title: "Persisted task",
      description: "",
      status: "done",
      assigneeId: agentId,
      createdBy: "human-local",
      messageId,
      threadTarget: `#persisted:${messageId}`,
      createdAt: now,
      updatedAt: now
    });
    state.scheduledTasks.push({
      id: scheduleId,
      spaceId: "space_default",
      target: "#persisted",
      agentId,
      prompt: "persisted prompt",
      sessionKey: "persisted-schedule",
      intervalMs: 60_000,
      status: "active",
      nextRunAt: now,
      runCount: 0,
      createdBy: "human-local",
      createdAt: now,
      updatedAt: now
    });
  });
  first.close();

  const reopened = new SqliteStore(sqliteHome, sqliteFile);
  const state = reopened.snapshot();
  if (state.computers.find(item => item.id === computerId)?.spaceId !== spaceId) {
    throw new Error("SQLite computer spaceId was lost after reopen");
  }
  if (state.agents.find(item => item.id === agentId)?.spaceId !== spaceId) {
    throw new Error("SQLite agent spaceId was lost after reopen");
  }
  if (state.pendingComputerConnections.find(item => item.id === inviteId)?.spaceId !== spaceId) {
    throw new Error("SQLite invite spaceId was lost after reopen");
  }
  if (state.channels.find(item => item.id === channelId)?.spaceId !== spaceId) {
    throw new Error("SQLite channel spaceId was not backfilled from its agent membership");
  }
  if (state.messages.find(item => item.id === messageId)?.spaceId !== spaceId) {
    throw new Error("SQLite message spaceId was lost after reopen");
  }
  if (state.messages.find(item => item.id === channelMessageId)?.spaceId !== spaceId) {
    throw new Error("SQLite human message spaceId was not backfilled from its unique channel");
  }
  const legacyAgentMessage = state.messages.find(item => item.id === legacyAgentMessageId);
  if (legacyAgentMessage?.spaceId !== spaceId || legacyAgentMessage.type !== "agent") {
    throw new Error("SQLite legacy agent-authored message was not reclassified during space migration");
  }
  if (state.deliveries.find(item => item.id === deliveryId)?.spaceId !== spaceId) {
    throw new Error("SQLite delivery spaceId was lost after reopen");
  }
  if (state.tasks.find(item => item.id === taskId)?.spaceId !== spaceId) {
    throw new Error("SQLite task spaceId was lost after reopen");
  }
  if (state.scheduledTasks.find(item => item.id === scheduleId)?.spaceId !== spaceId) {
    throw new Error("SQLite scheduled task spaceId was lost after reopen");
  }
  reopened.close();

  const stable = new SqliteStore(sqliteHome, sqliteFile);
  stable.mutate(current => {
    current.channels.push({
      id: "channel_default_mixed",
      spaceId: "space_default",
      name: "default-mixed",
      target: "#default-mixed",
      kind: "channel",
      description: "",
      memberIds: ["human-local", agentId],
      defaultAgentId: null,
      createdAt: now
    });
    current.messages.push({
      id: "msg_default_mixed",
      spaceId: "space_default",
      target: "#default-mixed",
      authorId: "human-local",
      type: "human",
      text: "legitimate default-space message",
      mentions: [],
      createdAt: now,
      threadId: null
    });
  });
  stable.close();

  const stableReopened = new SqliteStore(sqliteHome, sqliteFile);
  const stableState = stableReopened.snapshot();
  if (
    stableState.channels.find(item => item.id === "channel_default_mixed")?.spaceId !== "space_default" ||
    stableState.messages.find(item => item.id === "msg_default_mixed")?.spaceId !== "space_default"
  ) {
    throw new Error("versioned SQLite space migration rewrote valid default-space data");
  }
  stableReopened.close();
}

function fakeDelivery(id: string, sessionKey: string | null, target: string, agent: any): any {
  return {
    id,
    target,
    messageId: `${id}_msg`,
    rootMessageId: `${id}_msg`,
    parentDeliveryId: null,
    depth: 0,
    agentId: agent.id,
    computerId: agent.computerId,
    sessionKey,
    status: "delivering",
    attempts: 0,
    createdAt: "",
    updatedAt: "",
    agent,
    message: {
      id: `${id}_msg`,
      target,
      authorId: "human-local",
      type: "human",
      text: id,
      mentions: [],
      createdAt: "",
      threadId: null
    }
  };
}

function extractReplySession(text: string): string | null {
  return text.match(/reply:(session-\d+):/)?.[1] || null;
}

async function waitForEvent(events: any[], predicate: (event: any) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for fake ACP event");
}

async function get(port: number, path: string): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.json();
}

async function execFileText(command: string, args: string[], env: Record<string, string>): Promise<string> {
  const result = await execFileAsync(command, args, {
    env: { ...process.env, ...env },
    cwd: root
  });
  return `${result.stdout}${result.stderr}`;
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

async function patchStatus(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  await response.text();
  return response.status;
}

async function del(port: number, path: string): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`${response.status} ${path}: ${await response.text()}`);
  return response.json();
}

async function deleteStatus(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "DELETE",
    headers
  });
  await response.text();
  return response.status;
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
