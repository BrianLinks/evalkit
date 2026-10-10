# 0010: Cache parsed replies, keyed by the full prompt

Status: accepted

## Context
Judge calls are the cost of using EvalKit. Reruns, retries from scratch and datasets that grow all repeat calls whose answer would be the same question again. Resuming covers only the case of an unchanged dataset in an interrupted run.

## Decision
- Cache the raw reply text of a judge call, in a file per entry under `<store>/cache`, keyed by the SHA-256 of the judge id, the kind (score or compare) and the complete system and user prompts.
- Store a reply only after it parsed and validated. A malformed reply or a failed call is never cached, so a retry asks the model again. A cached entry is re-parsed on every use, so it is checked against the rubric again.
- Keep it opt-in with `--cache`.
- Treat any cache read or write failure as a miss. It must never fail an evaluation.

## Consequences
- Because the key is the full prompt, nothing that affects the question can change without changing the key: model, rubric wording, scale, anchors, sample text, order of a pair, and EvalKit's own prompt template. After an upgrade that changes the wording, old entries simply stop matching.
- Weights are not in the prompt, so reweighting a rubric reuses replies, which is correct because they do not change what the judge sees.
- Opt-in avoids silently hiding judge variation, which users measure by repeating runs. The cost is that users must ask for the saving.
- Replies, not prompts, are stored, so the cache holds only what the model said, which can still quote the data. The docs say to treat it like the data.
- One file per entry makes concurrent writers safe (atomic rename) and cleanup simple, at the cost of many small files on very large runs.
- There is no expiry or size limit. `cache clear` is the only management.
