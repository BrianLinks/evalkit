import { describe, expect, it } from "vitest";
import { wilsonInterval } from "../src/stats/proportion.js";

describe("wilsonInterval", () => {
  it("matches the known 95% interval for 8 of 10", () => {
    const ci = wilsonInterval(8, 10);
    expect(ci?.low).toBeCloseTo(0.49, 2);
    expect(ci?.high).toBeCloseTo(0.943, 2);
  });
  it("stays inside [0, 1] at the extremes and is not degenerate", () => {
    const none = wilsonInterval(0, 10);
    const all = wilsonInterval(10, 10);
    expect(none?.low).toBe(0);
    expect(none?.high).toBeGreaterThan(0.2);
    expect(all?.high).toBe(1);
    expect(all?.low).toBeLessThan(0.8);
  });
  it("narrows as the sample grows", () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(500, 1000);
    expect((large?.high ?? 0) - (large?.low ?? 0)).toBeLessThan((small?.high ?? 0) - (small?.low ?? 0));
  });
  it("is null for n = 0 and rejects impossible counts", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(() => wilsonInterval(3, 2)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 2)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 2)).toThrow(RangeError);
  });
});
