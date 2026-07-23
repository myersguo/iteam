#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { requestJson } from "@iteam/shared";
import { defaultHome, localComputerFingerprint } from "@iteam/shared";
import { runCli, isCliArea, cliUsage } from "../src/cli/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// In source: bin/iteam.ts -> ../  (project root, src/server.ts ts-loadable via tsx).
// In published bundle: dist/cli/iteam.mjs -> ./  (sibling server.mjs etc.).
const root = resolve(here, "..");
const baseUrl = process.env.ITEAM_URL || "http://127.0.0.1:4318";
const [area, action, ...rest] = process.argv.slice(2);

function usage(): void {
  console.log(`iTeam local multi-agent workspace

Lifecycle:
  iteam server start [--host 0.0.0.0] [--port 4318]
  iteam server status
  iteam daemon connect --server-url <url> --connect-token <token> [--space-id <id>] [--runtime-cwd <path>] [--name computer-name]
  iteam web   # prints the daemon URL (the daemon already serves the bundle); runs vite dev only in a source checkout

${cliUsage()}

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
    const host = readFlag("--host", process.env.ITEAM_HOST || "0.0.0.0");
    const entry = resolveEntry("server");
    const child = spawn(
      entry.argv[0],
      [...entry.argv.slice(1), "--port", String(port), "--host", String(host)],
      { stdio: "inherit", env: process.env }
    );
    child.on("exit", code => process.exit(code ?? 0));
    return;
  }

  if (area === "agent-daemon" || (area === "daemon" && action === "connect")) {
    const isConnect = area === "agent-daemon" ? action === "connect" || action === undefined : true;
    if (!isConnect) {
      throw new Error("only `iteam daemon connect` is supported");
    }
    const serverUrl = readFlag("--server-url", process.env.ITEAM_SERVER_URL);
    const connectToken = readFlag("--connect-token", process.env.ITEAM_CONNECT_TOKEN);
    if (!serverUrl || !connectToken) throw new Error("--server-url and --connect-token are required");
    const entry = resolveEntry("agent-daemon");
    const daemonArgs = [
      ...entry.argv.slice(1),
      "--server-url", String(serverUrl),
      "--connect-token", String(connectToken),
      "--name", String(readFlag("--name", localComputerFingerprint().hostname))
    ];
    const spaceId = readFlag("--space-id", process.env.ITEAM_SPACE_ID);
    if (spaceId && spaceId !== true) daemonArgs.push("--space-id", String(spaceId));
    const runtimeCwd = readFlag("--runtime-cwd", process.env.ITEAM_RUNTIME_CWD);
    if (runtimeCwd && runtimeCwd !== true) daemonArgs.push("--runtime-cwd", String(runtimeCwd));
    const child = spawn(entry.argv[0], daemonArgs, {
      stdio: "inherit",
      env: process.env
    });
    child.on("exit", code => process.exit(code ?? 0));
    return;
  }

  if (area === "web") {
    // In a checkout (dev mode), vite is available — keep the HMR workflow.
    // In a published global install, vite isn't bundled; the daemon already
    // serves the prebuilt bundle on its own port, so just print the URL.
    const viteBin = resolve(root, "node_modules/.bin/vite");
    if (existsSync(viteBin)) {
      const child = spawn(viteBin, ["--host", process.env.ITEAM_HOST || "127.0.0.1"], {
        cwd: root,
        stdio: "inherit",
        env: process.env
      });
      child.on("exit", code => process.exit(code ?? 0));
      return;
    }
    console.log(`iTeam web is served by the daemon. Start it with:`);
    console.log(`  iteam server start`);
    console.log(`Then open ${baseUrl}/ in your browser.`);
    console.log(`(Override with ITEAM_URL or pass --host 0.0.0.0 to expose externally.)`);
    return;
  }

  if ((area === "server" || area === "daemon") && action === "status") {
    const health = await requestJson(`${baseUrl}/api/health`);
    console.log(JSON.stringify(health, null, 2));
    return;
  }

  // Everything else (auth/space/agent/computer/channel/bot/message/task/config)
  // is handled by the API-facing CLI dispatcher. These commands do one-shot
  // HTTP work; Node's global fetch (undici) keeps the connection pool alive, so
  // the event loop won't drain on its own — exit explicitly once output has
  // flushed. Long-running commands like `message watch` never return here.
  if (isCliArea(area)) {
    await runCli(area, action, rest);
    await flushStdoutAndExit(Number(process.exitCode ?? 0) || 0);
    return;
  }

  usage();
}

/**
 * Flush any buffered stdout (writes to a pipe are async) and then exit. Needed
 * because undici's keep-alive sockets otherwise hold the process open after a
 * one-shot API command completes.
 */
function flushStdoutAndExit(code: number): Promise<never> {
  return new Promise<never>(() => {
    const done = (): void => process.exit(code);
    if (process.stdout.writableLength === 0) {
      done();
    } else {
      process.stdout.write("", done);
    }
  });
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
