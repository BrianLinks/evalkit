import { describe, expect, it } from "vitest";
import { bootstrapInterval, mulberry32, quantile, type BootstrapOptions } from "../src/stats/bootstrap.js";
import { weightedKappa } from "../src/stats/agreement.js";

const opts: BootstrapOptions = { iterations: 2000, confidence: 0.95, seed: 42 };
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

describe("mulberry32", () => {
  it("is repeatable, in [0, 1), and differs by seed", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(2)()).not.toBe(first[0]);
  });
  it("looks roughly uniform", () => {
    const next = mulberry32(7);
    const draws = Array.from({ length: 10000 }, next);
    expect(mean(draws)).toBeGreaterThan(0.48);
    expect(mean(draws)).toBeLessThan(0.52);
  });
});

describe("quantile", () => {
  it("interpolates between neighbours", () => {
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
  });
});

describe("bootstrapInterval", () => {
  const data = Array.from({ length: 100 }, (_, i) => i + 1);
  const statistic = (idx: readonly number[]): number => mean(idx.map((i) => data[i]));

  it("matches the textbook interval for a mean (about 50.5 +/- 5.7)", () => {
    const ci = bootstrapInterval(data.length, statistic, opts);
    expect(ci?.estimate).toBeCloseTo(50.5);
    expect(ci?.low).toBeGreaterThan(43.5);
    expect(ci?.low).toBeLessThan(46.5);
    expect(ci?.high).toBeGreaterThan(54.5);
    expect(ci?.high).toBeLessThan(57.5);
    expect(ci?.valid).toBe(2000);
  });

  it("is reproducible for a seed and changes with another", () => {
    const a = bootstrapInterval(data.length, statistic, opts);
    expect(bootstrapInterval(data.length, statistic, opts)).toEqual(a);
    expect(bootstrapInterval(data.length, statistic, { ...opts, seed: 43 })).not.toEqual(a);
  });

  it("gets wider at higher confidence and narrower with more data", () => {
    const w = (ci: ReturnType<typeof bootstrapInterval>): number => (ci?.high ?? 0) - (ci?.low ?? 0);
    const c95 = bootstrapInterval(data.length, statistic, opts);
    const c99 = bootstrapInterval(data.length, statistic, { ...opts, confidence: 0.99 });
    expect(w(c99)).toBeGreaterThan(w(c95));
    const big = Array.from({ length: 1000 }, (_, i) => (i % 100) + 1);
    const bigCI = bootstrapInterval(big.length, (idx) => mean(idx.map((i) => big[i])), opts);
    expect(w(bigCI)).toBeLessThan(w(c95));
  });

  it("collapses to a point for constant data", () => {
    const ci = bootstrapInterval(10, () => 3, opts);
    expect(ci).toMatchObject({ estimate: 3, low: 3, high: 3 });
  });

  it("returns null when it cannot be trusted", () => {
    expect(bootstrapInterval(1, () => 1, opts)).toBeNull();
    expect(bootstrapInterval(10, () => null, opts)).toBeNull();
    // defined on the original data but on well under half the resamples
    let call = 0;
    expect(bootstrapInterval(10, () => (call++ === 0 ? 1 : call % 10 === 0 ? 1 : null), opts)).toBeNull();
  });

  it("drops undefined resamples but keeps the rest when most are defined", () => {
    let call = 0;
    const ci = bootstrapInterval(10, () => (call++ % 10 === 5 ? null : 2), { ...opts, iterations: 100 });
    expect(ci?.valid).toBeLessThan(100);
    expect(ci?.valid).toBeGreaterThan(80);
  });

  it("rejects invalid options", () => {
    expect(() => bootstrapInterval(10, () => 1, { ...opts, iterations: 0 })).toThrow(RangeError);
    expect(() => bootstrapInterval(10, () => 1, { ...opts, confidence: 1 })).toThrow(RangeError);
  });

  it("gives a sensible interval for kappa: a point at 1 for perfect agreement, wide for weak agreement", () => {
    const a = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 2, 3];
    const perfect = bootstrapInterval(a.length, (idx) => weightedKappa(idx.map((i) => a[i]), idx.map((i) => a[i]), 1, 5), opts);
    expect(perfect?.low).toBeCloseTo(1);
    expect(perfect?.high).toBeCloseTo(1);

    const b = [2, 2, 5, 4, 1, 1, 3, 3, 4, 2, 2, 5];
    const weak = bootstrapInterval(a.length, (idx) => weightedKappa(idx.map((i) => a[i]), idx.map((i) => b[i]), 1, 5), opts);
    expect(weak).not.toBeNull();
    expect((weak?.high ?? 0) - (weak?.low ?? 0)).toBeGreaterThan(0.4);
    expect(weak?.low).toBeLessThanOrEqual(weak?.estimate ?? 0);
    expect(weak?.high).toBeGreaterThanOrEqual(weak?.estimate ?? 0);
  });
});
