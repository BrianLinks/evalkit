import { describe, expect, it } from "vitest";
import { FatalBreaker, fatalReason } from "../src/breaker.js";
import { HttpError } from "../src/errors.js";

describe("fatalReason", () => {
  it("treats rejected keys, permissions and unknown models as fatal", () => {
    expect(fatalReason(new HttpError("HTTP 401: invalid x-api-key", 401))).toMatch(/authentication failed/);
    expect(fatalReason(new HttpError("HTTP 403: forbidden", 403))).toMatch(/access denied/);
    expect(fatalReason(new HttpError("HTTP 404: model not found", 404))).toMatch(/model name/);
  });

  it("recognises billing and quota problems however they are reported", () => {
    const credit = 'HTTP 400: {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}';
    expect(fatalReason(new HttpError(credit, 400))).toMatch(/billing or quota problem \(HTTP 400\)/);
    expect(fatalReason(new HttpError("HTTP 402: payment required", 402))).toMatch(/billing/);
    expect(fatalReason(new HttpError("HTTP 429: You exceeded your current quota, please check your plan and billing details", 429))).toMatch(/billing/);
    expect(fatalReason(new HttpError("HTTP 429: insufficient_quota", 429))).toMatch(/billing/);
  });

  it("does not treat per-request or transient problems as fatal", () => {
    expect(fatalReason(new HttpError("HTTP 400: prompt is too long", 400))).toBeUndefined();
    expect(fatalReason(new HttpError("HTTP 429: rate limit reached, retry later", 429))).toBeUndefined();
    expect(fatalReason(new HttpError("HTTP 500: upstream billing service hiccup", 500))).toBeUndefined();
    expect(fatalReason(new HttpError("HTTP 503: overloaded", 503))).toBeUndefined();
    expect(fatalReason(new HttpError("request failed before a response arrived (TypeError)"))).toBeUndefined();
    expect(fatalReason(new Error("boom"))).toBeUndefined();
    expect(fatalReason("HTTP 401")).toBeUndefined();
  });
});

describe("FatalBreaker", () => {
  const unauthorized = new HttpError("HTTP 401: nope", 401);
  const forbidden = new HttpError("HTTP 403: nope", 403);

  it("halts a judge after the threshold of identical fatal errors and reports it once", () => {
    const halts: string[] = [];
    const breaker = new FatalBreaker(3, (h) => halts.push(h.judge));
    breaker.recordFailure("a", unauthorized);
    breaker.recordFailure("a", unauthorized);
    expect(breaker.isHalted("a")).toBe(false);
    breaker.recordFailure("a", unauthorized);
    expect(breaker.isHalted("a")).toBe(true);
    breaker.recordFailure("a", unauthorized);
    expect(halts).toEqual(["a"]);
    expect(breaker.halted).toEqual([{ judge: "a", reason: expect.stringContaining("authentication failed") }]);
  });

  it("resets on success, on a non-fatal error, and when the reason changes", () => {
    const breaker = new FatalBreaker(3);
    breaker.recordFailure("a", unauthorized);
    breaker.recordFailure("a", unauthorized);
    breaker.recordSuccess("a");
    breaker.recordFailure("a", unauthorized);
    breaker.recordFailure("a", unauthorized);
    expect(breaker.isHalted("a")).toBe(false);

    breaker.recordFailure("a", new Error("flaky"));
    breaker.recordFailure("a", unauthorized);
    expect(breaker.isHalted("a")).toBe(false);

    const mixed = new FatalBreaker(3);
    mixed.recordFailure("b", unauthorized);
    mixed.recordFailure("b", forbidden);
    mixed.recordFailure("b", unauthorized);
    expect(mixed.isHalted("b")).toBe(false);
  });

  it("keeps judges independent", () => {
    const breaker = new FatalBreaker(2);
    breaker.recordFailure("a", unauthorized);
    breaker.recordFailure("b", unauthorized);
    breaker.recordFailure("a", unauthorized);
    expect(breaker.isHalted("a")).toBe(true);
    expect(breaker.isHalted("b")).toBe(false);
  });

  it("rejects an invalid threshold", () => {
    expect(() => new FatalBreaker(0)).toThrow(RangeError);
    expect(() => new FatalBreaker(1.5)).toThrow(RangeError);
  });
});
