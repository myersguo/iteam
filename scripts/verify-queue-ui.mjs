#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:4318/ntt-env/channel/examples";
const screenshotPath = process.argv[3] || "/tmp/iteam-queue-ui-cdp.png";
const port = 19000 + Math.floor(Math.random() * 1000);
const profile = join(tmpdir(), `iteam-ui-verify-${process.pid}`);
mkdirSync(profile, { recursive: true });

const chrome = spawn("google-chrome", [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-component-update",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--window-size=1440,1000",
  "about:blank"
], { stdio: ["ignore", "ignore", "ignore"] });

try {
  const page = await waitForPage(port);
  const client = await connectCdp(page.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Page.navigate", { url });

  let text = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await delay(250);
    const result = await client.send("Runtime.evaluate", {
      expression: "document.body.innerText",
      returnByValue: true
    });
    text = String(result?.result?.value || "");
    if (text.includes("Agent activity")) break;
  }
  if (!text.includes("Agent activity")) {
    throw new Error(`queue UI did not render; body starts with: ${text.slice(0, 240)}`);
  }
  if (!text.includes("running") && !text.includes("queued")) {
    throw new Error(`queue UI rendered without running/queued state: ${text.slice(0, 500)}`);
  }

  await client.send("Runtime.evaluate", {
    expression: "const pane=document.querySelector('.chat-pane'); if (pane) pane.scrollTop=0; window.scrollTo(0, 0)"
  });
  await delay(250);
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({
    ok: true,
    url,
    screenshotPath,
    statusText: text.split("\n").filter(line =>
      /Agent activity|running|queued|dispatching|oldest/.test(line)
    ).slice(0, 8)
  }));
  client.close();
} finally {
  chrome.kill("SIGTERM");
  await waitForExit(chrome, 1500);
  if (chrome.exitCode === null) {
    chrome.kill("SIGKILL");
    await waitForExit(chrome, 1500);
  }
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
}

async function waitForPage(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const pages = await response.json();
      const page = pages.find(item => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    }
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    delay(timeoutMs)
  ]);
}
