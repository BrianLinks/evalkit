# Changelog

## 0.7.0 - 2026-10-10

- Judge reply cache: `--cache` on `run` and `compare run` reuses earlier replies for identical requests, so reruns and datasets with a few new samples only pay for the new calls. Prints `cache: N reused, M new calls`.
- `evalkit cache stats` and `evalkit cache clear`.
- Only successfully parsed replies are cached. The key covers the judge, kind and full prompts, so nothing stale can be reused for a different question. Off by default so repeated runs still reveal judge variation.

## 0.6.0 - 2026-10-10

- Report export: `evalkit export <run-id>` and `evalkit compare export <run-id>` write a shareable report as Markdown or as one self-contained HTML file. Format follows the file extension or `--format`.
- Reports include run details, overall scores, per-criterion agreement tables, halted-run warnings with the resume command, and optional bootstrap intervals and length-bias sections (`--dataset` / `--pairs`).
- Safe by default: all text is escaped, HTML has no scripts or external resources and a restrictive CSP, and an existing output file is only replaced with `--force`.
- Internal: a small document model rendered by two renderers, so both formats always match.

## 0.5.0 - 2026-10-09

- Early stop: after 3 identical fatal errors in a row from a judge (rejected key, no permission, unknown model, billing or quota problem), EvalKit stops sending that judge requests, says why immediately, and marks the run `halted`. Applies to `run` and `compare run`.
- Halted runs show `HALTED EARLY` with the reason and the exact `--resume` command in the report, exit with code 1, and are resumable. Resuming clears the halt.
- New run status `halted` and a `halted` field in run metadata and JSON reports.
- `counts.failed` now counts every task without a result, including tasks skipped after a halt.

## 0.4.1 - 2026-10-09

- Fix: a key containing spaces or non-ASCII characters is now rejected up front with a clear message, instead of failing every call. Leading and trailing whitespace is trimmed.
- Fix: failed requests now report the system error code (for example ENOTFOUND or ECONNRESET) instead of only "network error (TypeError)". The error message itself is never included, because some runtimes put the API key in it.

## 0.4.0 - 2026-10-09

- Length-bias checks: `evalkit bias <run-id> --dataset <file>` for score runs and `evalkit compare bias <run-id> --pairs <file>` for pairwise runs. Both compare judges to the human baseline, flag only on an interval above the null, and refuse a dataset that does not match the run's hash.
- `--unit words|chars` and, for pairwise, `--min-diff`.
- Internal: shared `finalDecisions` helper for pairwise verdicts.

## 0.3.0 - 2026-10-08

- Bootstrap confidence intervals: `--bootstrap <n>` and `--seed <n>` on `run`, `report`, `compare run` and `compare report`. Intervals for kappa, Spearman rho and Krippendorff alpha (kappa in pairwise mode). Shown as `[n/a]` when not trustworthy.
- JSON reports gain `kappaCI`, `spearmanCI`, `alphaCI` and a `bootstrap` block when intervals are requested.
- Spearman ranks small-integer ratings by counting, about 7 times faster on rating-scale data.
- Fix: `report --bootstrap` with a bad value now exits with a usage error before touching the run store.

## 0.2.0 - 2026-10-07

- Resumable runs: `evalkit run --resume <run-id>` continues an interrupted run and retries failed calls. Guarded by hashes of the dataset and rubric and a judge-list check.
- Pairwise comparison: `evalkit compare run|report|list`. Each judge sees both orders; reports win rates with Wilson intervals, order consistency, first-pick rate and judge-versus-human agreement.
- Every provider now supports both scoring and comparison through one `Completer` interface.
- The report line "Failed judge calls" is now "Unresolved judge failures" and no longer counts failures that were later retried successfully.
- Internal: generic `FileStore`, shared `resolveRows` and `pool`.

## 0.1.0 - 2026-10-06

First release.

- Rubric DSL with weights, scale and anchors, validated with zod.
- Judges: Anthropic Messages API, OpenAI Chat Completions, and an offline mock, with retry and timeout.
- Agreement statistics: percent agreement, quadratic-weighted Cohen's kappa, Spearman, Krippendorff's alpha (interval, missing data allowed).
- File-based run tracking with input hashes.
- CLI: `rubric check`, `run`, `runs`, `report` (text or JSON).
