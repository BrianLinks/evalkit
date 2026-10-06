# Changelog

## 0.1.0 - 2026-10-06

First release.

- Rubric DSL with weights, scale and anchors, validated with zod.
- Judges: Anthropic Messages API, OpenAI Chat Completions, and an offline mock, with retry and timeout.
- Agreement statistics: percent agreement, quadratic-weighted Cohen's kappa, Spearman, Krippendorff's alpha (interval, missing data allowed).
- File-based run tracking with input hashes.
- CLI: `rubric check`, `run`, `runs`, `report` (text or JSON).
