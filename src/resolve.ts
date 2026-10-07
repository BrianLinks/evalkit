/**
 * Collapse an append-only log into its current state. For each key the latest success wins.
 * A key with only errors is a failure (its latest error is kept). A key that failed and was
 * later retried successfully is not a failure, which is what makes resuming a run safe.
 */
export function resolveRows<T, S extends T>(
  rows: readonly T[],
  key: (row: T) => string,
  isOk: (row: T) => row is S,
): { ok: S[]; failures: T[] } {
  const ok = new Map<string, S>();
  const failed = new Map<string, T>();
  for (const row of rows) {
    const k = key(row);
    if (isOk(row)) ok.set(k, row);
    else failed.set(k, row);
  }
  return {
    ok: [...ok.values()],
    failures: [...failed].filter(([k]) => !ok.has(k)).map(([, row]) => row),
  };
}
