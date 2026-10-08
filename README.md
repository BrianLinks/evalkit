# EvalKit

Score LLM outputs against a rubric using LLM judges, compare two systems head to head, and measure how much the judges agree with each other and with human scores.

You write a rubric in a small text format, point EvalKit at a JSONL dataset, and pick one or more judges. EvalKit calls each judge once per sample per criterion, stores every result on disk, and reports agreement statistics (Cohen's kappa, Spearman, Krippendorff's alpha). Interrupted runs can be resumed, pairwise mode measures judge position bias, and agreement statistics can come with bootstrap confidence intervals.

## Quick start

Requires Node 20 or newer.

```sh
npm ci
npm run build

node dist/bin.js rubric check examples/helpfulness.rubric
node dist/bin.js run \
  --rubric examples/helpfulness.rubric \
  --dataset examples/sample.jsonl \
  --judge mock:a --judge mock:b
node dist/bin.js runs
node dist/bin.js report <run-id> --json
```

The `mock:` judges are offline and score by hash, so their agreement with humans is noise. They exist for demos and tests. For real evaluation use a real judge:

```sh
export ANTHROPIC_API_KEY=...
node dist/bin.js run --rubric examples/helpfulness.rubric --dataset examples/sample.jsonl \
  --judge anthropic:<model-id>
```

Judge specs are `mock:<name>`, `anthropic:<model>` and `openai:<model>`. Keys are read from `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; a missing key fails before any call is made. EvalKit does not load `.env` files.

## Rubric format

```
rubric Helpfulness
scale 1..5

criterion accuracy weight 2
  ask: Is every factual claim in the response correct?
  anchor 1: Contains a clear factual error
  anchor 5: Fully correct
```

`scale` defaults to `1..5` and `weight` to `1`. Anchors are optional and are shown to the judge. `#` starts a comment line. Errors report the line number. See [ADR 0001](docs/adr/0001-line-based-rubric-dsl.md).

## Dataset format

One JSON object per line:

```json
{"id": "mutex", "prompt": "...", "response": "...", "reference": "optional", "humanScores": {"accuracy": 5}}
```

`humanScores` is optional. When present, those scores join the run as a rater called `human`, so the report shows judge-versus-human agreement.

## Resuming a run

Every judge call is saved the moment it finishes. If a run is interrupted, or some calls failed (rate limits, a bad key, a network drop), continue it with the run id that was printed when it started:

```sh
node dist/bin.js run --rubric examples/helpfulness.rubric --dataset examples/sample.jsonl \
  --judge mock:a --resume <run-id>
```

Only work without a successful result is redone, and earlier failures are retried. The rubric, dataset and judge list must be identical to the original run, otherwise EvalKit stops and tells you to start a new run, because mixing results from different inputs would make the statistics meaningless. See [ADR 0004](docs/adr/0004-append-only-log-resume.md).

## Pairwise comparison

Compare two systems (A and B) on the same prompts. Each judge sees every pair twice, once with A first and once with B first, for every rubric criterion. A verdict only counts when both orders agree; otherwise it is recorded as a tie and counted as a flip. That is how EvalKit measures position bias instead of silently absorbing it. See [ADR 0005](docs/adr/0005-pairwise-both-orders.md).

```sh
node dist/bin.js compare run \
  --rubric examples/helpfulness.rubric --pairs examples/pairs.jsonl \
  --judge mock:a --judge mock:b --label-a baseline --label-b candidate
node dist/bin.js compare list
node dist/bin.js compare report <run-id> --json
```

Pair files are JSON Lines. `human` is optional and gives a human preference per criterion:

```json
{"id": "mutex", "prompt": "...", "responseA": "...", "responseB": "...", "human": {"accuracy": "A", "clarity": "tie"}}
```

For each criterion the report shows, per rater, how many pairs A won, B won or tied, the A win rate with a 95% Wilson confidence interval (ties excluded), how consistent the judge was across the two orders, and how often it picked whichever response it saw first. A first-pick rate far from 50% suggests position bias. It also shows agreement and Cohen's kappa between each pair of raters. Pairwise runs are stored separately under `.evalkit/pairwise/` and are resumable the same way.

## Confidence intervals

Agreement numbers from a small dataset are noisy. Add `--bootstrap <n>` to `run`, `report`, `compare run` or `compare report` to get a 95% interval next to kappa, Spearman's rho and Krippendorff's alpha (kappa only in pairwise mode):

```sh
node dist/bin.js report <run-id> --bootstrap 1000 --seed 1
```

```
  pair              n  agree                kappa                  rho
  human vs mock:a   8    13%    0.41 [0.05, 0.60]    0.72 [0.43, 1.00]
  human vs mock:b   8    13%   0.07 [-0.33, 0.54]   0.02 [-0.74, 0.70]
```

How it works: EvalKit draws `n` resamples (100 to 20000) of your samples with replacement, recomputes the statistic on each, and reports the 2.5th and 97.5th percentiles. A sample is resampled with all of its raters' scores together, so the structure of the data is kept. `--seed` (default 1) makes the result reproducible. See [ADR 0006](docs/adr/0006-percentile-bootstrap.md).

Things to know:
- An interval shows `[n/a]` when it cannot be trusted: fewer than 2 samples, the statistic is undefined on your data, or it is undefined in more than half of the resamples (for example kappa when a rater uses one score almost everywhere).
- These are plain percentile intervals with no bias correction. With fewer than about 20 samples they can be too narrow, so treat them as rough. A wide interval is the honest answer on a small dataset.
- Cost grows with resamples and samples. In one test, 1000 resamples over 3,000 samples, 3 criteria and 3 raters took about 4 seconds.
- Win rates in pairwise mode already use Wilson intervals and are unaffected by this flag.

## Reading the report

For each criterion you get mean score per rater, Krippendorff's alpha across all raters, and for each pair of raters the number of shared samples, exact agreement, quadratic-weighted kappa and Spearman's rho. A statistic that cannot be computed (for example kappa when both raters always give the same score) is shown as `n/a` rather than as a number. A failed judge call is shown under "Unresolved judge failures" only if it was never retried successfully.

## Limits

- Judge calls do not set a temperature, because some current models reject it. Repeat a run and compare, or use two judges, to see how stable a judge is.
- The Anthropic and OpenAI judges are covered by tests that use a fake `fetch`. They have not been exercised against the live APIs by the author.
- Pairwise mode compares exactly two systems. Weights in the rubric are ignored there, and there is no overall winner across criteria.
- A resumed run must use the same judges. Adding a judge to an existing run is not supported.
- Two processes writing to the same run at once is not supported.

## Development

```sh
npm run lint
npm run typecheck
npm test
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and CI checks them on pull requests. Architecture notes are in [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT, see [LICENSE](LICENSE).
