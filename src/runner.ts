import { ConfigError, errorMessage } from "./errors.js";
import { validateAgainstRubric, type Sample } from "./dataset.js";
import type { Judge } from "./judges/types.js";
import type { Rubric } from "./rubric/schema.js";
import { RunStore, sha256, type RunMeta } from "./store.js";

export interface ExecuteOptions {
  rubric: Rubric;
  samples: readonly Sample[];
  judges: readonly Judge[];
  concurrency: number;
  store: RunStore;
  datasetPath: string;
  datasetText: string;
  now?: () => Date;
}

interface Task {
  sample: Sample;
  criterionIndex: number;
  judge: Judge;
}

async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Score every (sample, criterion, judge) combination and record each outcome.
 * A judge failing on one item is recorded as an error row and does not stop the run.
 * Human scores found in the dataset are written as rater "human".
 */
export async function executeRun(options: ExecuteOptions): Promise<RunMeta> {
  const { rubric, samples, judges, store } = options;
  const now = options.now ?? (() => new Date());

  validateAgainstRubric(samples, rubric);
  if (judges.length === 0) throw new ConfigError("at least one judge is required");
  const ids = judges.map((j) => j.id);
  if (new Set(ids).size !== ids.length) throw new ConfigError("the same judge was listed twice");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new ConfigError("concurrency must be a positive integer");

  const meta = await store.create(
    {
      datasetPath: options.datasetPath,
      datasetSha256: sha256(options.datasetText),
      rubricSha256: sha256(JSON.stringify(rubric)),
      rubric,
      raters: ids,
      concurrency: options.concurrency,
    },
    now(),
  );

  const tasks: Task[] = [];
  for (const sample of samples) {
    for (let criterionIndex = 0; criterionIndex < rubric.criteria.length; criterionIndex++) {
      for (const judge of judges) tasks.push({ sample, criterionIndex, judge });
    }
  }

  let failed = 0;
  try {
    for (const sample of samples) {
      for (const [criterionId, score] of Object.entries(sample.humanScores ?? {})) {
        await store.append(meta.id, { sampleId: sample.id, criterionId, rater: "human", kind: "human", score });
      }
    }

    await pool(tasks, options.concurrency, async ({ sample, criterionIndex, judge }) => {
      const criterion = rubric.criteria[criterionIndex];
      const base = { sampleId: sample.id, criterionId: criterion.id, rater: judge.id, kind: "judge" as const };
      try {
        const verdict = await judge.judge({ rubric, criterion, sample });
        const { min, max } = rubric.scale;
        if (!Number.isInteger(verdict.score) || verdict.score < min || verdict.score > max) {
          throw new Error(`judge returned score ${verdict.score}, outside ${min}..${max}`);
        }
        await store.append(meta.id, { ...base, score: verdict.score, rationale: verdict.rationale });
      } catch (e) {
        failed++;
        await store.append(meta.id, { ...base, error: errorMessage(e) });
      }
    });
  } catch (e) {
    await store.finish(meta.id, "failed", { tasks: tasks.length, failed }, now());
    throw e;
  }

  const status = tasks.length > 0 && failed === tasks.length ? "failed" : "completed";
  return store.finish(meta.id, status, { tasks: tasks.length, failed }, now());
}
