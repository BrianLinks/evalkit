import { krippendorffAlphaInterval, mean, percentAgreement, spearman, weightedKappa } from "./stats/agreement.js";
import { bootstrapInterval, pick, type BootstrapOptions, type Interval } from "./stats/bootstrap.js";
import { resolveResults, type ResultRecord, type RunMeta } from "./store.js";

export interface PairStats {
  a: string;
  b: string;
  /** Samples both raters scored for this criterion. */
  n: number;
  agreement: number | null;
  /** Quadratic-weighted Cohen's kappa. */
  kappa: number | null;
  spearman: number | null;
  /** Bootstrap intervals. Present only when bootstrapping was requested; null when not trustworthy. */
  kappaCI?: Interval | null;
  spearmanCI?: Interval | null;
}

export interface CriterionReport {
  id: string;
  weight: number;
  means: Record<string, number | null>;
  /** Krippendorff's alpha (interval) across all raters. */
  alpha: number | null;
  alphaCI?: Interval | null;
  pairs: PairStats[];
}

export interface RunReport {
  runId: string;
  status: RunMeta["status"];
  rubric: string;
  scale: { min: number; max: number };
  raters: string[];
  failures: number;
  criteria: CriterionReport[];
  /** Weighted mean score per rater, over samples that rater scored on every criterion. */
  overall: Record<string, number | null>;
  /** Settings used for the intervals, when requested. */
  bootstrap?: BootstrapOptions;
}

export interface ReportOptions {
  bootstrap?: BootstrapOptions;
}

type ScoreIndex = Map<string, Map<string, Map<string, number>>>; // criterion -> rater -> sample -> score

export function buildReport(meta: RunMeta, results: readonly ResultRecord[], options: ReportOptions = {}): RunReport {
  const { min, max } = meta.rubric.scale;
  const boot = options.bootstrap;
  const index: ScoreIndex = new Map();
  const raterSet = new Set<string>();

  const resolved = resolveResults(results);
  const failures = resolved.failures.length;

  for (const r of results) raterSet.add(r.rater);
  for (const r of resolved.ok) {
    const byRater = index.get(r.criterionId) ?? new Map();
    const bySample = byRater.get(r.rater) ?? new Map();
    bySample.set(r.sampleId, r.score);
    byRater.set(r.rater, bySample);
    index.set(r.criterionId, byRater);
  }

  const rank = (rater: string): number => (rater === "human" ? -1 : meta.raters.indexOf(rater));
  const raters = [...raterSet].sort((x, y) => rank(x) - rank(y));

  const sampleIds = new Set<string>();
  const criteria: CriterionReport[] = meta.rubric.criteria.map((criterion) => {
    const byRater = index.get(criterion.id) ?? new Map<string, Map<string, number>>();
    const means: Record<string, number | null> = {};
    for (const rater of raters) means[rater] = mean([...(byRater.get(rater)?.values() ?? [])]);

    for (const bySample of byRater.values()) for (const id of bySample.keys()) sampleIds.add(id);

    const pairs: PairStats[] = [];
    for (let i = 0; i < raters.length; i++) {
      for (let j = i + 1; j < raters.length; j++) {
        const left = byRater.get(raters[i]) ?? new Map<string, number>();
        const right = byRater.get(raters[j]) ?? new Map<string, number>();
        const shared = [...left.keys()].filter((id) => right.has(id)).sort();
        const a = shared.map((id) => left.get(id) as number);
        const b = shared.map((id) => right.get(id) as number);
        pairs.push({
          a: raters[i],
          b: raters[j],
          n: shared.length,
          agreement: percentAgreement(a, b),
          kappa: weightedKappa(a, b, min, max, "quadratic"),
          spearman: spearman(a, b),
          ...(boot
            ? {
                kappaCI: bootstrapInterval(a.length, (idx) => weightedKappa(pick(a, idx), pick(b, idx), min, max, "quadratic"), boot),
                spearmanCI: bootstrapInterval(a.length, (idx) => spearman(pick(a, idx), pick(b, idx)), boot),
              }
            : {}),
        });
      }
    }

    const units = [...new Set([...byRater.values()].flatMap((m) => [...m.keys()]))].sort();
    const matrix = raters.map((rater) => units.map((id) => byRater.get(rater)?.get(id)));
    return {
      id: criterion.id,
      weight: criterion.weight,
      means,
      alpha: krippendorffAlphaInterval(matrix),
      ...(boot
        ? {
            alphaCI: bootstrapInterval(
              units.length,
              (idx) => krippendorffAlphaInterval(matrix.map((row) => idx.map((u) => row[u]))),
              boot,
            ),
          }
        : {}),
      pairs,
    };
  });

  const overall: Record<string, number | null> = {};
  for (const rater of raters) {
    const perSample: number[] = [];
    for (const sampleId of sampleIds) {
      let num = 0;
      let den = 0;
      let complete = true;
      for (const criterion of meta.rubric.criteria) {
        const score = index.get(criterion.id)?.get(rater)?.get(sampleId);
        if (score === undefined) {
          complete = false;
          break;
        }
        num += criterion.weight * score;
        den += criterion.weight;
      }
      if (complete) perSample.push(num / den);
    }
    overall[rater] = mean(perSample);
  }

  return {
    runId: meta.id,
    status: meta.status,
    rubric: meta.rubric.name,
    scale: { min, max },
    raters,
    failures,
    criteria,
    overall,
    ...(boot ? { bootstrap: boot } : {}),
  };
}

export const num = (x: number | null): string => (x === null ? "n/a" : x.toFixed(2));
export const pct = (x: number | null): string => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

/** " [low, high]" for an interval, " [n/a]" when it was requested but not trustworthy, "" when not requested. */
export function formatInterval(ci: Interval | null | undefined): string {
  if (ci === undefined) return "";
  return ci === null ? " [n/a]" : ` [${num(ci.low)}, ${num(ci.high)}]`;
}

export const bootstrapNote = (b: BootstrapOptions): string =>
  `[low, high] = ${Math.round(b.confidence * 100)}% percentile bootstrap interval over samples (${b.iterations} resamples, seed ${b.seed}). ` +
  "n/a means the statistic was undefined in too many resamples. With fewer than about 20 samples, treat intervals as rough.";

function renderTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]): string =>
    `  ${cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ")}`;
  return [line(header), ...rows.map(line)];
}

export function formatReport(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`Run ${report.runId} (${report.status})`);
  lines.push(`Rubric: ${report.rubric} (scale ${report.scale.min}..${report.scale.max})`);
  lines.push(`Raters: ${report.raters.join(", ") || "none"}`);
  lines.push(`Unresolved judge failures: ${report.failures}`);

  for (const c of report.criteria) {
    lines.push("", `Criterion: ${c.id} (weight ${c.weight})`);
    lines.push(`  mean score: ${report.raters.map((r) => `${r} ${num(c.means[r])}`).join(" | ")}`);
    lines.push(`  Krippendorff alpha (interval): ${num(c.alpha)}${formatInterval(c.alphaCI)}`);
    if (c.pairs.length > 0) {
      lines.push(
        ...renderTable(
          ["pair", "n", "agree", "kappa", "rho"],
          c.pairs.map((p) => [
            `${p.a} vs ${p.b}`,
            String(p.n),
            pct(p.agreement),
            `${num(p.kappa)}${formatInterval(p.kappaCI)}`,
            `${num(p.spearman)}${formatInterval(p.spearmanCI)}`,
          ]),
        ),
      );
    }
  }

  lines.push("", "Overall weighted score:");
  for (const r of report.raters) lines.push(`  ${r}: ${num(report.overall[r])}`);
  lines.push("", "kappa = quadratic-weighted Cohen's kappa; rho = Spearman; n/a means the statistic is undefined for that data.");
  if (report.bootstrap) lines.push(bootstrapNote(report.bootstrap));
  return `${lines.join("\n")}\n`;
}
