// Minimal JSON-RPC 2.0 client over a line-delimited stdio transport.
//
// Used by AcpDriver to talk to long-lived ACP servers (`traecli acp serve`,
// `codex app-server --listen stdio://`). The client multiplexes requests by id,
// surfaces server-initiated requests/notifications via callbacks, and writes
// each frame as a single newline-terminated JSON document — what the existing
// ACP servers we target accept today.

import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcStdioClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, PendingCall>();
  private buffer = "";
  private onRequest: RequestHandler;
  private onNotification: NotificationHandler;
  private closed = false;
  private stderrBuffer = "";

  constructor(
    child: ChildProcessWithoutNullStreams,
    handlers: { onRequest: RequestHandler; onNotification: NotificationHandler }
  ) {
    this.child = child;
    this.onRequest = handlers.onRequest;
    this.onNotification = handlers.onNotification;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 8192) this.stderrBuffer = this.stderrBuffer.slice(-8192);
    });
    child.on("exit", () => {
      this.closed = true;
      const err = new Error("acp transport closed");
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
    });
  }

  /** Last buffered chunk of the agent's stderr — useful for surfacing init errors. */
  recentStderr(): string {
    return this.stderrBuffer;
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) throw new Error("acp transport closed");
    const id = this.nextId++;
    const frame: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject
      });
      this.write(frame);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const frame: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.write(frame);
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Drop non-JSON lines (some agents print banners on stdout).
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    if ("method" in message && "id" in message && message.id !== undefined && message.id !== null) {
      // Server-initiated request — answer asynchronously.
      const id = message.id;
      Promise.resolve()
        .then(() => this.onRequest(message.method, message.params))
        .then(result => {
          const success: JsonRpcSuccess = { jsonrpc: "2.0", id, result };
          this.write(success);
        })
        .catch((error: Error) => {
          const err: JsonRpcError = {
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: error.message }
          };
          this.write(err);
        });
      return;
    }
    if ("method" in message) {
      try {
        this.onNotification(message.method, message.params);
      } catch {
        // Notifications must never throw across the IO boundary.
      }
      return;
    }
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ("error" in message) {
        pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  stop(): void {
    if (this.closed) return;
    try {
      this.child.stdin.end();
    } catch {
      // Best effort — process may already be gone.
    }
  }
}
