import type { Sample } from "../dataset.js";
import { formatInterval, bootstrapNote, num } from "../report.js";
import { resolveResults, type ResultRecord, type RunMeta } from "../store.js";
import { spearman } from "../stats/agreement.js";
import { bootstrapInterval, pick, type BootstrapOptions, type Interval } from "../stats/bootstrap.js";
import { textLength, type LengthUnit } from "./length.js";

export interface LengthBiasOptions {
  unit: LengthUnit;
  bootstrap?: BootstrapOptions;
}

export interface RaterLengthStats {
  rater: string;
  /** Samples this rater scored for the criterion. */
  n: number;
  /** Spearman correlation between response length and this rater's score. */
  rho: number | null;
  rhoCI?: Interval | null;
  /** Samples both this rater and the human scored. Null for the human and when there are no human scores. */
  gapN: number | null;
  /** rho(judge) - rho(human) on the shared samples: how much more the judge's scores follow length than the human's. */
  gap: number | null;
  gapCI?: Interval | null;
  /** True only when a bootstrap interval for the gap lies entirely above 0. */
  flagged: boolean;
}

export interface CriterionLengthBias {
  id: string;
  raters: RaterLengthStats[];
}

export interface LengthBiasReport {
  runId: string;
  unit: LengthUnit;
  hasHuman: boolean;
  raters: string[];
  criteria: CriterionLengthBias[];
  bootstrap?: BootstrapOptions;
}

export function buildLengthBias(
  meta: RunMeta,
  results: readonly ResultRecord[],
  samples: readonly Sample[],
  options: LengthBiasOptions,
): LengthBiasReport {
  const boot = options.bootstrap;
  const lengths = new Map(samples.map((s) => [s.id, textLength(s.response, options.unit)]));
  const resolved = resolveResults(results);
  const raterSet = new Set(results.map((r) => r.rater));
  const rank = (rater: string): number => (rater === "human" ? -1 : meta.raters.indexOf(rater));
  const raters = [...raterSet].sort((x, y) => rank(x) - rank(y));
  const hasHuman = raterSet.has("human");

  const criteria = meta.rubric.criteria.map((criterion): CriterionLengthBias => {
    const byRater = new Map<string, Map<string, number>>();
    for (const r of resolved.ok) {
      if (r.criterionId !== criterion.id || !lengths.has(r.sampleId)) continue;
      const scores = byRater.get(r.rater) ?? new Map<string, number>();
      scores.set(r.sampleId, r.score);
      byRater.set(r.rater, scores);
    }
    const human = byRater.get("human");

    const stats = raters.map((rater): RaterLengthStats => {
      const scores = byRater.get(rater) ?? new Map<string, number>();
      const ids = [...scores.keys()].sort();
      const xs = ids.map((id) => lengths.get(id) as number);
      const ys = ids.map((id) => scores.get(id) as number);

      let gapN: number | null = null;
      let gap: number | null = null;
      let gapCI: Interval | null | undefined;
      if (rater !== "human" && human) {
        const shared = ids.filter((id) => human.has(id));
        const gx = shared.map((id) => lengths.get(id) as number);
        const gj = shared.map((id) => scores.get(id) as number);
        const gh = shared.map((id) => human.get(id) as number);
        const difference = (idx: readonly number[]): number | null => {
          const judge = spearman(pick(gx, idx), pick(gj, idx));
          const person = spearman(pick(gx, idx), pick(gh, idx));
          return judge === null || person === null ? null : judge - person;
        };
        gapN = shared.length;
        gap = difference(shared.map((_, i) => i));
        gapCI = boot ? bootstrapInterval(shared.length, difference, boot) : undefined;
      }

      return {
        rater,
        n: ids.length,
        rho: spearman(xs, ys),
        ...(boot ? { rhoCI: bootstrapInterval(ids.length, (idx) => spearman(pick(xs, idx), pick(ys, idx)), boot) } : {}),
        gapN,
        gap,
        ...(gapCI !== undefined ? { gapCI } : {}),
        flagged: gapCI != null && gapCI.low > 0,
      };
    });
    return { id: criterion.id, raters: stats };
  });

  return { runId: meta.id, unit: options.unit, hasHuman, raters, criteria, ...(boot ? { bootstrap: boot } : {}) };
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]): string => `  ${cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ")}`;
  return [line(header), ...rows.map(line)];
}

export function formatLengthBias(report: LengthBiasReport): string {
  const lines = [`Length bias for run ${report.runId} (length measured in ${report.unit})`];
  for (const c of report.criteria) {
    lines.push("", `Criterion: ${c.id}`);
    lines.push(
      ...table(
        ["rater", "n", "rho(length, score)", "gap vs human"],
        c.raters.map((r) => [
          r.rater,
          String(r.n),
          `${num(r.rho)}${formatInterval(r.rhoCI)}`,
          r.rater === "human" || !report.hasHuman ? "-" : `${num(r.gap)}${formatInterval(r.gapCI)}`,
        ]),
      ),
    );
    for (const r of c.raters.filter((x) => x.flagged)) {
      lines.push(`  ! ${r.rater} follows response length more than the human scores do (gap interval is above 0)`);
    }
  }
  lines.push(
    "",
    "rho(length, score) is the Spearman correlation between response length and the score a rater gave.",
    "Longer answers are often genuinely better, so a high rho alone is not bias. The gap is judge rho minus human rho on the same samples:",
    "a positive gap means the judge rewards length more than people do. A '!' needs --bootstrap, since it requires the gap interval to be above 0.",
  );
  if (!report.hasHuman) lines.push("No human scores in this run, so the gap cannot be computed.");
  if (report.bootstrap) lines.push(bootstrapNote(report.bootstrap));
  return `${lines.join("\n")}\n`;
}
