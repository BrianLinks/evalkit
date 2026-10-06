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
| `src/judges/` | `types.ts` defines `Judge`. `prompt.ts` builds the judge prompt and parses replies. `http.ts` is the retrying POST helper. `anthropic.ts`, `openai.ts` and `mock.ts` implement `Judge`. `index.ts` is the factory. |
| `src/runner.ts` | Expands samples × criteria × judges into tasks, runs them through a bounded worker pool, records each outcome. |
| `src/store.ts` | File-based run tracking: `meta.json` plus append-only `results.jsonl` per run. |
| `src/stats/agreement.ts` | Pure functions: percent agreement, weighted kappa, Spearman, Krippendorff's alpha. No I/O. |
| `src/report.ts` | Turns stored results into per-criterion and per-pair statistics, and formats them. |
| `src/cli.ts`, `src/bin.ts` | Argument handling. `main()` takes injected I/O, env and fetch so tests need no process or network. |

## Invariants

- Anything that crosses a boundary (rubric text, dataset lines, judge replies, stored files, API responses) is validated with zod or an explicit check before use.
- One judge failure never aborts a run. It is stored as an error row and counted. A run is marked `failed` only when every task failed.
- Statistics return `null` when they are undefined. Nothing is silently turned into 0.
- Run ids are validated before they touch the filesystem.
- API keys come only from the environment, are never written to results, and are never included in error messages.
- Text from samples is wrapped in tags, and the system prompt tells the judge to treat it as data.

## Extension points

- New provider: implement `Judge` and add a case in `createJudge`.
- New statistic: add a pure function in `src/stats/` and call it from `buildReport`.

Decisions and their reasons are in `docs/adr/`.
