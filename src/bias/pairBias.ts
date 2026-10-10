import { pct } from "../report.js";
import type { PairSample } from "../pairwise/dataset.js";
import { finalDecisions } from "../pairwise/report.js";
import { resolvePairRows, type PairMeta, type PairRow } from "../pairwise/store.js";
import { wilsonInterval } from "../stats/proportion.js";
import { relativeDifference, textLength, type LengthUnit } from "./length.js";

export interface PairLengthBiasOptions {
  unit: LengthUnit;
  /** Ignore pairs whose lengths differ by less than this fraction of the longer one. Default 0.1. */
  minDiff: number;
}

export interface LongerWins {
  /** Pairs where this rater picked a side and the lengths differ enough. */
  n: number;
  longerWins: number;
  rate: number | null;
  ci: { low: number; high: number } | null;
}

export interface RaterPairLength {
  rater: string;
  all: LongerWins;
  /** Same measure restricted to pairs where the human saw no difference. Null for the human. */
  onHumanTies: LongerWins | null;
  /** True when, on pairs the human called a tie, the judge picks the longer response more often than chance (CI above 50%). */
  flagged: boolean;
}

export interface CriterionPairLengthBias {
  id: string;
  raters: RaterPairLength[];
}

export interface PairLengthBiasReport {
  runId: string;
  unit: LengthUnit;
  minDiff: number;
  /** Pairs left after dropping those with similar lengths. */
  comparablePairs: number;
  hasHuman: boolean;
  criteria: CriterionPairLengthBias[];
}

const summarize = (longerWins: number, n: number): LongerWins => ({
  n,
  longerWins,
  rate: n > 0 ? longerWins / n : null,
  ci: wilsonInterval(longerWins, n),
});

export function buildPairLengthBias(
  meta: PairMeta,
  rows: readonly PairRow[],
  pairs: readonly PairSample[],
  options: PairLengthBiasOptions,
): PairLengthBiasReport {
  const resolved = resolvePairRows(rows);
  const raterSet = new Set(rows.map((r) => r.rater));
  const rank = (rater: string): number => (rater === "human" ? -1 : meta.raters.indexOf(rater));
  const raters = [...raterSet].sort((x, y) => rank(x) - rank(y));

  // Which side is longer, for pairs whose lengths differ by enough to say so.
  const longer = new Map<string, "A" | "B">();
  for (const pair of pairs) {
    const a = textLength(pair.responseA, options.unit);
    const b = textLength(pair.responseB, options.unit);
    if (a !== b && relativeDifference(a, b) >= options.minDiff) longer.set(pair.id, a > b ? "A" : "B");
  }

  const criteria = meta.rubric.criteria.map((criterion): CriterionPairLengthBias => {
    const finals = finalDecisions(resolved.ok, criterion.id, raters);
    const human = finals.get("human");

    const stats = raters.map((rater): RaterPairLength => {
      let n = 0;
      let wins = 0;
      let tieN = 0;
      let tieWins = 0;
      for (const [pairId, decision] of finals.get(rater) ?? []) {
        const side = longer.get(pairId);
        if (side === undefined || decision.winner === "tie") continue;
        n++;
        if (decision.winner === side) wins++;
        if (human?.get(pairId)?.winner === "tie") {
          tieN++;
          if (decision.winner === side) tieWins++;
        }
      }
      const isHuman = rater === "human";
      const onHumanTies = isHuman || !human ? null : summarize(tieWins, tieN);
      return {
        rater,
        all: summarize(wins, n),
        onHumanTies,
        flagged: onHumanTies?.ci != null && onHumanTies.ci.low > 0.5,
      };
    });
    return { id: criterion.id, raters: stats };
  });

  return {
    runId: meta.id,
    unit: options.unit,
    minDiff: options.minDiff,
    comparablePairs: longer.size,
    hasHuman: raterSet.has("human"),
    criteria,
  };
}

export const rateText = (w: LongerWins): string =>
  w.n === 0 ? "n/a" : `${w.longerWins}/${w.n} = ${pct(w.rate)}${w.ci ? ` [${pct(w.ci.low)}-${pct(w.ci.high)}]` : ""}`;

export function formatPairLengthBias(report: PairLengthBiasReport): string {
  const lines = [
    `Length bias for pairwise run ${report.runId} (length in ${report.unit}; ${report.comparablePairs} pairs differ by at least ${Math.round(report.minDiff * 100)}%)`,
  ];
  for (const c of report.criteria) {
    lines.push("", `Criterion: ${c.id}`);
    const w = Math.max(5, ...c.raters.map((r) => r.rater.length));
    lines.push(`  ${"rater".padEnd(w)}  ${"longer response wins [95% CI]".padEnd(34)}  on pairs the human called a tie`);
    for (const r of c.raters) {
      lines.push(`  ${r.rater.padEnd(w)}  ${rateText(r.all).padEnd(34)}  ${r.onHumanTies ? rateText(r.onHumanTies) : "-"}`);
    }
    for (const r of c.raters.filter((x) => x.flagged)) {
      lines.push(`  ! ${r.rater} picks the longer response more often than chance even where the human saw no difference`);
    }
  }
  lines.push(
    "",
    "50% means no length preference. Humans may also prefer longer answers when they really are better, so compare with the human row.",
    "The last column keeps only pairs where the human saw no difference, so a rate clearly above 50% there points to a length preference.",
    "Ties and pairs the judge flipped between orders are not counted. Intervals are Wilson intervals; small counts give wide ones.",
  );
  if (!report.hasHuman) lines.push("No human preferences in this run, so the human comparison column is unavailable.");
  return `${lines.join("\n")}\n`;
}
