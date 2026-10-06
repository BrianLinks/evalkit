import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRubric } from "../src/rubric/parser.js";
import { RunStore, sha256, type NewRun } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evalkit-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rubric = parseRubric("rubric R\ncriterion a\n  ask: q\n");
const input: NewRun = { datasetPath: "d.jsonl", datasetSha256: sha256("d"), rubricSha256: sha256("r"), rubric, raters: ["mock:a"], concurrency: 2 };

describe("RunStore", () => {
  it("creates a run, appends results and finishes it", async () => {
    const store = new RunStore(dir);
    const meta = await store.create(input, new Date("2026-10-06T12:34:56.789Z"));
    expect(meta.id).toMatch(/^20261006T123456Z-[0-9a-f]{6}$/);
    expect(meta.status).toBe("running");

    await store.append(meta.id, { sampleId: "s1", criterionId: "a", rater: "mock:a", kind: "judge", score: 3, rationale: "ok" });
    await store.append(meta.id, { sampleId: "s2", criterionId: "a", rater: "mock:a", kind: "judge", error: "boom" });
    const finished = await store.finish(meta.id, "completed", { tasks: 2, failed: 1 }, new Date("2026-10-06T12:35:00Z"));
    expect(finished.status).toBe("completed");
    expect(finished.counts).toEqual({ tasks: 2, failed: 1 });

    const loaded = await store.load(meta.id);
    expect(loaded.meta).toEqual(finished);
    expect(loaded.results).toHaveLength(2);
    expect(loaded.results[1].error).toBe("boom");
  });

  it("lists runs newest first and returns [] for a missing directory", async () => {
    expect(await new RunStore(join(dir, "nope")).list()).toEqual([]);
    const store = new RunStore(dir);
    const older = await store.create(input, new Date("2026-01-01T00:00:00Z"));
    const newer = await store.create(input, new Date("2026-02-01T00:00:00Z"));
    expect((await store.list()).map((m) => m.id)).toEqual([newer.id, older.id]);
  });

  it("rejects run ids that could escape the store directory", async () => {
    const store = new RunStore(dir);
    await expect(store.load("../etc")).rejects.toThrow(/invalid run id/);
    await expect(store.loadMeta("a/b")).rejects.toThrow(/invalid run id/);
  });

  it("reports unknown, corrupt and invalid data clearly", async () => {
    const store = new RunStore(dir);
    await expect(store.load("missing")).rejects.toThrow(/not found/);

    const meta = await store.create(input);
    await writeFile(join(dir, meta.id, "results.jsonl"), '{"sampleId":"s1"}\n');
    await expect(store.loadResults(meta.id)).rejects.toThrow(/line 1/);
    await writeFile(join(dir, meta.id, "results.jsonl"), "not json\n");
    await expect(store.loadResults(meta.id)).rejects.toThrow(/corrupt at line 1/);
    await writeFile(join(dir, meta.id, "meta.json"), "{}");
    await expect(store.loadMeta(meta.id)).rejects.toThrow(/invalid/);
  });

  it("writes meta.json with a trailing newline", async () => {
    const store = new RunStore(dir);
    const meta = await store.create(input);
    expect((await readFile(join(dir, meta.id, "meta.json"), "utf8")).endsWith("}\n")).toBe(true);
  });
});
