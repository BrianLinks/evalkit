export interface BootstrapOptions {
  /** Number of resamples. */
  iterations: number;
  /** Confidence level, for example 0.95. */
  confidence: number;
  /** Seed for the random generator, so the same input always gives the same interval. */
  seed: number;
}

export interface Interval {
  /** The statistic on the original data. */
  estimate: number;
  low: number;
  high: number;
  /** How many resamples produced a defined value (the rest were dropped). */
  valid: number;
}

/** Small seeded generator (mulberry32). Returns numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Select `xs[i]` for each index, used to build a resample. */
export function pick<T>(xs: readonly T[], indices: readonly number[]): T[] {
  return indices.map((i) => xs[i]);
}

/** Quantile of an ascending-sorted array with linear interpolation. */
export function quantile(sorted: readonly number[], q: number): number {
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Percentile bootstrap interval. `statistic` receives indices into the n original units
 * (drawn with replacement) and returns the statistic for that resample, or null if it is
 * undefined there. Resampling whole units keeps every rater's scores for a unit together.
 *
 * Returns null when there are fewer than 2 units, when the statistic is undefined on the
 * original data, or when it is undefined in more than half of the resamples (an interval
 * built from the remainder would not be trustworthy).
 */
export function bootstrapInterval(
  n: number,
  statistic: (indices: readonly number[]) => number | null,
  options: BootstrapOptions,
): Interval | null {
  const { iterations, confidence, seed } = options;
  if (!Number.isInteger(iterations) || iterations < 1) throw new RangeError("iterations must be a positive integer");
  if (!(confidence > 0 && confidence < 1)) throw new RangeError("confidence must be between 0 and 1");
  if (n < 2) return null;

  const estimate = statistic(Array.from({ length: n }, (_, i) => i));
  if (estimate === null || !Number.isFinite(estimate)) return null;

  const random = mulberry32(seed);
  const values: number[] = [];
  const indices = new Array<number>(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) indices[i] = Math.floor(random() * n);
    const value = statistic(indices);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  if (values.length < iterations / 2) return null;

  values.sort((x, y) => x - y);
  const tail = (1 - confidence) / 2;
  return { estimate, low: quantile(values, tail), high: quantile(values, 1 - tail), valid: values.length };
}
