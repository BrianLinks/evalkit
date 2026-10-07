/**
 * Wilson score interval for a proportion (default 95%). Better than the plain normal interval
 * for small samples and for proportions near 0 or 1. Null when n is 0.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || successes > n) {
    throw new RangeError(`need integers with 0 <= successes <= n (got ${successes} of ${n})`);
  }
  if (n === 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}
