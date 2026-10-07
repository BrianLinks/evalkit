import { z } from "zod";
import { FileStore } from "../fileStore.js";
import { resolveRows } from "../resolve.js";
import { metaShape, newRunId, type NewRun } from "../store.js";

export const PairRowSchema = z.object({
  pairId: z.string(),
  criterionId: z.string(),
  rater: z.string(),
  kind: z.enum(["judge", "human"]),
  /** Which response the judge saw first. Absent for human rows. */
  order: z.enum(["AB", "BA"]).optional(),
  /** Winner mapped back to systems A and B, whatever order the judge saw them in. */
  winner: z.enum(["A", "B", "tie"]).optional(),
  rationale: z.string().optional(),
  error: z.string().optional(),
});

export const PairMetaSchema = z.object({
  ...metaShape,
  labels: z.object({ a: z.string(), b: z.string() }),
});

export type PairRow = z.infer<typeof PairRowSchema>;
export type DecidedPairRow = PairRow & { winner: "A" | "B" | "tie" };
export type PairMeta = z.infer<typeof PairMetaSchema>;
export type NewPairRun = NewRun & { labels: { a: string; b: string } };

export const pairKey = (r: Pick<PairRow, "rater" | "pairId" | "criterionId" | "order">): string =>
  [r.rater, r.pairId, r.criterionId, r.order ?? "-"].join("\u0000");

const isDecided = (r: PairRow): r is DecidedPairRow => r.winner !== undefined;

export function resolvePairRows(rows: readonly PairRow[]): { ok: DecidedPairRow[]; failures: PairRow[] } {
  return resolveRows(rows, pairKey, isDecided);
}

export class PairStore extends FileStore<PairMeta, PairRow> {
  constructor(baseDir: string) {
    super(baseDir, PairMetaSchema, PairRowSchema);
  }

  async create(input: NewPairRun, now: Date = new Date()): Promise<PairMeta> {
    const meta: PairMeta = { id: newRunId(now), createdAt: now.toISOString(), status: "running", ...input };
    await this.init(meta);
    return meta;
  }

  finish(id: string, status: "completed" | "failed", counts: { tasks: number; failed: number }, now: Date = new Date()): Promise<PairMeta> {
    return this.update(id, (m) => ({ ...m, status, counts, finishedAt: now.toISOString() }));
  }

  reopen(id: string): Promise<PairMeta> {
    return this.update(id, (m) => ({ ...m, status: "running", finishedAt: undefined, resumes: (m.resumes ?? 0) + 1 }));
  }

  async load(id: string): Promise<{ meta: PairMeta; rows: PairRow[] }> {
    return { meta: await this.loadMeta(id), rows: await this.loadRows(id) };
  }
}
