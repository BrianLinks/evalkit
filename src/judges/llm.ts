import { cacheKey, type VerdictCache } from "../cache.js";
import { buildPairPrompt, buildPrompt, parsePairVerdict, parseVerdict } from "./prompt.js";
import type { Completer, ProviderJudge } from "./types.js";

/**
 * Turn a raw text completer into a judge that can both score and compare.
 * With a cache, a reply is stored only after it parsed successfully, so a malformed reply is
 * never kept and a retry really asks the model again. Cache trouble never fails an evaluation.
 */
export function fromCompleter(completer: Completer, cache?: VerdictCache): ProviderJudge {
  const lookup = async (key: string): Promise<string | undefined> => {
    try {
      return await cache?.get(key);
    } catch {
      return undefined;
    }
  };
  const remember = async (key: string, text: string): Promise<void> => {
    try {
      await cache?.set(key, text);
    } catch {
      // A cache that cannot be written is only a missed saving.
    }
  };

  return {
    id: completer.id,
    async judge(request) {
      const { system, user } = buildPrompt(request);
      const key = cacheKey(completer.id, "score", system, user);
      const cached = await lookup(key);
      if (cached !== undefined) {
        try {
          return parseVerdict(cached, request.rubric);
        } catch {
          // Unusable entry: fall through to a live call, which will replace it.
        }
      }
      const text = await completer.complete(system, user);
      const verdict = parseVerdict(text, request.rubric);
      await remember(key, text);
      return verdict;
    },
    async compare(request) {
      const { system, user } = buildPairPrompt(request);
      const key = cacheKey(completer.id, "compare", system, user);
      const cached = await lookup(key);
      if (cached !== undefined) {
        try {
          return parsePairVerdict(cached);
        } catch {
          // Unusable entry: fall through to a live call.
        }
      }
      const text = await completer.complete(system, user);
      const verdict = parsePairVerdict(text);
      await remember(key, text);
      return verdict;
    },
  };
}
