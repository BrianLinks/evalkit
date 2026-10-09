# Changelog

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
