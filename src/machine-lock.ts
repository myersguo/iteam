// Single-instance machine lock — prevents two iteam daemons from racing on the
// same store/port. Modeled after zouk-daemon's machineLock.ts: the lock file
// records the pid + serverUrl/port; if the recorded process is still alive the
// new daemon refuses to start, otherwise it reclaims a stale lock.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export interface AcquireOptions {
  lockPath: string;
  port: number;
}

export interface AcquiredLock {
  release(): Promise<void>;
}

export class LockHeldError extends Error {
  constructor(public readonly info: LockInfo, lockPath: string) {
    super(`iteam daemon already running (pid ${info.pid}, port ${info.port}). Lock: ${lockPath}`);
    this.name = "LockHeldError";
  }
}

export async function acquireLock(options: AcquireOptions): Promise<AcquiredLock> {
  await mkdir(dirname(options.lockPath), { recursive: true });

  const existing = await readLock(options.lockPath);
  if (existing && isProcessAlive(existing.pid)) {
    throw new LockHeldError(existing, options.lockPath);
  }

  const info: LockInfo = {
    pid: process.pid,
    port: options.port,
    startedAt: new Date().toISOString()
  };

  // Write to a temporary file first, then atomically rename to prevent lock corruption/race conditions
  const tempPath = `${options.lockPath}.tmp.${process.pid}`;
  await writeFile(tempPath, JSON.stringify(info, null, 2), "utf8");
  try {
    const { rename } = await import("node:fs/promises");
    await rename(tempPath, options.lockPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw error;
  }

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const current = await readLock(options.lockPath);
    if (current?.pid === process.pid) {
      try {
        unlinkSync(options.lockPath);
      } catch {
        // best effort
      }
    }
  };

  // Best-effort cleanup if the process exits without explicit shutdown.
  process.once("exit", () => {
    try {
      const current = JSON.parse(readFileSync(options.lockPath, "utf8"));
      if (current?.pid === process.pid) unlinkSync(options.lockPath);
    } catch {
      // lock already removed or unreadable — nothing to do
    }
  });

  return { release };
}

async function readLock(path: string): Promise<LockInfo | null> {
  try {
    const data = await readFile(path, "utf8");
    return JSON.parse(data) as LockInfo;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    // Signal 0 doesn't deliver a signal; it just probes for existence/permission.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
