import { z } from "zod";
import { DatasetError } from "../errors.js";
import { parseJsonLines } from "../dataset.js";
import type { Rubric } from "../rubric/schema.js";

export const PairSampleSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  responseA: z.string(),
  responseB: z.string(),
  /** Optional human preference per criterion id. They join the run as a rater named "human". */
  human: z.record(z.string(), z.enum(["A", "B", "tie"])).optional(),
});

export type PairSample = z.infer<typeof PairSampleSchema>;

export function parsePairDataset(text: string): PairSample[] {
  return parseJsonLines(text, PairSampleSchema, "pair");
}

export function validatePairs(pairs: readonly PairSample[], rubric: Rubric): void {
  const known = new Set(rubric.criteria.map((c) => c.id));
  for (const pair of pairs) {
    for (const criterionId of Object.keys(pair.human ?? {})) {
      if (!known.has(criterionId)) throw new DatasetError(`pair "${pair.id}": human names unknown criterion "${criterionId}"`);
    }
  }
}
