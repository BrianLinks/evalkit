import { buildPairPrompt, buildPrompt, parsePairVerdict, parseVerdict } from "./prompt.js";
import type { Completer, ProviderJudge } from "./types.js";

/** Turn a raw text completer into a judge that can both score and compare. */
export function fromCompleter(completer: Completer): ProviderJudge {
  return {
    id: completer.id,
    async judge(request) {
      const { system, user } = buildPrompt(request);
      return parseVerdict(await completer.complete(system, user), request.rubric);
    },
    async compare(request) {
      const { system, user } = buildPairPrompt(request);
      return parsePairVerdict(await completer.complete(system, user));
    },
  };
}
