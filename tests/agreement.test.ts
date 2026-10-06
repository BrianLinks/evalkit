import { describe, expect, it } from "vitest";
import { krippendorffAlphaInterval, mean, percentAgreement, spearman, weightedKappa } from "../src/stats/agreement.js";

describe("percentAgreement", () => {
  it("counts exact matches", () => {
    expect(percentAgreement([1, 2, 3], [1, 2, 4])).toBeCloseTo(2 / 3);
  });
  it("is null for no items and throws on length mismatch", () => {
    expect(percentAgreement([], [])).toBeNull();
    expect(() => percentAgreement([1], [1, 2])).toThrow(RangeError);
  });
});

describe("weightedKappa", () => {
  it("is 1 for identical ratings", () => {
    expect(weightedKappa([1, 2, 3, 4], [1, 2, 3, 4], 1, 4)).toBeCloseTo(1);
  });
  it("is 0 when agreement equals chance", () => {
    expect(weightedKappa([0, 0, 1, 1], [0, 1, 0, 1], 0, 1, "none")).toBeCloseTo(0);
  });
  it("is negative when raters systematically disagree", () => {
    expect(weightedKappa([1, 2, 1, 2], [2, 1, 2, 1], 1, 2, "none")).toBeLessThan(0);
  });
  it("gives near misses more credit with quadratic weights than with none", () => {
    const a = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
    const b = [2, 2, 3, 4, 5, 1, 2, 3, 4, 4];
    const quadratic = weightedKappa(a, b, 1, 5, "quadratic");
    const none = weightedKappa(a, b, 1, 5, "none");
    expect(quadratic).not.toBeNull();
    expect(quadratic as number).toBeGreaterThan(none as number);
  });
  it("is null when kappa is undefined (both raters constant)", () => {
    expect(weightedKappa([3, 3, 3], [3, 3, 3], 1, 5)).toBeNull();
  });
  it("is null for empty input and rejects out-of-range or non-integer scores", () => {
    expect(weightedKappa([], [], 1, 5)).toBeNull();
    expect(() => weightedKappa([6], [1], 1, 5)).toThrow(/not an integer in 1..5/);
    expect(() => weightedKappa([1.5], [1], 1, 5)).toThrow(RangeError);
  });
});

describe("spearman", () => {
  it("is 1 and -1 for monotone relationships", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
  });
  it("matches the textbook value for a small permutation", () => {
    expect(spearman([1, 2, 3, 4], [1, 3, 2, 4])).toBeCloseTo(0.8);
  });
  it("handles ties with average ranks", () => {
    const rho = spearman([1, 1, 2, 3], [1, 2, 3, 4]);
    expect(rho).not.toBeNull();
    expect(rho as number).toBeGreaterThan(0.8);
  });
  it("is null for constant input or fewer than two items", () => {
    expect(spearman([2, 2, 2], [1, 2, 3])).toBeNull();
    expect(spearman([1], [1])).toBeNull();
  });
});

describe("krippendorffAlphaInterval", () => {
  it("is 1 when raters agree on varied data", () => {
    expect(krippendorffAlphaInterval([[1, 2, 3, 4], [1, 2, 3, 4]])).toBeCloseTo(1);
  });
  it("matches a hand-computed value of -0.5 for two crossed raters", () => {
    expect(krippendorffAlphaInterval([[1, 2], [2, 1]])).toBeCloseTo(-0.5);
  });
  it("ignores units with a single score and tolerates missing data", () => {
    const alpha = krippendorffAlphaInterval([
      [1, 2, 3, undefined],
      [1, 2, undefined, 5],
      [1, 2, 3, 5],
    ]);
    expect(alpha).toBeCloseTo(1);
  });
  it("is null when there is nothing to compare or no variation", () => {
    expect(krippendorffAlphaInterval([[1], [undefined]])).toBeNull();
    expect(krippendorffAlphaInterval([[3, 3], [3, 3]])).toBeNull();
  });
});

describe("mean", () => {
  it("averages and returns null for empty input", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeNull();
  });
});
