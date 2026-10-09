import { FatalBreaker, type Halt } from "./breaker.js";
import { ConfigError, errorMessage } from "./errors.js";
import { validateAgainstRubric, type Sample } from "./dataset.js";
import type { Judge } from "./judges/types.js";
import { pool } from "./pool.js";
import type { Rubric } from "./rubric/schema.js";
import { RunStore, resolveResults, resultKey, sha256, type RunMeta } from "./store.js";

export interface ExecuteOptions {
  rubric: Rubric;
  samples: readonly Sample[];
  judges: readonly Judge[];
  concurrency: number;
  store: RunStore;
  datasetPath: string;
  datasetText: string;
  /** Run id to continue. The rubric, dataset and judge set must match the original run. */
  resume?: string;
  /** Called once the run exists, before any judge is called. */
  onStart?: (meta: RunMeta) => void;
  /** Stop sending requests to a judge after this many identical fatal errors in a row (bad key, no credit, unknown model). Default 3. */
  haltAfter?: number;
  /** Called when a judge is halted, so a long run can say so immediately. */
  onHalt?: (halt: Halt) => void;
  now?: () => Date;
}

interface Task {
  sample: Sample;
  criterionIndex: number;
  judge: Judge;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Score every (sample, criterion, judge) combination and record each outcome.
 * A judge failing on one item is recorded as an error row and does not stop the run.
 * Human scores found in the dataset are written as rater "human".
 *
 * With `resume`, only work that has no successful result yet is done, so an interrupted run
 * continues where it stopped and earlier failures are retried.
 */
export async function executeRun(options: ExecuteOptions): Promise<RunMeta> {
  const { rubric, samples, judges, store } = options;
  const now = options.now ?? (() => new Date());

  validateAgainstRubric(samples, rubric);
  if (judges.length === 0) throw new ConfigError("at least one judge is required");
  const ids = judges.map((j) => j.id);
  if (new Set(ids).size !== ids.length) throw new ConfigError("the same judge was listed twice");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new ConfigError("concurrency must be a positive integer");
  const haltAfter = options.haltAfter ?? 3;
  if (!Number.isInteger(haltAfter) || haltAfter < 1) throw new ConfigError("haltAfter must be a positive integer");

  const datasetSha256 = sha256(options.datasetText);
  const rubricSha256 = sha256(JSON.stringify(rubric));
  const total = samples.length * rubric.criteria.length * judges.length;

  let meta: RunMeta;
  let done = new Set<string>();
  if (options.resume !== undefined) {
    const existing = await store.loadMeta(options.resume);
    if (existing.datasetSha256 !== datasetSha256) {
      throw new ConfigError(`dataset changed since run ${existing.id} started; start a new run instead of resuming`);
    }
    if (existing.rubricSha256 !== rubricSha256) {
      throw new ConfigError(`rubric changed since run ${existing.id} started; start a new run instead of resuming`);
    }
    if (!sameSet(existing.raters, ids)) {
      throw new ConfigError(`judges must match the original run (${existing.raters.join(", ")})`);
    }
    done = new Set(resolveResults(await store.loadResults(existing.id)).ok.map(resultKey));
    meta = await store.reopen(existing.id);
  } else {
    meta = await store.create(
      { datasetPath: options.datasetPath, datasetSha256, rubricSha256, rubric, raters: ids, concurrency: options.concurrency },
      now(),
    );
  }
  options.onStart?.(meta);

  const tasks: Task[] = [];
  for (const sample of samples) {
    for (let criterionIndex = 0; criterionIndex < rubric.criteria.length; criterionIndex++) {
      for (const judge of judges) {
        const key = resultKey({ rater: judge.id, sampleId: sample.id, criterionId: rubric.criteria[criterionIndex].id });
        if (!done.has(key)) tasks.push({ sample, criterionIndex, judge });
      }
    }
  }

  const breaker = new FatalBreaker(haltAfter, options.onHalt);

  try {
    for (const sample of samples) {
      for (const [criterionId, score] of Object.entries(sample.humanScores ?? {})) {
        if (done.has(resultKey({ rater: "human", sampleId: sample.id, criterionId }))) continue;
        await store.append(meta.id, { sampleId: sample.id, criterionId, rater: "human", kind: "human", score });
      }
    }

    await pool(tasks, options.concurrency, async ({ sample, criterionIndex, judge }) => {
      if (breaker.isHalted(judge.id)) return;
      const criterion = rubric.criteria[criterionIndex];
      const base = { sampleId: sample.id, criterionId: criterion.id, rater: judge.id, kind: "judge" as const };
      try {
        const verdict = await judge.judge({ rubric, criterion, sample });
        const { min, max } = rubric.scale;
        if (!Number.isInteger(verdict.score) || verdict.score < min || verdict.score > max) {
          throw new Error(`judge returned score ${verdict.score}, outside ${min}..${max}`);
        }
        await store.append(meta.id, { ...base, score: verdict.score, rationale: verdict.rationale });
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

  const resolved = resolveResults(await store.loadResults(meta.id));
  const judgeScored = resolved.ok.filter((r) => r.kind === "judge").length;
  const halted = breaker.halted;
  const status = halted.length > 0 ? "halted" : total > 0 && judgeScored === 0 ? "failed" : "completed";
  // Tasks skipped after a halt have no row, so count everything not scored as unfinished.
  return store.finish(meta.id, status, { tasks: total, failed: total - judgeScored }, now(), halted);
}
