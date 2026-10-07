import { readFile } from "node:fs/promises";
import { z } from "zod";
import { DatasetError, EvalKitError, formatZodIssues } from "./errors.js";
import type { Rubric } from "./rubric/schema.js";

export const SampleSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  response: z.string(),
  reference: z.string().optional(),
  /** Optional human scores keyed by criterion id. They join the run as a rater named "human". */
  humanScores: z.record(z.string(), z.number().int()).optional(),
});

export type Sample = z.infer<typeof SampleSchema>;

/** Parse JSON Lines where every object has a unique string `id`. Blank lines are skipped. */
export function parseJsonLines<T extends { id: string }>(text: string, schema: z.ZodType<T>, noun: string): T[] {
  const items: T[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `line ${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new DatasetError(`${where}: invalid JSON`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new DatasetError(`${where}: ${formatZodIssues(parsed.error)}`);
    if (seen.has(parsed.data.id)) throw new DatasetError(`${where}: duplicate ${noun} id "${parsed.data.id}"`);
    seen.add(parsed.data.id);
    items.push(parsed.data);
  });
  if (items.length === 0) throw new DatasetError(`dataset has no ${noun}s`);
  return items;
}

/** Parse JSON Lines: one sample object per line. */
export function parseDataset(text: string): Sample[] {
  return parseJsonLines(text, SampleSchema, "sample");
}

/** Check that human scores only name real criteria and stay inside the rubric scale. */
export function validateAgainstRubric(samples: readonly Sample[], rubric: Rubric): void {
  const known = new Set(rubric.criteria.map((c) => c.id));
  const { min, max } = rubric.scale;
  for (const sample of samples) {
    for (const [criterionId, score] of Object.entries(sample.humanScores ?? {})) {
      if (!known.has(criterionId)) {
        throw new DatasetError(`sample "${sample.id}": humanScores names unknown criterion "${criterionId}"`);
      }
      if (score < min || score > max) {
        throw new DatasetError(`sample "${sample.id}": human score ${score} for "${criterionId}" is outside ${min}..${max}`);
      }
    }
  }
}

export async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new EvalKitError(`cannot read file: ${path}`);
  }
}

export async function loadDataset(path: string): Promise<Sample[]> {
  return parseDataset(await readTextFile(path));
}
