// Thin authenticated HTTP client used by every CLI command. Wraps the shared
// requestJson helper and injects the resolved Authorization + X-Iteam-Space
// headers so command modules never re-plumb auth or space scoping.

import { requestJson, type RequestJsonOptions } from "@iteam/shared";
import type { ResolvedContext } from "./config.js";

export class ApiClient {
  constructor(private readonly ctx: ResolvedContext) {}

  get serverUrl(): string {
    return this.ctx.serverUrl;
  }

  get spaceId(): string | undefined {
    return this.ctx.spaceId;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.ctx.token) headers["Authorization"] = `Bearer ${this.ctx.token}`;
    if (this.ctx.spaceId) headers["X-Iteam-Space"] = this.ctx.spaceId;
    return headers;
  }

  request<T = any>(path: string, options: RequestJsonOptions = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.ctx.serverUrl}${path}`;
    return requestJson<T>(url, { ...options, headers: this.headers(options.headers) });
  }

  get<T = any>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T = any>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body });
  }

  patch<T = any>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body });
  }

  delete<T = any>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }
}
