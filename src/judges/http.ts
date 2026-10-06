import { HttpError } from "../errors.js";

export interface HttpOptions {
  retries: number;
  baseDelayMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  fetch: typeof fetch;
}

export const DEFAULT_HTTP: HttpOptions = {
  retries: 3,
  baseDelayMs: 500,
  timeoutMs: 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetch: globalThis.fetch,
};

/**
 * POST JSON and return the parsed body. Retries network errors, 429 and 5xx with exponential backoff.
 * Other 4xx responses fail immediately. Error messages never include request headers, so API keys stay out of logs.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: HttpOptions,
): Promise<unknown> {
  let last: HttpError = new HttpError("request failed");
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (attempt > 0) await options.sleep(options.baseDelayMs * 2 ** (attempt - 1));

    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (e) {
      last = new HttpError(`network error (${e instanceof Error ? e.name : "unknown"})`);
      continue;
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new HttpError("response body is not valid JSON", response.status);
      }
    }

    const detail = (await response.text().catch(() => "")).slice(0, 200);
    last = new HttpError(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    if (response.status !== 429 && response.status < 500) throw last;
  }
  throw last;
}
