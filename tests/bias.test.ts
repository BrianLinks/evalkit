import { describe, expect, it } from "vitest";
import { assertDatasetMatches, relativeDifference, textLength } from "../src/bias/length.js";
import { buildPairLengthBias, formatPairLengthBias } from "../src/bias/pairBias.js";
import { buildLengthBias, formatLengthBias } from "../src/bias/scoreBias.js";
import type { Sample } from "../src/dataset.js";
import type { PairSample } from "../src/pairwise/dataset.js";
import type { PairMeta, PairRow } from "../src/pairwise/store.js";
import { parseRubric } from "../src/rubric/parser.js";
import { spearman } from "../src/stats/agreement.js";
import { sha256, type ResultRecord, type RunMeta } from "../src/store.js";

const words = (n: number): string => Array.from({ length: n }, () => "w").join(" ");

describe("length helpers", () => {
  it("counts words and characters", () => {
    expect(textLength("  one two\nthree  ", "words")).toBe(3);
    expect(textLength("", "words")).toBe(0);
    expect(textLength("   ", "words")).toBe(0);
    expect(textLength("héllo", "chars")).toBe(5);
  });
  it("measures relative difference against the longer text", () => {
    expect(relativeDifference(10, 20)).toBe(0.5);
    expect(relativeDifference(20, 10)).toBe(0.5);
    expect(relativeDifference(5, 5)).toBe(0);
    expect(relativeDifference(0, 0)).toBe(0);
  });
  it("refuses a dataset whose content differs from the run's", () => {
    const run = { id: "r1", datasetSha256: sha256("abc") };
    expect(() => assertDatasetMatches(run, "abc")).not.toThrow();
    expect(() => assertDatasetMatches(run, "abcd")).toThrow(/not the dataset run r1 used/);
  });
});

// ---------------------------------------------------------------- score runs
describe("buildLengthBias", () => {
  const rubric = parseRubric("rubric R\nscale 1..5\ncriterion a\n  ask: q\n");
  const N = 40;
  const samples: Sample[] = Array.from({ length: N }, (_, i) => ({ id: `s${i}`, prompt: "p", response: words(i + 1) }));
  const lengths = samples.map((s) => textLength(s.response, "words"));

  let seed = 99;
  const randomScore = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return 1 + (seed % 5);
  };
  const humanScores = samples.map(() => randomScore());
  const lengthyScores = samples.map((_, i) => 1 + Math.floor((i * 5) / N)); // rises with length

  const meta: RunMeta = {
    id: "run1", createdAt: "2026-10-08T00:00:00Z", status: "completed", datasetPath: "d", datasetSha256: sha256("d"),
    rubricSha256: sha256("r"), rubric, raters: ["lengthy", "neutral"], concurrency: 1,
  };
  const rows = (rater: string, kind: "judge" | "human", scores: number[]): ResultRecord[] =>
    samples.map((s, i) => ({ sampleId: s.id, criterionId: "a", rater, kind, score: scores[i] }));
  const withHuman = [...rows("human", "human", humanScores), ...rows("lengthy", "judge", lengthyScores), ...rows("neutral", "judge", humanScores)];
  const boot = { iterations: 500, confidence: 0.95, seed: 4 };

  it("reports each rater's length-score correlation", () => {
    const report = buildLengthBias(meta, withHuman, samples, { unit: "words" });
    const [human, lengthy, neutral] = report.criteria[0].raters;
    expect([human.rater, lengthy.rater, neutral.rater]).toEqual(["human", "lengthy", "neutral"]);
    expect(human.rho).toBeCloseTo(spearman(lengths, humanScores) as number);
    expect(lengthy.rho as number).toBeGreaterThan(0.9);
    expect(neutral.rho).toBeCloseTo(human.rho as number);
    expect(report.hasHuman).toBe(true);
  });

  it("computes the gap against the human on shared samples", () => {
    const [human, lengthy, neutral] = buildLengthBias(meta, withHuman, samples, { unit: "words" }).criteria[0].raters;
    expect(human.gap).toBeNull();
    expect(lengthy.gapN).toBe(N);
    expect(lengthy.gap as number).toBeGreaterThan(0.5);
    expect(neutral.gap).toBeCloseTo(0);
  });

  it("flags only a judge whose gap interval is above zero, and only with bootstrap", () => {
    const plain = buildLengthBias(meta, withHuman, samples, { unit: "words" }).criteria[0].raters;
    expect(plain.every((r) => !r.flagged)).toBe(true);
    expect(plain[1].gapCI).toBeUndefined();

    const [human, lengthy, neutral] = buildLengthBias(meta, withHuman, samples, { unit: "words", bootstrap: boot }).criteria[0].raters;
    expect(lengthy.flagged).toBe(true);
    expect(lengthy.gapCI?.low as number).toBeGreaterThan(0);
    expect(neutral.flagged).toBe(false);
    expect(human.flagged).toBe(false);
    expect(human.rhoCI).not.toBeNull();
  });

  it("works without human scores, but has no gap", () => {
    const noHuman = withHuman.filter((r) => r.rater !== "human");
    const report = buildLengthBias(meta, noHuman, samples, { unit: "words", bootstrap: boot });
    expect(report.hasHuman).toBe(false);
    expect(report.criteria[0].raters.every((r) => r.gap === null && !r.flagged)).toBe(true);
    expect(formatLengthBias(report)).toContain("No human scores");
  });

  it("uses the chosen unit", () => {
    const wide: Sample[] = [{ id: "s0", prompt: "p", response: "aaaa" }, { id: "s1", prompt: "p", response: "b b b b b" }];
    const two: ResultRecord[] = [
      { sampleId: "s0", criterionId: "a", rater: "j", kind: "judge", score: 1 },
      { sampleId: "s1", criterionId: "a", rater: "j", kind: "judge", score: 5 },
    ];
    // words: 1 vs 5 -> longer is s1; chars: 4 vs 9 -> longer is s1. Both positive, but flip the text to tell them apart:
    const flipped: Sample[] = [{ id: "s0", prompt: "p", response: "aaaaaaaaaa" }, { id: "s1", prompt: "p", response: "b b b" }];
    expect(buildLengthBias(meta, two, wide, { unit: "words" }).criteria[0].raters[0].rho).toBeCloseTo(1);
    expect(buildLengthBias(meta, two, flipped, { unit: "words" }).criteria[0].raters[0].rho).toBeCloseTo(1); // 1 word vs 3
    expect(buildLengthBias(meta, two, flipped, { unit: "chars" }).criteria[0].raters[0].rho).toBeCloseTo(-1); // 10 chars vs 5
  });

  it("ignores failed calls and prints a readable table with the caveat", () => {
    const withError: ResultRecord[] = [...withHuman, { sampleId: "s0", criterionId: "a", rater: "extra", kind: "judge", error: "boom" }];
    const report = buildLengthBias(meta, withError, samples, { unit: "words", bootstrap: boot });
    expect(report.criteria[0].raters.find((r) => r.rater === "extra")?.n).toBe(0);
    const text = formatLengthBias(report);
    expect(text).toContain("rho(length, score)");
    expect(text).toContain("! lengthy follows response length more than the human scores do");
    expect(text).toContain("a high rho alone is not bias");
    expect(text).toContain("percentile bootstrap");
  });
});

// ---------------------------------------------------------------- pairwise runs
describe("buildPairLengthBias", () => {
  const rubric = parseRubric("rubric R\ncriterion a\n  ask: q\n");
  const meta: PairMeta = {
    id: "p1", createdAt: "2026-10-08T00:00:00Z", status: "completed", datasetPath: "d", datasetSha256: "x", rubricSha256: "y",
    rubric, raters: ["longer", "shorter"], concurrency: 1, labels: { a: "A", b: "B" },
  };

  // 24 clear pairs (A longer when i is even), plus two pairs only 5% apart in length.
  const pairs: PairSample[] = [
    ...Array.from({ length: 24 }, (_, i) => ({
      id: `p${i}`, prompt: "q", responseA: words(i % 2 === 0 ? 20 : 10), responseB: words(i % 2 === 0 ? 10 : 20),
    })),
    { id: "n1", prompt: "q", responseA: words(20), responseB: words(21) },
    { id: "n2", prompt: "q", responseA: words(21), responseB: words(20) },
  ];
  const longerSide = (id: string): "A" | "B" => {
    const p = pairs.find((x) => x.id === id) as PairSample;
    return textLength(p.responseA, "words") > textLength(p.responseB, "words") ? "A" : "B";
  };

  const rows: PairRow[] = [];
  for (const p of pairs) {
    const i = Number(p.id.slice(1));
    const humanSaysTie = p.id.startsWith("p") && i < 12; // humans see no difference on the first 12 pairs
    rows.push({ pairId: p.id, criterionId: "a", rater: "human", kind: "human", winner: humanSaysTie ? "tie" : longerSide(p.id) });
    for (const order of ["AB", "BA"] as const) {
      rows.push({ pairId: p.id, criterionId: "a", rater: "longer", kind: "judge", order, winner: longerSide(p.id) });
      rows.push({ pairId: p.id, criterionId: "a", rater: "shorter", kind: "judge", order, winner: longerSide(p.id) === "A" ? "B" : "A" });
    }
  }
  const options = { unit: "words" as const, minDiff: 0.1 };

  it("ignores pairs whose lengths are too close", () => {
    const report = buildPairLengthBias(meta, rows, pairs, options);
    expect(report.comparablePairs).toBe(24);
    const longer = report.criteria[0].raters.find((r) => r.rater === "longer");
    expect(longer?.all.n).toBe(24);
    expect(buildPairLengthBias(meta, rows, pairs, { ...options, minDiff: 0 }).comparablePairs).toBe(26);
  });

  it("separates a judge that always picks the longer response from one that never does", () => {
    const [human, longer, shorter] = buildPairLengthBias(meta, rows, pairs, options).criteria[0].raters;
    expect([human.rater, longer.rater, shorter.rater]).toEqual(["human", "longer", "shorter"]);
    expect(longer.all).toMatchObject({ n: 24, longerWins: 24, rate: 1 });
    expect(longer.all.ci?.low as number).toBeGreaterThan(0.85);
    expect(shorter.all).toMatchObject({ n: 24, longerWins: 0, rate: 0 });
    expect(human.all).toMatchObject({ n: 12, longerWins: 12 }); // humans abstained on the other 12
  });

  it("looks only at pairs the human called a tie for the stronger test, and flags just that judge", () => {
    const [human, longer, shorter] = buildPairLengthBias(meta, rows, pairs, options).criteria[0].raters;
    expect(human.onHumanTies).toBeNull();
    expect(longer.onHumanTies).toMatchObject({ n: 12, longerWins: 12 });
    expect(longer.flagged).toBe(true);
    expect(shorter.onHumanTies).toMatchObject({ n: 12, longerWins: 0 });
    expect(shorter.flagged).toBe(false);
    expect(human.flagged).toBe(false);
  });

  it("does not flag on a handful of pairs: the interval is too wide", () => {
    const few = rows.filter((r) => ["p0", "p1", "p2"].includes(r.pairId));
    const longer = buildPairLengthBias(meta, few, pairs, options).criteria[0].raters.find((r) => r.rater === "longer");
    expect(longer?.onHumanTies?.n).toBe(3);
    expect(longer?.flagged).toBe(false); // 3 of 3: Wilson lower bound is about 0.44, not above 0.5
  });

  it("counts a consistent verdict but not one the judge flipped between orders", () => {
    const consistent: PairRow[] = (["AB", "BA"] as const).map((order) => ({
      pairId: "p0", criterionId: "a", rater: "steady", kind: "judge", order, winner: "A",
    }));
    // Chose whichever response was shown first: A when A was first, B when B was first. A position effect, not a verdict.
    const flipped: PairRow[] = [
      { pairId: "p0", criterionId: "a", rater: "steady", kind: "judge", order: "AB", winner: "A" },
      { pairId: "p0", criterionId: "a", rater: "steady", kind: "judge", order: "BA", winner: "B" },
    ];
    const steadyMeta = { ...meta, raters: ["steady"] };
    expect(buildPairLengthBias(steadyMeta, consistent, pairs, options).criteria[0].raters[0].all.n).toBe(1);
    expect(buildPairLengthBias(steadyMeta, flipped, pairs, options).criteria[0].raters[0].all.n).toBe(0);
  });

  it("prints a table with the flag and the caveats", () => {
    const text = formatPairLengthBias(buildPairLengthBias(meta, rows, pairs, options));
    expect(text).toContain("24 pairs differ by at least 10%");
    expect(text).toContain("24/24 = 100%");
    expect(text).toContain("! longer picks the longer response more often than chance");
    expect(text).toContain("50% means no length preference");
  });

  it("explains the missing human column when there are no human preferences", () => {
    const text = formatPairLengthBias(buildPairLengthBias(meta, rows.filter((r) => r.rater !== "human"), pairs, options));
    expect(text).toContain("No human preferences in this run");
  });
});
