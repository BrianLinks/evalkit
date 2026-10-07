import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDataset } from "../src/dataset.js";
import { mockJudge } from "../src/judges/mock.js";
import type { Judge } from "../src/judges/types.js";
import { executeRun } from "../src/runner.js";
import { parseRubric } from "../src/rubric/parser.js";
import { RunStore, sha256 } from "../src/store.js";

let dir: string;
let store: RunStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evalkit-run-"));
  store = new RunStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rubric = parseRubric("rubric R\nscale 1..5\ncriterion a\n  ask: q\ncriterion b weight 2\n  ask: q2\n");
const datasetText = [
  '{"id":"s1","prompt":"p","response":"r","humanScores":{"a":4,"b":3}}',
  '{"id":"s2","prompt":"p","response":"r","humanScores":{"a":2}}',
  '{"id":"s3","prompt":"p","response":"r"}',
].join("\n");
const samples = parseDataset(datasetText);
const makeBase = () => ({ rubric, samples, store, datasetPath: "d.jsonl", datasetText, concurrency: 3 });

describe("executeRun", () => {
  it("records one row per sample x criterion x judge plus human scores", async () => {
    const meta = await executeRun({ ...makeBase(), judges: [mockJudge("a"), mockJudge("b")] });
    expect(meta.status).toBe("completed");
    expect(meta.counts).toEqual({ tasks: 12, failed: 0 });
    expect(meta.raters).toEqual(["mock:a", "mock:b"]);
    const { results } = await store.load(meta.id);
    expect(results.filter((r) => r.kind === "judge")).toHaveLength(12);
    expect(results.filter((r) => r.kind === "human").map((r) => [r.sampleId, r.criterionId, r.score])).toEqual([
      ["s1", "a", 4],
      ["s1", "b", 3],
      ["s2", "a", 2],
    ]);
  });

  it("records a failing judge as error rows and keeps going", async () => {
    const flaky: Judge = {
      id: "flaky",
      async judge({ sample }) {
        if (sample.id === "s2") throw new Error("rate limited");
        return { score: 3, rationale: "" };
      },
    };
    const meta = await executeRun({ ...makeBase(), judges: [flaky] });
    expect(meta.status).toBe("completed");
    expect(meta.counts).toEqual({ tasks: 6, failed: 2 });
    const errors = (await store.loadResults(meta.id)).filter((r) => r.error);
    expect(errors.map((r) => r.sampleId)).toEqual(["s2", "s2"]);
    expect(errors[0].error).toBe("rate limited");
  });

  it("marks the run failed when every task fails", async () => {
    const broken: Judge = { id: "broken", judge: async () => Promise.reject(new Error("down")) };
    const meta = await executeRun({ ...makeBase(), judges: [broken] });
    expect(meta.status).toBe("failed");
    expect(meta.counts).toEqual({ tasks: 6, failed: 6 });
  });

  it("treats an out-of-range score from a custom judge as a failure", async () => {
    const wild: Judge = { id: "wild", judge: async () => ({ score: 99, rationale: "" }) };
    const meta = await executeRun({ ...makeBase(), judges: [wild] });
    expect(meta.counts?.failed).toBe(6);
    expect((await store.loadResults(meta.id))[3].error).toMatch(/outside 1..5/);
  });

  it("never runs more than `concurrency` judge calls at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: Judge = {
      id: "slow",
      async judge() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { score: 3, rationale: "" };
      },
    };
    await executeRun({ ...makeBase(), judges: [slow], concurrency: 2 });
    expect(peak).toBe(2);
  });

  it("validates before creating a run", async () => {
    const bad = parseDataset('{"id":"s1","prompt":"p","response":"r","humanScores":{"nope":1}}');
    await expect(executeRun({ ...makeBase(), samples: bad, judges: [mockJudge("a")] })).rejects.toThrow(/unknown criterion/);
    await expect(executeRun({ ...makeBase(), judges: [] })).rejects.toThrow(/at least one judge/);
    await expect(executeRun({ ...makeBase(), judges: [mockJudge("a"), mockJudge("a")] })).rejects.toThrow(/twice/);
    await expect(executeRun({ ...makeBase(), judges: [mockJudge("a")], concurrency: 0 })).rejects.toThrow(/concurrency/);
    expect(await store.list()).toEqual([]);
  });

  it("stores hashes so a run can be tied to its inputs", async () => {
    const meta = await executeRun({ ...makeBase(), judges: [mockJudge("a")] });
    expect(meta.datasetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.rubricSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("resume", () => {
    const counting = (id: string, calls: string[]): Judge => ({
      id,
      async judge({ sample, criterion }) {
        calls.push(`${sample.id}/${criterion.id}`);
        return { score: 3, rationale: "" };
      },
    });

    it("continues an interrupted run without redoing finished work or duplicating human rows", async () => {
      // Simulate a crash: the run exists, three human rows are partly written, two judge results are saved.
      const crashed = await store.create({
        datasetPath: "d.jsonl",
        datasetSha256: sha256(datasetText),
        rubricSha256: sha256(JSON.stringify(rubric)),
        rubric,
        raters: ["counting"],
        concurrency: 2,
      });
      await store.append(crashed.id, { sampleId: "s1", criterionId: "a", rater: "human", kind: "human", score: 4 });
      await store.append(crashed.id, { sampleId: "s1", criterionId: "a", rater: "counting", kind: "judge", score: 3 });
      await store.append(crashed.id, { sampleId: "s1", criterionId: "b", rater: "counting", kind: "judge", score: 3 });

      const calls: string[] = [];
      const meta = await executeRun({ ...makeBase(), judges: [counting("counting", calls)], resume: crashed.id });
      expect(meta.id).toBe(crashed.id);
      expect(meta.status).toBe("completed");
      expect(meta.resumes).toBe(1);
      expect(meta.counts).toEqual({ tasks: 6, failed: 0 });
      expect(calls).toHaveLength(4);
      expect(calls).not.toContain("s1/a");
      expect(calls).not.toContain("s1/b");

      const rows = await store.loadResults(crashed.id);
      expect(rows.filter((r) => r.kind === "human")).toHaveLength(3);
      expect(await store.list()).toHaveLength(1);
    });

    it("retries earlier failures and clears them once they succeed", async () => {
      let healthy = false;
      const calls: string[] = [];
      const recovering: Judge = {
        id: "recovering",
        async judge({ sample, criterion }) {
          calls.push(`${sample.id}/${criterion.id}`);
          if (!healthy && sample.id === "s2") throw new Error("rate limited");
          return { score: 4, rationale: "" };
        },
      };
      const first = await executeRun({ ...makeBase(), judges: [recovering] });
      expect(first.counts).toEqual({ tasks: 6, failed: 2 });

      healthy = true;
      calls.length = 0;
      const second = await executeRun({ ...makeBase(), judges: [recovering], resume: first.id });
      expect(calls.sort()).toEqual(["s2/a", "s2/b"]);
      expect(second.counts).toEqual({ tasks: 6, failed: 0 });
      expect(second.status).toBe("completed");
    });

    it("does nothing when everything already succeeded", async () => {
      const calls: string[] = [];
      const judge = counting("counting", calls);
      const first = await executeRun({ ...makeBase(), judges: [judge] });
      calls.length = 0;
      await executeRun({ ...makeBase(), judges: [judge], resume: first.id });
      expect(calls).toEqual([]);
    });

    it("refuses to resume when the dataset, rubric or judges changed, or the run is unknown", async () => {
      const first = await executeRun({ ...makeBase(), judges: [mockJudge("a")] });
      await expect(
        executeRun({ ...makeBase(), datasetText: `${datasetText}\n`, judges: [mockJudge("a")], resume: first.id }),
      ).rejects.toThrow(/dataset changed/);
      const otherRubric = parseRubric("rubric R\nscale 1..5\ncriterion a\n  ask: different\ncriterion b weight 2\n  ask: q2\n");
      await expect(executeRun({ ...makeBase(), rubric: otherRubric, judges: [mockJudge("a")], resume: first.id })).rejects.toThrow(/rubric changed/);
      await expect(executeRun({ ...makeBase(), judges: [mockJudge("b")], resume: first.id })).rejects.toThrow(/judges must match/);
      await expect(executeRun({ ...makeBase(), judges: [mockJudge("a")], resume: "nope" })).rejects.toThrow(/not found/);
    });
  });
});
