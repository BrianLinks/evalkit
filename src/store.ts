import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { FileStore } from "./fileStore.js";
import { resolveRows } from "./resolve.js";
import { RubricSchema, type Rubric } from "./rubric/schema.js";

export const ResultSchema = z.object({
  sampleId: z.string(),
  criterionId: z.string(),
  rater: z.string(),
  kind: z.enum(["judge", "human"]),
  score: z.number().int().optional(),
  rationale: z.string().optional(),
  error: z.string().optional(),
});

/** Fields shared by score runs and pairwise runs. */
export const metaShape = {
  id: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(["running", "completed", "failed"]),
  datasetPath: z.string(),
  datasetSha256: z.string(),
  rubricSha256: z.string(),
  rubric: RubricSchema,
  raters: z.array(z.string()),
  concurrency: z.number().int().positive(),
  counts: z.object({ tasks: z.number().int(), failed: z.number().int() }).optional(),
  /** How many times this run was resumed. */
  resumes: z.number().int().optional(),
};

export const RunMetaSchema = z.object(metaShape);

export type ResultRecord = z.infer<typeof ResultSchema>;
export type ScoredResult = ResultRecord & { score: number };
export type RunMeta = z.infer<typeof RunMetaSchema>;

export interface NewRun {
  datasetPath: string;
  datasetSha256: string;
  rubricSha256: string;
  rubric: Rubric;
  raters: string[];
  concurrency: number;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export const resultKey = (r: Pick<ResultRecord, "rater" | "sampleId" | "criterionId">): string =>
  [r.rater, r.sampleId, r.criterionId].join("\u0000");

const isScored = (r: ResultRecord): r is ScoredResult => r.score !== undefined;

/** Current state of a score run: the latest success per (rater, sample, criterion), and unresolved failures. */
export function resolveResults(results: readonly ResultRecord[]): { ok: ScoredResult[]; failures: ResultRecord[] } {
  return resolveRows(results, resultKey, isScored);
}

export class RunStore extends FileStore<RunMeta, ResultRecord> {
  constructor(baseDir: string) {
    super(baseDir, RunMetaSchema, ResultSchema);
  }

  async create(input: NewRun, now: Date = new Date()): Promise<RunMeta> {
    const meta: RunMeta = { id: newRunId(now), createdAt: now.toISOString(), status: "running", ...input };
    await this.init(meta);
    return meta;
  }

  finish(id: string, status: "completed" | "failed", counts: { tasks: number; failed: number }, now: Date = new Date()): Promise<RunMeta> {
    return this.update(id, (m) => ({ ...m, status, counts, finishedAt: now.toISOString() }));
  }

  /** Mark a run as running again so it can be resumed. */
  reopen(id: string): Promise<RunMeta> {
    return this.update(id, (m) => ({ ...m, status: "running", finishedAt: undefined, resumes: (m.resumes ?? 0) + 1 }));
  }

  loadResults(id: string): Promise<ResultRecord[]> {
    return this.loadRows(id);
  }

  async load(id: string): Promise<{ meta: RunMeta; results: ResultRecord[] }> {
    return { meta: await this.loadMeta(id), results: await this.loadRows(id) };
  }
}
