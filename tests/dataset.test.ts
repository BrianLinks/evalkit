import { describe, expect, it } from "vitest";
import { parseDataset, validateAgainstRubric } from "../src/dataset.js";
import { parseRubric } from "../src/rubric/parser.js";

const rubric = parseRubric("rubric R\nscale 1..5\ncriterion a\n  ask: q\n");

describe("parseDataset", () => {
  it("parses JSON Lines and skips blank lines", () => {
    const samples = parseDataset('{"id":"1","prompt":"p","response":"r"}\n\n{"id":"2","prompt":"p","response":"r","reference":"x"}\n');
    expect(samples.map((s) => s.id)).toEqual(["1", "2"]);
    expect(samples[1].reference).toBe("x");
  });
  it("names the line for bad JSON or bad shape", () => {
    expect(() => parseDataset('{"id":"1","prompt":"p","response":"r"}\nnot json')).toThrow(/line 2: invalid JSON/);
    expect(() => parseDataset('{"id":"1","prompt":"p"}')).toThrow(/line 1: response/);
  });
  it("rejects duplicate ids and empty datasets", () => {
    const line = '{"id":"1","prompt":"p","response":"r"}';
    expect(() => parseDataset(`${line}\n${line}`)).toThrow(/duplicate sample id "1"/);
    expect(() => parseDataset("\n\n")).toThrow(/no samples/);
  });
});

describe("validateAgainstRubric", () => {
  it("accepts matching human scores", () => {
    const samples = parseDataset('{"id":"1","prompt":"p","response":"r","humanScores":{"a":4}}');
    expect(() => validateAgainstRubric(samples, rubric)).not.toThrow();
  });
  it("rejects unknown criteria and out-of-range scores", () => {
    const unknown = parseDataset('{"id":"1","prompt":"p","response":"r","humanScores":{"zzz":4}}');
    expect(() => validateAgainstRubric(unknown, rubric)).toThrow(/unknown criterion "zzz"/);
    const range = parseDataset('{"id":"1","prompt":"p","response":"r","humanScores":{"a":9}}');
    expect(() => validateAgainstRubric(range, rubric)).toThrow(/outside 1..5/);
  });
});
