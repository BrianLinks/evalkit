import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Stores the raw text of judge replies that parsed successfully, keyed by `cacheKey`. */
export interface VerdictCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, text: string): Promise<void>;
}

const KEY = /^[0-9a-f]{64}$/;
const SHARD = /^[0-9a-f]{2}$/;
const EntrySchema = z.object({ v: z.literal(1), text: z.string() });

/**
 * Hash of everything that decides what a judge answers: which judge, whether it scores or compares,
 * and the full prompts. Changing the model, the rubric text, the scale, the sample, or EvalKit's own
 * prompt wording all change the key, so a stale answer can never be reused for a different question.
 */
export function cacheKey(judgeId: string, kind: "score" | "compare", system: string, user: string): string {
  return createHash("sha256").update(JSON.stringify([judgeId, kind, system, user])).digest("hex");
}

/**
 * One small JSON file per entry under `<dir>/<first two hex digits>/<key>.json`, written atomically.
 * Unreadable or malformed entries count as misses, never as errors.
 */
export class FileCache implements VerdictCache {
  /** Entries found and reused. */
  hits = 0;
  /** Entries written (live calls that succeeded). */
  stored = 0;

  constructor(readonly dir: string) {}

  private path(key: string): string {
    if (!KEY.test(key)) throw new RangeError("invalid cache key");
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const parsed = EntrySchema.safeParse(JSON.parse(await readFile(this.path(key), "utf8")));
      if (!parsed.success) return undefined;
      this.hits++;
      return parsed.data.text;
    } catch {
      return undefined;
    }
  }

  async set(key: string, text: string): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify({ v: 1, text }));
    try {
      await rename(temporary, target);
    } catch (e) {
      await rm(temporary, { force: true });
      throw e;
    }
    this.stored++;
  }

  /** Number of entries and their total size on disk. */
  async stats(): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    for (const shard of await this.shards()) {
      for (const file of await readdir(join(this.dir, shard))) {
        if (!file.endsWith(".json")) continue;
        entries++;
        bytes += (await stat(join(this.dir, shard, file))).size;
      }
    }
    return { entries, bytes };
  }

  /** Delete every entry. Only touches the shard folders this class creates, never anything else in the directory. */
  async clear(): Promise<number> {
    const { entries } = await this.stats();
    for (const shard of await this.shards()) await rm(join(this.dir, shard), { recursive: true, force: true });
    await rmdir(this.dir).catch(() => undefined); // only succeeds if now empty
    return entries;
  }

  private async shards(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((name) => SHARD.test(name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
}
