export interface RequestJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * When true, return the parsed JSON body on a non-2xx response instead of
   * throwing. Used for endpoints like `/api/me` where a 401 still carries a
   * meaningful payload (auth mode + provider list).
   */
  allowErrorBody?: boolean;
}

export async function requestJson<T = any>(url: string, options: RequestJsonOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method || "GET",
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(url, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (options.allowErrorBody && data !== null) return data as T;
    throw new Error((data as { error?: string } | null)?.error || `${response.status} ${response.statusText}`);
  }
  return data as T;
}
