import type { PairLengthBiasReport } from "../bias/pairBias.js";
import type { LengthBiasReport } from "../bias/scoreBias.js";
import type { PairReport } from "../pairwise/report.js";
import type { PairMeta } from "../pairwise/store.js";
import { bootstrapNote, formatInterval, num, pct, type RunReport } from "../report.js";
import type { RunMeta } from "../store.js";
import { lengthBiasBlocks, pairLengthBiasBlocks } from "./biasBlocks.js";
import type { Block, ReportDocument } from "./model.js";

type CommonMeta = RunMeta | PairMeta;

function commonFacts(meta: CommonMeta, failures: number): [string, string][] {
  const facts: [string, string][] = [
    ["Run", meta.id],
    ["Status", meta.status],
    ["Rubric", `${meta.rubric.name} (scale ${meta.rubric.scale.min}..${meta.rubric.scale.max})`],
    ["Judges", meta.raters.join(", ")],
    ["Started", meta.createdAt],
  ];
  if (meta.finishedAt) facts.push(["Finished", meta.finishedAt]);
  if (meta.resumes) facts.push(["Resumed", `${meta.resumes} time${meta.resumes === 1 ? "" : "s"}`]);
  facts.push(["Dataset", `${meta.datasetPath} (sha256 ${meta.datasetSha256.slice(0, 12)}...)`]);
  facts.push(["Unresolved judge failures", String(failures)]);
  return facts;
}

function haltBlocks(halted: { judge: string; reason: string }[] | undefined, runId: string, command: string): Block[] {
  return (halted ?? []).map((h) => ({
    type: "warning" as const,
    text: `${h.judge} was stopped early: ${h.reason}. Fix the cause, then continue with: evalkit ${command} ... --resume ${runId}`,
  }));
}

/** Document for a score run: overall scores, per-criterion agreement, and optionally length bias. */
export function buildScoreDocument(meta: RunMeta, report: RunReport, bias?: LengthBiasReport): ReportDocument {
  const blocks: Block[] = [...haltBlocks(report.halted, report.runId, "run")];

  blocks.push({ type: "heading", level: 2, text: "Overall weighted score" });
  blocks.push({
    type: "table",
    header: ["Rater", "Score"],
    rows: report.raters.map((r) => [r, num(report.overall[r])]),
  });

  for (const c of report.criteria) {
    blocks.push({ type: "heading", level: 2, text: `Criterion: ${c.id} (weight ${c.weight})` });
    blocks.push({
      type: "table",
      header: ["Rater", "Mean score"],
      rows: report.raters.map((r) => [r, num(c.means[r])]),
    });
    blocks.push({ type: "paragraph", text: `Krippendorff's alpha (interval): ${num(c.alpha)}${formatInterval(c.alphaCI)}` });
    blocks.push({
      type: "table",
      header: ["Pair", "n", "Agreement", "Kappa", "Spearman rho"],
      rows: c.pairs.map((p) => [
        `${p.a} vs ${p.b}`,
        String(p.n),
        pct(p.agreement),
        `${num(p.kappa)}${formatInterval(p.kappaCI)}`,
        `${num(p.spearman)}${formatInterval(p.spearmanCI)}`,
      ]),
    });
  }

  if (bias) blocks.push(...lengthBiasBlocks(bias));

  blocks.push({ type: "heading", level: 2, text: "How to read this" });
  blocks.push({
    type: "note",
    text: "Kappa is Cohen's kappa with quadratic weights, so near misses count for more than far misses. Rho is Spearman's rank correlation. Alpha is Krippendorff's alpha across all raters at once. n/a means the statistic is undefined for that data, for example kappa when a rater gives the same score every time.",
  });
  if (report.bootstrap) blocks.push({ type: "note", text: bootstrapNote(report.bootstrap) });

  return {
    title: `EvalKit report: ${meta.rubric.name}`,
    subtitle: "Judge scores and agreement with human raters",
    facts: commonFacts(meta, report.failures),
    blocks,
  };
}

/** Document for a pairwise run: win rates, position-bias stats, agreement, and optionally length bias. */
export function buildPairDocument(meta: PairMeta, report: PairReport, bias?: PairLengthBiasReport): ReportDocument {
  const blocks: Block[] = [...haltBlocks(report.halted, report.runId, "compare run")];

  for (const c of report.criteria) {
    blocks.push({ type: "heading", level: 2, text: `Criterion: ${c.id}` });
    blocks.push({
      type: "table",
      header: ["Rater", "n", "A wins", "B wins", "Ties", "Order flips", "A win rate [95% CI]", "Consistency", "First-pick rate"],
      rows: c.raters.map((r) => [
        r.rater,
        String(r.n),
        String(r.aWins),
        String(r.bWins),
        String(r.ties),
        r.inconsistent === null ? "-" : String(r.inconsistent),
        r.aWinCI ? `${pct(r.aWinRate)} [${pct(r.aWinCI.low)}-${pct(r.aWinCI.high)}]` : "n/a",
        pct(r.consistency),
        pct(r.firstPickRate),
      ]),
    });
    blocks.push({
      type: "table",
      header: ["Pair", "n", "Agreement", "Kappa"],
      rows: c.agreements.map((a) => [`${a.a} vs ${a.b}`, String(a.n), pct(a.agreement), `${num(a.kappa)}${formatInterval(a.kappaCI)}`]),
    });
  }

  if (bias) blocks.push(...pairLengthBiasBlocks(bias));

  blocks.push({ type: "heading", level: 2, text: "How to read this" });
  blocks.push({
    type: "note",
    text: "Every judge sees each pair twice, once with each system first. A verdict counts only if both orders agree; otherwise it is a tie and an order flip. A win rate is A wins divided by A plus B wins, with ties excluded, and its interval is a Wilson interval. First-pick rate is the share of non-tie calls that chose the response shown first; far from 50% suggests position bias. Kappa here is unweighted Cohen's kappa over A, B and tie.",
  });
  if (report.bootstrap) blocks.push({ type: "note", text: bootstrapNote(report.bootstrap) });

  return {
    title: `EvalKit pairwise report: ${meta.rubric.name}`,
    subtitle: `System A is ${meta.labels.a}; system B is ${meta.labels.b}`,
    facts: [...commonFacts(meta, report.failures), ["Systems", `A = ${meta.labels.a}, B = ${meta.labels.b}`]],
    blocks,
  };
}
