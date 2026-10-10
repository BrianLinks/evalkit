import type { VerdictCache } from "../cache.js";
import { ConfigError } from "../errors.js";
import { anthropicCompleter } from "./anthropic.js";
import { DEFAULT_HTTP, type HttpOptions } from "./http.js";
import { mockJudge } from "./mock.js";
import { fromCompleter } from "./llm.js";
import { openaiCompleter } from "./openai.js";
import type { ProviderJudge } from "./types.js";

export interface JudgeFactoryOptions {
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  http?: Partial<HttpOptions>;
  /** Reuse earlier replies for identical requests. Applies to the real providers, not to mock judges. */
  cache?: VerdictCache;
}

/** Build a judge from a spec like `anthropic:<model>`, `openai:<model>` or `mock:<name>`. Fails fast on a missing key. */
export function createJudge(spec: string, options: JudgeFactoryOptions): ProviderJudge {
  const colon = spec.indexOf(":");
  if (colon <= 0 || colon === spec.length - 1) {
    throw new ConfigError(`invalid judge "${spec}", expected provider:model (for example mock:a)`);
  }
  const provider = spec.slice(0, colon);
  const model = spec.slice(colon + 1);
  const http: HttpOptions = { ...DEFAULT_HTTP, ...options.http, fetch: options.fetch ?? options.http?.fetch ?? DEFAULT_HTTP.fetch };

  const requireKey = (name: string): string => {
    const key = options.env[name]?.trim();
    if (!key) throw new ConfigError(`${name} is not set (needed for judge "${spec}")`);
    // A key with a space, quote-free but odd character, or non-ASCII text makes fetch throw before sending anything.
    if (!/^[\x21-\x7e]+$/.test(key)) {
      throw new ConfigError(`${name} contains spaces or characters that cannot be sent in an HTTP header; paste the key again with nothing else`);
    }
    return key;
  };

  switch (provider) {
    case "mock":
      return mockJudge(model);
    case "anthropic":
      return fromCompleter(anthropicCompleter(model, requireKey("ANTHROPIC_API_KEY"), http), options.cache);
    case "openai":
      return fromCompleter(openaiCompleter(model, requireKey("OPENAI_API_KEY"), http), options.cache);
    default:
      throw new ConfigError(`unknown judge provider "${provider}" (use anthropic, openai or mock)`);
  }
}

export type { Judge, JudgeRequest, PairJudge, PairRequest, PairVerdict, ProviderJudge, Verdict } from "./types.js";
