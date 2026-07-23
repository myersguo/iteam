import { homedir, hostname, platform, arch } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Fingerprint } from "./types.js";

export const DAEMON_VERSION = "0.1.45";

export function defaultHome(): string {
  return process.env.ITEAM_HOME || join(homedir(), ".iteam");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function deriveAgentAuthToken(connectToken: string, agentId: string): string {
  return createHmac("sha256", connectToken)
    .update(`iteam-agent:${agentId}`)
    .digest("hex");
}

export function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function localComputerFingerprint(): Fingerprint {
  const raw = `${hostname()}|${platform()}|${arch()}|${homedir()}`;
  return {
    id: createHash("sha256").update(raw).digest("hex").slice(0, 10).toUpperCase(),
    hostname: hostname(),
    os: platform(),
    arch: arch()
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function parseJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer | string) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({} as T);
      try {
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}
