import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { StoreError, formatZodIssues } from "./errors.js";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * One directory per run under `baseDir`: `meta.json` (validated on every read) plus an
 * append-only `results.jsonl`. Subclasses supply the schemas and a `create` method.
 */
export class FileStore<Meta extends { id: string; createdAt: string }, Row> {
  constructor(
    readonly baseDir: string,
    private readonly metaSchema: z.ZodType<Meta>,
    private readonly rowSchema: z.ZodType<Row>,
  ) {}

  protected dir(id: string): string {
    if (!RUN_ID.test(id)) throw new StoreError(`invalid run id "${id}"`);
    return join(this.baseDir, id);
  }

  protected async writeMeta(meta: Meta): Promise<void> {
    await writeFile(join(this.dir(meta.id), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  protected async init(meta: Meta): Promise<void> {
    await mkdir(this.dir(meta.id), { recursive: true });
    await this.writeMeta(meta);
    await writeFile(join(this.dir(meta.id), "results.jsonl"), "");
  }

  async append(id: string, row: Row): Promise<void> {
    await appendFile(join(this.dir(id), "results.jsonl"), `${JSON.stringify(row)}\n`);
  }

  async update(id: string, change: (meta: Meta) => Meta): Promise<Meta> {
    const updated = change(await this.loadMeta(id));
    await this.writeMeta(updated);
    return updated;
  }

  async loadMeta(id: string): Promise<Meta> {
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
    const parsed = this.metaSchema.safeParse(raw);
    if (!parsed.success) throw new StoreError(`meta.json for run "${id}" is invalid: ${formatZodIssues(parsed.error)}`);
    return parsed.data;
  }

  async loadRows(id: string): Promise<Row[]> {
    const runDir = this.dir(id);
    let text: string;
    try {
      text = await readFile(join(runDir, "results.jsonl"), "utf8");
    } catch {
      return [];
    }
    const rows: Row[] = [];
    text.split("\n").forEach((line, index) => {
      if (line.trim() === "") return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new StoreError(`results.jsonl for run "${id}" is corrupt at line ${index + 1}`);
      }
      const parsed = this.rowSchema.safeParse(raw);
      if (!parsed.success) throw new StoreError(`results.jsonl for run "${id}" line ${index + 1}: ${formatZodIssues(parsed.error)}`);
      rows.push(parsed.data);
    });
    return rows;
  }

  /** All readable runs, newest first. Directories that are not valid runs are skipped. */
  async list(): Promise<Meta[]> {
    let names: string[];
    try {
      names = await readdir(this.baseDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const metas: Meta[] = [];
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
