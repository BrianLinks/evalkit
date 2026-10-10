import type { PairLengthBiasReport } from "../bias/pairBias.js";
import { rateText } from "../bias/pairBias.js";
import type { LengthBiasReport } from "../bias/scoreBias.js";
import { bootstrapNote, formatInterval, num } from "../report.js";
import type { Block } from "./model.js";

export function lengthBiasBlocks(report: LengthBiasReport): Block[] {
  const blocks: Block[] = [
    { type: "heading", level: 2, text: `Length bias (length measured in ${report.unit})` },
    {
      type: "paragraph",
      text: "Do judges give higher scores to longer responses? The correlation is between response length and the score a rater gave. Longer answers are often genuinely better, so the gap against the human baseline is the useful number.",
    },
  ];
  for (const c of report.criteria) {
    blocks.push({ type: "heading", level: 3, text: `Criterion: ${c.id}` });
    blocks.push({
      type: "table",
      header: ["Rater", "n", "rho(length, score)", "Gap vs human"],
      rows: c.raters.map((r) => [
        r.rater,
        String(r.n),
        `${num(r.rho)}${formatInterval(r.rhoCI)}`,
        r.rater === "human" || !report.hasHuman ? "-" : `${num(r.gap)}${formatInterval(r.gapCI)}`,
      ]),
    });
    for (const r of c.raters.filter((x) => x.flagged)) {
      blocks.push({ type: "warning", text: `${r.rater} follows response length more than the human scores do (the gap interval is above 0).` });
    }
  }
  blocks.push({
    type: "note",
    text: "Gap = judge correlation minus human correlation on the same samples. A positive gap means the judge rewards length more than people do. A warning needs bootstrap intervals and human scores. It is a rule of thumb, not a proof, and it does not correct for running many comparisons.",
  });
  if (!report.hasHuman) blocks.push({ type: "note", text: "This run has no human scores, so the gap cannot be computed." });
  if (report.bootstrap) blocks.push({ type: "note", text: bootstrapNote(report.bootstrap) });
  return blocks;
}

export function pairLengthBiasBlocks(report: PairLengthBiasReport): Block[] {
  const blocks: Block[] = [
    { type: "heading", level: 2, text: `Length bias (length measured in ${report.unit})` },
    {
      type: "paragraph",
      text: `How often the longer response wins, using the ${report.comparablePairs} pairs whose lengths differ by at least ${Math.round(report.minDiff * 100)}%. Ties and pairs where the judge changed its answer between orders are not counted.`,
    },
  ];
  for (const c of report.criteria) {
    blocks.push({ type: "heading", level: 3, text: `Criterion: ${c.id}` });
    blocks.push({
      type: "table",
      header: ["Rater", "Longer response wins [95% CI]", "On pairs the human called a tie"],
      rows: c.raters.map((r) => [r.rater, rateText(r.all), r.onHumanTies ? rateText(r.onHumanTies) : "-"]),
    });
    for (const r of c.raters.filter((x) => x.flagged)) {
      blocks.push({ type: "warning", text: `${r.rater} picks the longer response more often than chance even where the human saw no difference.` });
    }
  }
  blocks.push({
    type: "note",
    text: "50% means no length preference. Humans may also prefer longer answers when they really are better, so compare with the human row. A rate clearly above 50% on pairs the human called a tie points to a length preference. Small counts give wide intervals.",
  });
  if (!report.hasHuman) blocks.push({ type: "note", text: "This run has no human preferences, so the human comparison is unavailable." });
  return blocks;
}
