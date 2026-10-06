import type { Judge } from "./types.js";

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Offline judge for demos and tests. Its scores are a hash of (name, sample, criterion), so they are
 * repeatable but carry no signal about quality. Never use it to evaluate anything real.
 */
export function mockJudge(name: string): Judge {
  return {
    id: `mock:${name}`,
    async judge({ rubric, criterion, sample }) {
      const { min, max } = rubric.scale;
      const score = min + (fnv1a(`${name}|${sample.id}|${criterion.id}`) % (max - min + 1));
      return { score, rationale: "deterministic mock score" };
    },
  };
}
