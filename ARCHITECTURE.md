# Architecture

EvalKit is a small pipeline. Each stage is a module with one job and validated inputs and outputs.

```
rubric text ──► parseRubric ──► Rubric ─┐
dataset.jsonl ─► parseDataset ─► Sample[]┼─► executeRun ──► RunStore (disk)
judge specs ──► createJudge ──► Judge[] ─┘                      │
                                                                ▼
                                          buildReport ◄── load(run id)
                                               │
                                               ▼
                                          formatReport / JSON
```

## Modules

| Path | Responsibility |
| --- | --- |
| `src/rubric/` | `schema.ts` is the zod schema and cross-field rules. `parser.ts` turns the line-based DSL into that schema, with line numbers in errors. |
| `src/dataset.ts` | Parses JSONL samples and checks human scores against the rubric. |
| `src/judges/` | `types.ts` defines `Judge` (score), `PairJudge` (compare) and `Completer` (raw text). `prompt.ts` builds prompts and parses replies for both. `llm.ts` turns any `Completer` into a judge. `http.ts` is the retrying POST helper. `anthropic.ts` and `openai.ts` are completers; `mock.ts` is offline. `index.ts` is the factory. |
| `src/runner.ts` | Expands samples × criteria × judges into tasks, runs them through a bounded worker pool, records each outcome. |
| `src/fileStore.ts` | Generic file-based run store: `meta.json` plus append-only `results.jsonl` per run, validated on every read. |
| `src/store.ts` | `RunStore` for score runs, and `resolveResults`, which collapses the log to its current state (latest success wins). |
| `src/resolve.ts`, `src/pool.ts` | Log resolution shared by both run types, and the bounded worker pool. |
| `src/pairwise/` | Pairwise mode: `dataset.ts`, `store.ts` (`PairStore`), `runner.ts` (both orders per judge), `report.ts` (win rates, position-bias stats, agreement). |
| `src/stats/` | Pure functions, no I/O. `agreement.ts`: percent agreement, weighted kappa, Spearman, Krippendorff's alpha. `proportion.ts`: Wilson interval. `bootstrap.ts`: seeded percentile bootstrap. |
| `src/report.ts` | Turns stored results into per-criterion and per-pair statistics, and formats them. |
| `src/cli.ts`, `src/bin.ts` | Argument handling. `main()` takes injected I/O, env and fetch so tests need no process or network. |

## Invariants

- Anything that crosses a boundary (rubric text, dataset lines, judge replies, stored files, API responses) is validated with zod or an explicit check before use.
- Result files are append-only. The current state of a run is always derived by resolving the log (latest success per key wins), never by editing it.
- One judge failure never aborts a run. It is stored as an error row and counted. A run is marked `failed` only when every task failed.
- Statistics return `null` when they are undefined. Nothing is silently turned into 0. A bootstrap interval is `null` rather than a guess when too many resamples are undefined.
- Randomness is seeded and local to the call, so the same input, flags and seed always produce the same report.
- Run ids are validated before they touch the filesystem.
- API keys come only from the environment, are never written to results, and are never included in error messages.
- Text from samples is wrapped in tags, and the system prompt tells the judge to treat it as data.

## Extension points

- New provider: implement `Completer` (one method) and add a case in `createJudge`. Scoring and pairwise comparison then work for it automatically.
- New statistic: add a pure function in `src/stats/` and call it from `buildReport`.

Decisions and their reasons are in `docs/adr/`.
