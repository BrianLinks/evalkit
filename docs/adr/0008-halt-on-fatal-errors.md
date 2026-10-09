# 0008: Halt a judge on repeated fatal errors

Status: accepted

## Context
A run makes many independent calls and records each failure without stopping. That is right for transient problems, but some failures cannot recover: no credit, a rejected key, a wrong model name. In a real session, two runs each spent a full set of calls producing 24 identical billing errors, and the final report was a table of "n/a" that hid the cause.

## Decision
Classify an error as fatal only when the provider rejects the key, the model or the account: HTTP 401, 403, 404, 402, and a 400, 402, 403 or 429 whose message mentions billing, credit or quota. After 3 identical fatal errors in a row from one judge, stop sending that judge requests, report the reason immediately, and finish the run with status `halted`. A success or any non-fatal error resets the count. The halted state and reasons are stored in the run, shown in the report with the exact resume command, and cleared when the run is resumed.

## Consequences
- A wrong key or an empty account costs 3 calls instead of the whole run, and the reason is stated rather than inferred.
- Streaks are per judge, so one broken provider does not stop another.
- The classifier depends on provider wording for billing errors. An unrecognised wording degrades to the old behaviour (keep failing, record each error), not to a wrong halt.
- Rate limits and server errors are deliberately excluded, so a busy provider is retried and never halts a run.
- Calls already in flight when the threshold is reached still finish, so with high concurrency slightly more than 3 calls may be sent.
- Tasks skipped after a halt leave no rows. They are counted as unfinished, and `--resume` runs them.
