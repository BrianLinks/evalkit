import { percentAgreement, weightedKappa } from "../stats/agreement.js";
import { bootstrapInterval, type BootstrapOptions, type Interval } from "../stats/bootstrap.js";
import { wilsonInterval } from "../stats/proportion.js";
import { bootstrapNote, formatInterval } from "../report.js";
import { resolvePairRows, type DecidedPairRow, type PairMeta, type PairRow } from "./store.js";

export type Winner = "A" | "B" | "tie";

export interface FinalDecision {
  winner: Winner;
  /** False when the judge disagreed with itself across the two presentation orders. */
  consistent: boolean;
}

export interface PairRaterStats {
  rater: string;
  /** Pairs with a final verdict for this criterion. */
  n: number;
  aWins: number;
  bWins: number;
  ties: number;
  /** Pairs where the two presentation orders disagreed (counted as ties). Null for humans. */
  inconsistent: number | null;
  /** aWins / (aWins + bWins), ties excluded. */
  aWinRate: number | null;
  aWinCI: { low: number; high: number } | null;
  /** Share of pairs where both orders gave the same verdict. Null for humans. */
  consistency: number | null;
  /** Share of non-tie calls that picked the response shown first. Near 0.5 means no position bias. Null for humans. */
  firstPickRate: number | null;
}

export interface PairAgreement {
  a: string;
  b: string;
  n: number;
  agreement: number | null;
  /** Unweighted Cohen's kappa over the labels A, B, tie. */
  kappa: number | null;
  /** Bootstrap interval over pairs. Present only when requested; null when not trustworthy. */
  kappaCI?: Interval | null;
}

export interface PairCriterionReport {
  id: string;
  raters: PairRaterStats[];
  agreements: PairAgreement[];
}

export interface PairReport {
  runId: string;
  status: PairMeta["status"];
  rubric: string;
  labels: { a: string; b: string };
  raters: string[];
  failures: number;
  criteria: PairCriterionReport[];
  /** Settings used for the intervals, when requested. */
  bootstrap?: BootstrapOptions;
}

export interface PairReportOptions {
  bootstrap?: BootstrapOptions;
}

const LABEL_INDEX: Record<Winner, number> = { A: 0, B: 1, tie: 2 };

/**
 * The final verdict per rater and pair for one criterion. A judge needs a verdict in both orders;
 * if the two disagree the final verdict is a tie and `consistent` is false. A human has one verdict.
 */
export function finalDecisions(
  ok: readonly DecidedPairRow[],
  criterionId: string,
  raters: readonly string[],
): Map<string, Map<string, FinalDecision>> {
  const seen = new Map<string, Map<string, Partial<Record<"AB" | "BA", Winner>>>>();
  for (const row of ok) {
    if (row.criterionId !== criterionId) continue;
    const byPair = seen.get(row.rater) ?? new Map();
    const slot = byPair.get(row.pairId) ?? {};
    slot[row.order ?? "AB"] = row.winner;
    byPair.set(row.pairId, slot);
    seen.set(row.rater, byPair);
  }

  const finals = new Map<string, Map<string, FinalDecision>>();
  for (const rater of raters) {
    const out = new Map<string, FinalDecision>();
    for (const [pairId, slot] of seen.get(rater) ?? []) {
      if (rater === "human") {
        if (slot.AB !== undefined) out.set(pairId, { winner: slot.AB, consistent: true });
      } else if (slot.AB !== undefined && slot.BA !== undefined) {
        out.set(pairId, slot.AB === slot.BA ? { winner: slot.AB, consistent: true } : { winner: "tie", consistent: false });
      }
    }
    finals.set(rater, out);
  }
  return finals;
}

/** Per judge: how many non-tie calls there were and how many picked the response shown first. */
function firstPickCounts(ok: readonly DecidedPairRow[], criterionId: string): Map<string, { first: number; nonTie: number }> {
  const calls = new Map<string, { first: number; nonTie: number }>();
  for (const row of ok) {
    if (row.criterionId !== criterionId || row.kind !== "judge" || row.order === undefined || row.winner === "tie") continue;
    const c = calls.get(row.rater) ?? { first: 0, nonTie: 0 };
    c.nonTie++;
    if ((row.order === "AB" && row.winner === "A") || (row.order === "BA" && row.winner === "B")) c.first++;
    calls.set(row.rater, c);
  }
  return calls;
}

export function buildPairReport(meta: PairMeta, rows: readonly PairRow[], options: PairReportOptions = {}): PairReport {
  const boot = options.bootstrap;
  const resolved = resolvePairRows(rows);
  const raterSet = new Set(rows.map((r) => r.rater));
  const rank = (rater: string): number => (rater === "human" ? -1 : meta.raters.indexOf(rater));
  const raters = [...raterSet].sort((x, y) => rank(x) - rank(y));

  const criteria = meta.rubric.criteria.map((criterion): PairCriterionReport => {
    const finals = finalDecisions(resolved.ok, criterion.id, raters);
    const calls = firstPickCounts(resolved.ok, criterion.id);

    const stats = raters.map((rater): PairRaterStats => {
      const decisions = [...(finals.get(rater)?.values() ?? [])];
      const aWins = decisions.filter((d) => d.winner === "A").length;
      const bWins = decisions.filter((d) => d.winner === "B").length;
      const ties = decisions.filter((d) => d.winner === "tie").length;
      const judge = rater !== "human";
      const inconsistent = judge ? decisions.filter((d) => !d.consistent).length : null;
      const c = calls.get(rater);
      return {
        rater,
        n: decisions.length,
        aWins,
        bWins,
        ties,
        inconsistent,
        aWinRate: aWins + bWins > 0 ? aWins / (aWins + bWins) : null,
        aWinCI: wilsonInterval(aWins, aWins + bWins),
        consistency: judge && decisions.length > 0 ? (decisions.length - (inconsistent ?? 0)) / decisions.length : null,
        firstPickRate: c && c.nonTie > 0 ? c.first / c.nonTie : null,
      };
    });

    const agreements: PairAgreement[] = [];
    for (let i = 0; i < raters.length; i++) {
      for (let j = i + 1; j < raters.length; j++) {
        const left = finals.get(raters[i]) ?? new Map();
        const right = finals.get(raters[j]) ?? new Map();
        const shared = [...left.keys()].filter((id) => right.has(id)).sort();
        const a = shared.map((id) => LABEL_INDEX[left.get(id).winner as Winner]);
        const b = shared.map((id) => LABEL_INDEX[right.get(id).winner as Winner]);
        agreements.push({
          a: raters[i],
          b: raters[j],
          n: shared.length,
          agreement: percentAgreement(a, b),
          kappa: weightedKappa(a, b, 0, 2, "none"),
          ...(boot
            ? { kappaCI: bootstrapInterval(a.length, (idx) => weightedKappa(idx.map((k) => a[k]), idx.map((k) => b[k]), 0, 2, "none"), boot) }
            : {}),
        });
      }
    }
    return { id: criterion.id, raters: stats, agreements };
  });

  return {
    runId: meta.id,
    status: meta.status,
    rubric: meta.rubric.name,
    labels: meta.labels,
    raters,
    failures: resolved.failures.length,
    criteria,
    ...(boot ? { bootstrap: boot } : {}),
  };
}

const num = (x: number | null): string => (x === null ? "n/a" : x.toFixed(2));
const pct = (x: number | null): string => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

export function formatPairReport(report: PairReport): string {
  const lines: string[] = [];
  lines.push(`Pairwise run ${report.runId} (${report.status})`);
  lines.push(`Rubric: ${report.rubric}`);
  lines.push(`A = ${report.labels.a}, B = ${report.labels.b}`);
  lines.push(`Raters: ${report.raters.join(", ") || "none"}`);
  lines.push(`Unresolved judge failures: ${report.failures}`);

  for (const c of report.criteria) {
    lines.push("", `Criterion: ${c.id}`);
    const w = Math.max(5, ...c.raters.map((r) => r.rater.length));
    lines.push(`  ${"rater".padEnd(w)}  ${"n".padStart(3)}  ${"A".padStart(3)}  ${"B".padStart(3)}  ${"tie".padStart(3)}  ${"flip".padStart(4)}  ${"A win rate [95% CI]".padEnd(21)}  ${"consist".padStart(7)}  ${"1st-pick".padStart(8)}`);
    for (const r of c.raters) {
      const ci = r.aWinCI ? `${pct(r.aWinRate)} [${pct(r.aWinCI.low)}-${pct(r.aWinCI.high)}]` : "n/a";
      lines.push(
        `  ${r.rater.padEnd(w)}  ${String(r.n).padStart(3)}  ${String(r.aWins).padStart(3)}  ${String(r.bWins).padStart(3)}  ${String(r.ties).padStart(3)}  ${(r.inconsistent === null ? "-" : String(r.inconsistent)).padStart(4)}  ${ci.padEnd(21)}  ${pct(r.consistency).padStart(7)}  ${pct(r.firstPickRate).padStart(8)}`,
      );
    }
    for (const a of c.agreements) {
      lines.push(`  ${a.a} vs ${a.b}: n=${a.n}, agree ${pct(a.agreement)}, kappa ${num(a.kappa)}${formatInterval(a.kappaCI)}`);
    }
  }
  lines.push(
    "",
    "A win rate = A wins / (A + B wins), ties excluded. flip = pairs where the two presentation orders disagreed (counted as ties).",
    "consist = share of pairs with the same verdict in both orders. 1st-pick = share of non-tie calls that chose the response shown first; far from 50% suggests position bias.",
  );
  if (report.bootstrap) lines.push("", bootstrapNote(report.bootstrap));
  return `${lines.join("\n")}\n`;
}
