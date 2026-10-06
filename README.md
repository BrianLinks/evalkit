# EvalKit

Score LLM outputs against a rubric using LLM judges, then measure how much the judges agree with each other and with human scores.

You write a rubric in a small text format, point EvalKit at a JSONL dataset, and pick one or more judges. EvalKit calls each judge once per sample per criterion, stores every result on disk, and reports agreement statistics (Cohen's kappa, Spearman, Krippendorff's alpha).

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

## Reading the report

For each criterion you get mean score per rater, Krippendorff's alpha across all raters, and for each pair of raters the number of shared samples, exact agreement, quadratic-weighted kappa and Spearman's rho. A statistic that cannot be computed (for example kappa when both raters always give the same score) is shown as `n/a` rather than as a number.

## Limits

- Judge calls do not set a temperature, because some current models reject it. Repeat a run and compare, or use two judges, to see how stable a judge is.
- The Anthropic and OpenAI judges are covered by tests that use a fake `fetch`. They have not been exercised against the live APIs by the author.
- Runs cannot be resumed yet. A failed judge call is recorded as an error row and does not stop the run.

## Development

```sh
npm run lint
npm run typecheck
npm test
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and CI checks them on pull requests. Architecture notes are in [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT, see [LICENSE](LICENSE).
