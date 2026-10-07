import type { ProviderJudge } from "./types.js";

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Offline judge for demos and tests. Its scores and verdicts are a hash of the inputs, so they are
 * repeatable but carry no signal about quality. Never use it to evaluate anything real.
 */
export function mockJudge(name: string): ProviderJudge {
  return {
    id: `mock:${name}`,
    async judge({ rubric, criterion, sample }) {
      const { min, max } = rubric.scale;
      const score = min + (fnv1a(`${name}|${sample.id}|${criterion.id}`) % (max - min + 1));
      return { score, rationale: "deterministic mock score" };
    },
    async compare({ criterion, prompt, first, second }) {
      const pick = fnv1a(`${name}|${criterion.id}|${prompt}|${first}|${second}`) % 3;
      return { winner: pick === 0 ? "first" : pick === 1 ? "second" : "tie", rationale: "deterministic mock verdict" };
    },
  };
}
