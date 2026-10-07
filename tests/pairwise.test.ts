import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePairDataset, validatePairs } from "../src/pairwise/dataset.js";
import { buildPairReport, formatPairReport } from "../src/pairwise/report.js";
import { executePairwiseRun } from "../src/pairwise/runner.js";
import { PairStore, type PairRow } from "../src/pairwise/store.js";
import type { PairJudge, PairRequest } from "../src/judges/types.js";
import { mockJudge } from "../src/judges/mock.js";
import { parseRubric } from "../src/rubric/parser.js";

let dir: string;
let store: PairStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evalkit-pair-"));
  store = new PairStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rubric = parseRubric("rubric R\ncriterion a\n  ask: qa\ncriterion b\n  ask: qb\n");
const datasetText = [
  '{"id":"p1","prompt":"q","responseA":"good answer","responseB":"bad answer","human":{"a":"A","b":"tie"}}',
  '{"id":"p2","prompt":"q","responseA":"bad answer","responseB":"good answer","human":{"a":"B"}}',
  '{"id":"p3","prompt":"q","responseA":"good answer","responseB":"good reply"}',
].join("\n");
const pairs = parsePairDataset(datasetText);
const makeBase = () => ({ rubric, pairs, store, datasetPath: "p.jsonl", datasetText, concurrency: 3, labels: { a: "base", b: "cand" } });

/** Picks whichever response contains "good"; ties when both or neither do. Ignores order, like an unbiased judge. */
const smart: PairJudge = {
  id: "smart",
  async compare({ first, second }) {
    const f = first.includes("good");
    const s = second.includes("good");
    return { winner: f && !s ? "first" : s && !f ? "second" : "tie", rationale: "" };
  },
};
/** Always says "first", like a judge with total position bias. */
const alwaysFirst: PairJudge = { id: "alwaysFirst", compare: async () => ({ winner: "first", rationale: "" }) };

describe("pair dataset", () => {
  it("parses pairs and validates human criteria", () => {
    expect(pairs).toHaveLength(3);
    expect(() => validatePairs(pairs, rubric)).not.toThrow();
    const bad = parsePairDataset('{"id":"x","prompt":"q","responseA":"a","responseB":"b","human":{"zzz":"A"}}');
    expect(() => validatePairs(bad, rubric)).toThrow(/unknown criterion "zzz"/);
  });
  it("rejects bad shapes, bad labels, duplicates and empty files", () => {
    expect(() => parsePairDataset('{"id":"x","prompt":"q","responseA":"a"}')).toThrow(/line 1: responseB/);
    expect(() => parsePairDataset('{"id":"x","prompt":"q","responseA":"a","responseB":"b","human":{"a":"C"}}')).toThrow(/line 1/);
    const line = '{"id":"x","prompt":"q","responseA":"a","responseB":"b"}';
    expect(() => parsePairDataset(`${line}\n${line}`)).toThrow(/duplicate pair id "x"/);
    expect(() => parsePairDataset("")).toThrow(/no pairs/);
  });
});

describe("executePairwiseRun", () => {
  it("shows every judge both orders and maps winners back to systems A and B", async () => {
    const seen: PairRequest[] = [];
    const spy: PairJudge = {
      id: "spy",
      async compare(request) {
        seen.push(request);
        return smart.compare(request);
      },
    };
    const meta = await executePairwiseRun({ ...makeBase(), judges: [spy] });
    expect(meta.status).toBe("completed");
    expect(meta.counts).toEqual({ tasks: 12, failed: 0 });
    expect(meta.labels).toEqual({ a: "base", b: "cand" });

    const p1 = seen.filter((r) => r.criterion.id === "a" && r.first.includes("answer") && r.prompt === "q");
    expect(p1.some((r) => r.first === "good answer" && r.second === "bad answer")).toBe(true);
    expect(p1.some((r) => r.first === "bad answer" && r.second === "good answer")).toBe(true);

    const rows = await store.loadRows(meta.id);
    const p1a = rows.filter((r) => r.pairId === "p1" && r.criterionId === "a" && r.kind === "judge");
    expect(p1a.map((r) => [r.order, r.winner]).sort()).toEqual([["AB", "A"], ["BA", "A"]]);
    expect(rows.filter((r) => r.kind === "human")).toHaveLength(3);
  });

  it("records failures, marks the run failed only if nothing was decided, and retries on resume", async () => {
    let healthy = false;
    const calls: string[] = [];
    const flaky: PairJudge = {
      id: "flaky",
      async compare(request) {
        calls.push(`${request.first}|${request.second}`);
        if (!healthy && request.prompt === "q" && request.first === "bad answer") throw new Error("rate limited");
        return smart.compare(request);
      },
    };
    const first = await executePairwiseRun({ ...makeBase(), judges: [flaky] });
    expect(first.status).toBe("completed");
    expect(first.counts?.failed).toBe(4); // "bad answer" is shown first in 2 (pair, order) slots x 2 criteria

    healthy = true;
    calls.length = 0;
    const second = await executePairwiseRun({ ...makeBase(), judges: [flaky], resume: first.id });
    expect(calls).toHaveLength(4); // only the failed calls are redone
    expect(second.counts).toEqual({ tasks: 12, failed: 0 });
    expect(second.resumes).toBe(1);

    const broken: PairJudge = { id: "broken", compare: async () => Promise.reject(new Error("down")) };
    const dead = await executePairwiseRun({ ...makeBase(), judges: [broken] });
    expect(dead.status).toBe("failed");
  });

  it("refuses to resume with a changed dataset, rubric or judges, and validates up front", async () => {
    const first = await executePairwiseRun({ ...makeBase(), judges: [smart] });
    await expect(executePairwiseRun({ ...makeBase(), datasetText: `${datasetText}\n`, judges: [smart], resume: first.id })).rejects.toThrow(/dataset changed/);
    const other = parseRubric("rubric R\ncriterion a\n  ask: changed\ncriterion b\n  ask: qb\n");
    await expect(executePairwiseRun({ ...makeBase(), rubric: other, judges: [smart], resume: first.id })).rejects.toThrow(/rubric changed/);
    await expect(executePairwiseRun({ ...makeBase(), judges: [alwaysFirst], resume: first.id })).rejects.toThrow(/judges must match/);
    await expect(executePairwiseRun({ ...makeBase(), judges: [] })).rejects.toThrow(/at least one judge/);
    await expect(executePairwiseRun({ ...makeBase(), judges: [smart, smart] })).rejects.toThrow(/twice/);
    await expect(executePairwiseRun({ ...makeBase(), judges: [smart], concurrency: 0 })).rejects.toThrow(/concurrency/);
  });
});

describe("pair report", () => {
  it("separates an unbiased judge from a fully position-biased one", async () => {
    const meta = await executePairwiseRun({ ...makeBase(), judges: [smart, alwaysFirst] });
    const report = buildPairReport(meta, await store.loadRows(meta.id));
    expect(report.raters).toEqual(["human", "smart", "alwaysFirst"]);
    expect(report.failures).toBe(0);

    const a = report.criteria[0];
    const smartStats = a.raters.find((r) => r.rater === "smart");
    expect(smartStats).toMatchObject({ n: 3, aWins: 1, bWins: 1, ties: 1, inconsistent: 0, consistency: 1, aWinRate: 0.5 });
    expect(smartStats?.firstPickRate).toBeCloseTo(0.5);

    const biased = a.raters.find((r) => r.rater === "alwaysFirst");
    expect(biased).toMatchObject({ n: 3, ties: 3, inconsistent: 3, consistency: 0, aWinRate: null, aWinCI: null });
    expect(biased?.firstPickRate).toBe(1);

    const human = a.raters.find((r) => r.rater === "human");
    expect(human).toMatchObject({ n: 2, aWins: 1, bWins: 1, inconsistent: null, consistency: null, firstPickRate: null });

    const agreeSmart = a.agreements.find((x) => x.a === "human" && x.b === "smart");
    expect(agreeSmart).toMatchObject({ n: 2, agreement: 1 });
    expect(agreeSmart?.kappa).toBeCloseTo(1);
    const agreeBiased = a.agreements.find((x) => x.a === "human" && x.b === "alwaysFirst");
    expect(agreeBiased).toMatchObject({ n: 2, agreement: 0 });
    expect(agreeBiased?.kappa).toBeCloseTo(0);
  });

  it("ignores a judge verdict that only has one order and counts unresolved failures", () => {
    const meta = {
      id: "r", createdAt: "2026-10-07T00:00:00Z", status: "completed" as const, datasetPath: "d", datasetSha256: "x", rubricSha256: "y",
      rubric, raters: ["j"], concurrency: 1, labels: { a: "A", b: "B" },
    };
    const rows: PairRow[] = [
      { pairId: "p1", criterionId: "a", rater: "j", kind: "judge", order: "AB", winner: "A" },
      { pairId: "p1", criterionId: "a", rater: "j", kind: "judge", order: "BA", error: "timeout" },
    ];
    const report = buildPairReport(meta, rows);
    expect(report.failures).toBe(1);
    expect(report.criteria[0].raters[0].n).toBe(0);
  });

  it("formats readable text with the label legend", async () => {
    const meta = await executePairwiseRun({ ...makeBase(), judges: [smart] });
    const text = formatPairReport(buildPairReport(meta, await store.loadRows(meta.id)));
    expect(text).toContain(`Pairwise run ${meta.id} (completed)`);
    expect(text).toContain("A = base, B = cand");
    expect(text).toContain("A win rate [95% CI]");
    expect(text).toContain("position bias");
  });

  it("works end to end with the offline mock judge", async () => {
    const meta = await executePairwiseRun({ ...makeBase(), judges: [mockJudge("a"), mockJudge("b")] });
    expect(meta.counts?.tasks).toBe(24);
    expect(meta.status).toBe("completed");
  });
});
