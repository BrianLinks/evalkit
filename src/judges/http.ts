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
 * Safe description of why fetch threw: the error name and, if present, the system error code
 * (ENOTFOUND, ECONNRESET, ...). Never the error message, because some runtimes put the rejected
 * header value, which is the API key, into the message of an "invalid header" TypeError.
 */
function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return "unknown";
  const cause = e.cause as { code?: unknown } | undefined;
  const code = typeof cause?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(cause.code) ? cause.code : undefined;
  return code ? `${e.name}, ${code}` : e.name;
}

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
      last = new HttpError(`request failed before a response arrived (${describeFetchError(e)})`);
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
