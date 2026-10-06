# 0002: File-based run store

Status: accepted

## Context
Runs need to be tracked and compared later. A database would add a dependency and setup for what is, at this size, a few thousand rows per run.

## Decision
Each run is a directory under `.evalkit/` with `meta.json` (inputs, hashes, status, counts) and an append-only `results.jsonl`.

## Consequences
- Nothing to install, and runs are easy to inspect, diff and archive.
- Metadata stores SHA-256 hashes of the rubric and dataset, so a run can be tied to its inputs.
- Appends are single small writes, which is fine for one process. Several processes writing to the same run are not supported.
- Listing scans directories, which is fine for hundreds of runs, not millions.
