import { describe, expect, it } from "vitest";
import { buildReport, formatReport } from "../src/report.js";
import { parseRubric } from "../src/rubric/parser.js";
import { sha256, type ResultRecord, type RunMeta } from "../src/store.js";

const rubric = parseRubric("rubric R\nscale 1..5\ncriterion a weight 2\n  ask: q\ncriterion b\n  ask: q\n");
const meta: RunMeta = {
  id: "run1",
  createdAt: "2026-10-06T00:00:00Z",
  status: "completed",
  datasetPath: "d",
  datasetSha256: sha256("d"),
  rubricSha256: sha256("r"),
  rubric,
  raters: ["j1", "j2"],
  concurrency: 1,
};

const row = (rater: string, sampleId: string, criterionId: string, score: number): ResultRecord => ({
  sampleId,
  criterionId,
  rater,
  kind: rater === "human" ? "human" : "judge",
  score,
});

const results: ResultRecord[] = [];
for (const [sample, scores] of Object.entries({ s1: [1, 3], s2: [3, 4], s3: [5, 2], s4: [2, 5] })) {
  results.push(row("human", sample, "a", scores[0]), row("human", sample, "b", scores[1]));
  results.push(row("j1", sample, "a", scores[0]), row("j1", sample, "b", scores[1])); // identical to human
  results.push(row("j2", sample, "a", 6 - scores[0]), row("j2", sample, "b", 6 - scores[1])); // inverted
}
results.push({ sampleId: "s5", criterionId: "a", rater: "j2", kind: "judge", error: "timeout" });

describe("buildReport", () => {
  const report = buildReport(meta, results);

  it("orders raters human first, then judges in run order, and counts failures", () => {
    expect(report.raters).toEqual(["human", "j1", "j2"]);
    expect(report.failures).toBe(1);
  });

  it("finds perfect agreement between human and j1 and strong disagreement with j2", () => {
    const a = report.criteria[0];
    const humanJ1 = a.pairs.find((p) => p.a === "human" && p.b === "j1");
    const humanJ2 = a.pairs.find((p) => p.a === "human" && p.b === "j2");
    expect(humanJ1).toMatchObject({ n: 4, agreement: 1 });
    expect(humanJ1?.kappa).toBeCloseTo(1);
    expect(humanJ1?.spearman).toBeCloseTo(1);
    expect(humanJ2?.spearman).toBeCloseTo(-1);
    expect(humanJ2?.kappa as number).toBeLessThan(0);
  });

  it("computes mean scores per rater", () => {
    expect(report.criteria[0].means).toEqual({ human: 2.75, j1: 2.75, j2: 3.25 });
  });

  it("computes alpha across all raters and keeps it below 1 when one rater is inverted", () => {
    expect(report.criteria[0].alpha as number).toBeLessThan(1);
    const twoAgreeing = buildReport(meta, results.filter((r) => r.rater !== "j2"));
    expect(twoAgreeing.criteria[0].alpha).toBeCloseTo(1);
  });

  it("weights criteria in the overall score", () => {
    // human, sample s1: (2*1 + 1*3) / 3
    const s1only = buildReport(meta, results.filter((r) => r.sampleId === "s1" && r.rater === "human"));
    expect(s1only.overall.human).toBeCloseTo(5 / 3);
  });

  it("skips samples a rater did not score on every criterion", () => {
    const partial = buildReport(meta, [row("j1", "s1", "a", 4)]);
    expect(partial.overall.j1).toBeNull();
  });

  it("renders readable text with undefined statistics shown as n/a", () => {
    const text = formatReport(report);
    expect(text).toContain("Run run1 (completed)");
    expect(text).toContain("Raters: human, j1, j2");
    expect(text).toContain("human vs j1");
    const constant = formatReport(buildReport(meta, [row("j1", "s1", "a", 3), row("j2", "s1", "a", 3)]));
    expect(constant).toContain("n/a");
  });
});
