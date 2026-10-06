import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { StoreError, formatZodIssues } from "./errors.js";
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

export const RunMetaSchema = z.object({
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
});

export type ResultRecord = z.infer<typeof ResultSchema>;
export type RunMeta = z.infer<typeof RunMetaSchema>;

export interface NewRun {
  datasetPath: string;
  datasetSha256: string;
  rubricSha256: string;
  rubric: Rubric;
  raters: string[];
  concurrency: number;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Runs live in `<baseDir>/<runId>/` as meta.json plus an append-only results.jsonl. */
export class RunStore {
  constructor(readonly baseDir: string) {}

  private dir(id: string): string {
    if (!RUN_ID.test(id)) throw new StoreError(`invalid run id "${id}"`);
    return join(this.baseDir, id);
  }

  private async writeMeta(meta: RunMeta): Promise<void> {
    await writeFile(join(this.dir(meta.id), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  async create(input: NewRun, now: Date = new Date()): Promise<RunMeta> {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const id = `${stamp}-${randomBytes(3).toString("hex")}`;
    const meta: RunMeta = { id, createdAt: now.toISOString(), status: "running", ...input };
    await mkdir(this.dir(id), { recursive: true });
    await this.writeMeta(meta);
    await writeFile(join(this.dir(id), "results.jsonl"), "");
    return meta;
  }

  async append(id: string, record: ResultRecord): Promise<void> {
    await appendFile(join(this.dir(id), "results.jsonl"), `${JSON.stringify(record)}\n`);
  }

  async finish(id: string, status: "completed" | "failed", counts: { tasks: number; failed: number }, now: Date = new Date()): Promise<RunMeta> {
    const meta = await this.loadMeta(id);
    const updated: RunMeta = { ...meta, status, counts, finishedAt: now.toISOString() };
    await this.writeMeta(updated);
    return updated;
  }

  async loadMeta(id: string): Promise<RunMeta> {
    const runDir = this.dir(id);
    let text: string;
    try {
      text = await readFile(join(runDir, "meta.json"), "utf8");
    } catch {
      throw new StoreError(`run "${id}" not found in ${this.baseDir}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new StoreError(`meta.json for run "${id}" is corrupt`);
    }
    const parsed = RunMetaSchema.safeParse(raw);
    if (!parsed.success) throw new StoreError(`meta.json for run "${id}" is invalid: ${formatZodIssues(parsed.error)}`);
    return parsed.data;
  }

  async loadResults(id: string): Promise<ResultRecord[]> {
    const runDir = this.dir(id);
    let text: string;
    try {
      text = await readFile(join(runDir, "results.jsonl"), "utf8");
    } catch {
      return [];
    }
    const records: ResultRecord[] = [];
    text.split("\n").forEach((line, index) => {
      if (line.trim() === "") return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new StoreError(`results.jsonl for run "${id}" is corrupt at line ${index + 1}`);
      }
      const parsed = ResultSchema.safeParse(raw);
      if (!parsed.success) throw new StoreError(`results.jsonl for run "${id}" line ${index + 1}: ${formatZodIssues(parsed.error)}`);
      records.push(parsed.data);
    });
    return records;
  }

  async load(id: string): Promise<{ meta: RunMeta; results: ResultRecord[] }> {
    const meta = await this.loadMeta(id);
    return { meta, results: await this.loadResults(id) };
  }

  /** All readable runs, newest first. Unreadable directories are skipped. */
  async list(): Promise<RunMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.baseDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const metas: RunMeta[] = [];
    for (const name of names) {
      if (!RUN_ID.test(name)) continue;
      try {
        metas.push(await this.loadMeta(name));
      } catch {
        continue;
      }
    }
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
