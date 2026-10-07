# 0004: Resume by resolving an append-only log

Status: accepted

## Context
Judge calls are slow, cost money and fail for ordinary reasons (rate limits, network drops, a process killed halfway). Losing a run, or restarting it from zero, wastes both. Rewriting result files in place risks corrupting them on a crash.

## Decision
Results are only ever appended, one row per attempt. The current state of a run is derived by resolving the log: for each (rater, item, criterion) the latest successful row wins, and a key with only errors is an unresolved failure. Resuming re-opens the run, skips every key that already has a success, and appends new rows for the rest. Before resuming, the SHA-256 of the dataset and rubric and the judge list must match the original run.

## Consequences
- A crash can lose at most the calls in flight.
- Retrying a failure makes it disappear from the report without deleting history, so the log still shows what happened.
- Files grow with every retry. That is acceptable at this scale.
- Changing the rubric, dataset or judges means a new run. This is deliberate: statistics over mixed inputs would be misleading.
- Resuming two processes against one run is not supported, because appends from two writers could interleave.
