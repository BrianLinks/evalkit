# EvalKit

Score LLM outputs against a rubric using LLM judges, compare two systems head to head, and measure how much the judges agree with each other and with human scores.

You write a rubric in a small text format, point EvalKit at a JSONL dataset, and pick one or more judges. EvalKit calls each judge once per sample per criterion, stores every result on disk, and reports agreement statistics (Cohen's kappa, Spearman, Krippendorff's alpha). Interrupted runs can be resumed, pairwise mode measures judge position bias, agreement statistics can come with bootstrap confidence intervals, a bias check shows whether judges favour longer answers, any run can be exported as a Markdown or HTML report, and an optional cache stops you paying twice for the same judge call.

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

## Stopping early when the provider rejects everything

Some errors mean every further call will fail too: a rejected key (401), no permission (403), an unknown model (404), or a billing or quota problem (no credit). After 3 identical errors of that kind in a row from one judge, EvalKit stops sending requests to that judge, prints why straight away, and marks the run `halted`. Other judges keep going. Nothing is lost: the finished results are saved, and once you fix the cause you continue with `--resume <run-id>` as above, which clears the halt.

```
stopped sending requests to anthropic:claude-sonnet-5-5: billing or quota problem (HTTP 400): add credit or raise the limit
...
HALTED EARLY: anthropic:claude-sonnet-5-5 stopped, billing or quota problem (HTTP 400): add credit or raise the limit
Fix the cause, then continue with: evalkit run ... --resume <run-id>
```

Only provider rejections of the key, model or account count. Rate limits, timeouts, dropped connections, server errors and a bad request for one sample never trigger a halt, and a success or a different error resets the count. A halted run exits with code 1. The threshold is 3 by default; library users can change it with `haltAfter`. See [ADR 0008](docs/adr/0008-halt-on-fatal-errors.md).

## Caching judge calls

Real judge calls cost money and time. Add `--cache` to `run` or `compare run` and EvalKit reuses an earlier reply whenever the request is identical:

```sh
node dist/bin.js run --rubric examples/helpfulness.rubric --dataset examples/sample.jsonl \
  --judge anthropic:<model-id> --cache
```

The summary line on stderr says what happened, for example `cache: 24 reused, 0 new calls`. The two cases where it pays off:
- Running the same evaluation again (a new run, the same rubric, dataset and judge) sends nothing.
- Adding samples to a dataset and starting a new run sends only the new samples. A resumed run requires an unchanged dataset, so for a bigger dataset start a new run with `--cache` instead.

How it works: each reply is stored under `<store>/cache` (default `.evalkit/cache`), keyed by a hash of the judge, whether it was scoring or comparing, and the complete prompts. Changing the model, the rubric text, the scale, a sample, or EvalKit's own prompt wording therefore changes the key, and a stale answer is never reused for a different question. Criterion weights are not part of the prompt, so changing a weight still reuses replies. Only replies that parsed successfully are stored, so a garbled reply or a failed call is always retried. `mock:` judges are free and are not cached.

Things to know:
- It is off by default on purpose. Repeating an identical run is how you measure how much a judge varies, and a cache would hide that by returning the same answers. Leave `--cache` off when you are measuring stability.
- Entries hold the model's reply text, which can quote parts of your data in its rationale. They do not hold your prompts or your API key. Treat the cache folder like your data. `.evalkit/` is git-ignored by default.
- `evalkit cache stats` shows how many entries there are, and `evalkit cache clear` deletes them. Clearing only removes the files EvalKit created.
- Entries never expire and there is no size limit. A cache that cannot be read or written never fails a run, it only saves less.

See [ADR 0010](docs/adr/0010-cache-parsed-replies-by-full-prompt.md).

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

## Checking for length bias

LLM judges often rate longer answers higher. `bias` checks whether yours do, using a run you already have. Pass the original dataset file, because runs do not store response text. EvalKit checks the file is byte-for-byte the one the run used and refuses otherwise.

For a score run:

```sh
node dist/bin.js bias <run-id> --dataset examples/sample.jsonl --bootstrap 1000
```

For each criterion it shows, per rater, the Spearman correlation between response length and score, and for each judge the gap versus the human on the same samples (judge correlation minus human correlation). Longer answers are often genuinely better, so a high correlation alone is not bias. A positive gap means the judge follows length more than people do. A `!` appears only when the bootstrap interval for the gap lies entirely above 0, so it needs `--bootstrap` and human scores in the dataset.

For a pairwise run:

```sh
node dist/bin.js compare bias <run-id> --pairs examples/pairs.jsonl
```

This shows how often the longer response wins, with a Wilson interval, and the same rate restricted to pairs the human called a tie. A judge that picks the longer response well above 50% of the time where the human saw no difference is preferring length. A `!` marks that case (interval above 50%). Pairs whose lengths differ by less than `--min-diff` (default 0.1, meaning 10%) are ignored, and so are ties and pairs where the judge changed its answer between orders.

Both commands take `--unit words` (default) or `--unit chars`. See [ADR 0007](docs/adr/0007-length-bias-against-human-baseline.md).

What this does not tell you:
- It measures length only, not other style effects such as formatting, confidence or politeness.
- A `!` is a warning from a rule, not a proof. It does not correct for running many comparisons, so with several judges and criteria one may appear by chance. Check it against more data before acting on it.
- Without human scores or preferences it can show correlations but cannot separate length bias from real quality differences.
- Small datasets give wide intervals and usually no flag. That is the honest result, not a pass.

## Exporting a report

Turn a run into something you can send to someone who will not read terminal output:

```sh
node dist/bin.js export <run-id> --out report.html
node dist/bin.js export <run-id> --out report.md
node dist/bin.js compare export <run-id> --out comparison.html
```

The format comes from the file extension (`.html` or `.htm` gives HTML, anything else Markdown), or from `--format md|html`. Without `--out` the report is printed to stdout. An existing file is never overwritten unless you pass `--force`.

The report has the run details (id, status, rubric, judges, dataset hash), an overall score table, a section per criterion with agreement statistics, a warning for any judge that was halted early with the exact `--resume` command, and a short "How to read this" note. Add `--bootstrap <n>` for confidence intervals. Add `--dataset <file>` (or `--pairs <file>` for `compare export`) to include the length-bias section; the file must be the exact one the run used.

The HTML is one self-contained file: styles are inline, there are no scripts, no fonts, no images and no external requests, and it carries a Content-Security-Policy that forbids them. It follows the viewer's light or dark setting and prints cleanly. All text from your rubric and data is escaped in both formats. See [ADR 0009](docs/adr/0009-one-document-model-two-renderers.md).

## Reading the report

For each criterion you get mean score per rater, Krippendorff's alpha across all raters, and for each pair of raters the number of shared samples, exact agreement, quadratic-weighted kappa and Spearman's rho. A statistic that cannot be computed (for example kappa when both raters always give the same score) is shown as `n/a` rather than as a number. A failed judge call is shown under "Unresolved judge failures" only if it was never retried successfully.

## Limits

- Judge calls do not set a temperature, because some current models reject it. Repeat a run and compare, or use two judges, to see how stable a judge is.
- The Anthropic and OpenAI judges are covered by tests that use a fake `fetch`. They have not been exercised against the live APIs by the author.
- Pairwise mode compares exactly two systems. Weights in the rubric are ignored there, and there is no overall winner across criteria.
- Early stop is judged from the error text and status code the provider returns. A provider that words a billing error in a way EvalKit does not recognise will simply keep failing as before, and the run will not halt.
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
