import { ConfigError } from "../errors.js";
import { anthropicJudge } from "./anthropic.js";
import { DEFAULT_HTTP, type HttpOptions } from "./http.js";
import { mockJudge } from "./mock.js";
import { openaiJudge } from "./openai.js";
import type { Judge } from "./types.js";

export interface JudgeFactoryOptions {
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  http?: Partial<HttpOptions>;
}

/** Build a judge from a spec like `anthropic:<model>`, `openai:<model>` or `mock:<name>`. Fails fast on a missing key. */
export function createJudge(spec: string, options: JudgeFactoryOptions): Judge {
  const colon = spec.indexOf(":");
  if (colon <= 0 || colon === spec.length - 1) {
    throw new ConfigError(`invalid judge "${spec}", expected provider:model (for example mock:a)`);
  }
  const provider = spec.slice(0, colon);
  const model = spec.slice(colon + 1);
  const http: HttpOptions = { ...DEFAULT_HTTP, ...options.http, fetch: options.fetch ?? options.http?.fetch ?? DEFAULT_HTTP.fetch };

  const requireKey = (name: string): string => {
    const key = options.env[name];
    if (!key) throw new ConfigError(`${name} is not set (needed for judge "${spec}")`);
    return key;
  };

  switch (provider) {
    case "mock":
      return mockJudge(model);
    case "anthropic":
      return anthropicJudge(model, requireKey("ANTHROPIC_API_KEY"), http);
    case "openai":
      return openaiJudge(model, requireKey("OPENAI_API_KEY"), http);
    default:
      throw new ConfigError(`unknown judge provider "${provider}" (use anthropic, openai or mock)`);
  }
}

export type { Judge, JudgeRequest, Verdict } from "./types.js";
