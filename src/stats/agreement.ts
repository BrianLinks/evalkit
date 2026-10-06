export type Weighting = "none" | "linear" | "quadratic";

function assertSameLength(a: readonly number[], b: readonly number[]): void {
  if (a.length !== b.length) throw new RangeError(`rating lists differ in length (${a.length} vs ${b.length})`);
}

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Share of items where both raters gave the same score. Null when there are no items. */
export function percentAgreement(a: readonly number[], b: readonly number[]): number | null {
  assertSameLength(a, b);
  if (a.length === 0) return null;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/**
 * Cohen's kappa for two raters on an integer scale [min, max].
 * Quadratic weighting (the default) gives partial credit to near misses, which suits ordinal scores.
 * Returns null when chance disagreement is zero (for example, both raters used one single score),
 * because kappa is undefined there.
 */
export function weightedKappa(
  a: readonly number[],
  b: readonly number[],
  min: number,
  max: number,
  weighting: Weighting = "quadratic",
): number | null {
  assertSameLength(a, b);
  const k = max - min + 1;
  if (!(k >= 2)) throw new RangeError("scale needs at least two categories");
  const n = a.length;
  if (n === 0) return null;

  const index = (v: number): number => {
    if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`score ${v} is not an integer in ${min}..${max}`);
    return v - min;
  };
  const weight = (i: number, j: number): number => {
    if (weighting === "none") return i === j ? 0 : 1;
    const d = Math.abs(i - j) / (k - 1);
    return weighting === "linear" ? d : d * d;
  };

  const observed = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const rows = new Array<number>(k).fill(0);
  const cols = new Array<number>(k).fill(0);
  for (let t = 0; t < n; t++) {
    const i = index(a[t]);
    const j = index(b[t]);
    observed[i][j]++;
    rows[i]++;
    cols[j]++;
  }

  let dObserved = 0;
  let dExpected = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = weight(i, j);
      dObserved += (w * observed[i][j]) / n;
      dExpected += (w * rows[i] * cols[j]) / (n * n);
    }
  }
  if (dExpected === 0) return null;
  return 1 - dObserved / dExpected;
}

function averageRanks(xs: readonly number[]): number[] {
  const order = xs.map((value, index) => ({ value, index })).sort((p, q) => p.value - q.value);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k].index] = rank;
    i = j + 1;
  }
  return ranks;
}

function pearson(x: readonly number[], y: readonly number[]): number | null {
  const mx = mean(x);
  const my = mean(y);
  if (mx === null || my === null) return null;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < x.length; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) ** 2;
    vy += (y[i] - my) ** 2;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/** Spearman rank correlation with average ranks for ties. Null when fewer than 2 items or one side is constant. */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  assertSameLength(a, b);
  if (a.length < 2) return null;
  return pearson(averageRanks(a), averageRanks(b));
}

/**
 * Krippendorff's alpha for interval data. `ratings[r][u]` is rater r's score for unit u,
 * or undefined when that rater skipped the unit. Units with fewer than two scores are ignored.
 * Handles any number of raters and missing data. Returns null when alpha is undefined.
 */
export function krippendorffAlphaInterval(ratings: readonly (readonly (number | undefined)[])[]): number | null {
  const units = ratings.reduce((m, r) => Math.max(m, r.length), 0);
  let n = 0;
  let sum = 0;
  let sumSquares = 0;
  let observedDisagreement = 0;

  for (let u = 0; u < units; u++) {
    const values = ratings.map((r) => r[u]).filter((v): v is number => v !== undefined);
    const m = values.length;
    if (m < 2) continue;
    n += m;
    let pairs = 0;
    for (let i = 0; i < m; i++) {
      sum += values[i];
      sumSquares += values[i] ** 2;
      for (let j = 0; j < m; j++) if (i !== j) pairs += (values[i] - values[j]) ** 2;
    }
    observedDisagreement += pairs / (m - 1);
  }
  if (n < 2) return null;

  const dObserved = observedDisagreement / n;
  // Sum over ordered pairs of (x_i - x_j)^2 equals 2 * (n * sum(x^2) - sum(x)^2).
  const dExpected = (2 * (n * sumSquares - sum * sum)) / (n * (n - 1));
  if (dExpected === 0) return null;
  return 1 - dObserved / dExpected;
}
