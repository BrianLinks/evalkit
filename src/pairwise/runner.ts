import { FatalBreaker, type Halt } from "../breaker.js";
import { ConfigError, errorMessage } from "../errors.js";
import type { PairJudge } from "../judges/types.js";
import { pool } from "../pool.js";
import type { Rubric } from "../rubric/schema.js";
import { sha256 } from "../store.js";
import { validatePairs, type PairSample } from "./dataset.js";
import { PairStore, pairKey, resolvePairRows, type PairMeta } from "./store.js";

export interface PairExecuteOptions {
  rubric: Rubric;
  pairs: readonly PairSample[];
  judges: readonly PairJudge[];
  concurrency: number;
  store: PairStore;
  datasetPath: string;
  datasetText: string;
  labels?: { a: string; b: string };
  resume?: string;
  onStart?: (meta: PairMeta) => void;
  /** Stop sending requests to a judge after this many identical fatal errors in a row. Default 3. */
  haltAfter?: number;
  onHalt?: (halt: Halt) => void;
  now?: () => Date;
}

type Order = "AB" | "BA";
interface Task {
  pair: PairSample;
  criterionIndex: number;
  judge: PairJudge;
  order: Order;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Compare system A and system B on every (pair, criterion) with every judge, showing each judge
 * both orders (A first, then B first). Showing both orders is what lets the report measure position bias.
 * Failures are recorded as error rows. `resume` redoes only the calls that have no verdict yet.
 */
export async function executePairwiseRun(options: PairExecuteOptions): Promise<PairMeta> {
  const { rubric, pairs, judges, store } = options;
  const now = options.now ?? (() => new Date());
  const labels = options.labels ?? { a: "A", b: "B" };

  validatePairs(pairs, rubric);
  if (judges.length === 0) throw new ConfigError("at least one judge is required");
  const ids = judges.map((j) => j.id);
  if (new Set(ids).size !== ids.length) throw new ConfigError("the same judge was listed twice");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new ConfigError("concurrency must be a positive integer");
  const haltAfter = options.haltAfter ?? 3;
  if (!Number.isInteger(haltAfter) || haltAfter < 1) throw new ConfigError("haltAfter must be a positive integer");

  const datasetSha256 = sha256(options.datasetText);
  const rubricSha256 = sha256(JSON.stringify(rubric));
  const total = pairs.length * rubric.criteria.length * judges.length * 2;

  let meta: PairMeta;
  let done = new Set<string>();
  if (options.resume !== undefined) {
    const existing = await store.loadMeta(options.resume);
    if (existing.datasetSha256 !== datasetSha256) {
      throw new ConfigError(`dataset changed since run ${existing.id} started; start a new run instead of resuming`);
    }
    if (existing.rubricSha256 !== rubricSha256) {
      throw new ConfigError(`rubric changed since run ${existing.id} started; start a new run instead of resuming`);
    }
    if (!sameSet(existing.raters, ids)) throw new ConfigError(`judges must match the original run (${existing.raters.join(", ")})`);
    done = new Set(resolvePairRows(await store.loadRows(existing.id)).ok.map(pairKey));
    meta = await store.reopen(existing.id);
  } else {
    meta = await store.create(
      { datasetPath: options.datasetPath, datasetSha256, rubricSha256, rubric, raters: ids, concurrency: options.concurrency, labels },
      now(),
    );
  }
  options.onStart?.(meta);

  const tasks: Task[] = [];
  for (const pair of pairs) {
    for (let criterionIndex = 0; criterionIndex < rubric.criteria.length; criterionIndex++) {
      for (const judge of judges) {
        for (const order of ["AB", "BA"] as const) {
          const key = pairKey({ rater: judge.id, pairId: pair.id, criterionId: rubric.criteria[criterionIndex].id, order });
          if (!done.has(key)) tasks.push({ pair, criterionIndex, judge, order });
        }
      }
    }
  }

  const breaker = new FatalBreaker(haltAfter, options.onHalt);

  try {
    for (const pair of pairs) {
      for (const [criterionId, winner] of Object.entries(pair.human ?? {})) {
        const row = { pairId: pair.id, criterionId, rater: "human", kind: "human" as const, winner };
        if (!done.has(pairKey(row))) await store.append(meta.id, row);
      }
    }

    await pool(tasks, options.concurrency, async ({ pair, criterionIndex, judge, order }) => {
      if (breaker.isHalted(judge.id)) return;
      const criterion = rubric.criteria[criterionIndex];
      const base = { pairId: pair.id, criterionId: criterion.id, rater: judge.id, kind: "judge" as const, order };
      try {
        const first = order === "AB" ? pair.responseA : pair.responseB;
        const second = order === "AB" ? pair.responseB : pair.responseA;
        const verdict = await judge.compare({ rubric, criterion, prompt: pair.prompt, first, second });
        const firstSystem = order === "AB" ? "A" : "B";
        const secondSystem = order === "AB" ? "B" : "A";
        const winner = verdict.winner === "first" ? firstSystem : verdict.winner === "second" ? secondSystem : "tie";
        await store.append(meta.id, { ...base, winner, rationale: verdict.rationale });
        breaker.recordSuccess(judge.id);
      } catch (e) {
        breaker.recordFailure(judge.id, e);
        await store.append(meta.id, { ...base, error: errorMessage(e) });
      }
    });
  } catch (e) {
    await store.finish(meta.id, "failed", { tasks: total, failed: total }, now());
    throw e;
  }

  const resolved = resolvePairRows(await store.loadRows(meta.id));
  const judgeDecided = resolved.ok.filter((r) => r.kind === "judge").length;
  const halted = breaker.halted;
  const status = halted.length > 0 ? "halted" : total > 0 && judgeDecided === 0 ? "failed" : "completed";
  return store.finish(meta.id, status, { tasks: total, failed: total - judgeDecided }, now(), halted);
}
