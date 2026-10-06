import { describe, expect, it } from "vitest";
import { parseRubric } from "../src/rubric/parser.js";
import { RubricParseError } from "../src/errors.js";

const VALID = `# demo rubric
rubric Helpfulness
scale 1..5

criterion accuracy weight 2
  ask: Is the answer factually correct?
  anchor 1: Mostly wrong
  anchor 5: Fully correct

criterion clarity
  ask: Is it easy to follow?
`;

describe("parseRubric", () => {
  it("parses name, scale, weights, asks and anchors", () => {
    const rubric = parseRubric(VALID);
    expect(rubric.name).toBe("Helpfulness");
    expect(rubric.scale).toEqual({ min: 1, max: 5 });
    expect(rubric.criteria).toHaveLength(2);
    expect(rubric.criteria[0]).toEqual({
      id: "accuracy",
      weight: 2,
      ask: "Is the answer factually correct?",
      anchors: [
        { score: 1, text: "Mostly wrong" },
        { score: 5, text: "Fully correct" },
      ],
    });
  });

  it("defaults weight to 1 and the scale to 1..5", () => {
    const rubric = parseRubric("rubric R\ncriterion a\n  ask: q\n");
    expect(rubric.criteria[0].weight).toBe(1);
    expect(rubric.scale).toEqual({ min: 1, max: 5 });
  });

  it("accepts windows line endings and decimal weights", () => {
    const rubric = parseRubric("rubric R\r\ncriterion a weight 1.5\r\n  ask: q\r\n");
    expect(rubric.criteria[0].weight).toBe(1.5);
  });

  it("reports the line number for unknown directives", () => {
    expect(() => parseRubric("rubric R\nbogus thing\n")).toThrow(/line 2: unrecognised directive/);
  });

  it("rejects indented lines outside a criterion", () => {
    expect(() => parseRubric("rubric R\n  ask: q\n")).toThrow(/line 2: indented line outside a criterion/);
  });

  it("rejects a missing rubric name", () => {
    expect(() => parseRubric("criterion a\n  ask: q\n")).toThrow(/missing `rubric <name>`/);
  });

  it("rejects a criterion without an ask", () => {
    expect(() => parseRubric("rubric R\ncriterion a\n")).toThrow(/line 2: criterion "a" is missing/);
  });

  it("rejects two asks on one criterion", () => {
    expect(() => parseRubric("rubric R\ncriterion a\n  ask: one\n  ask: two\n")).toThrow(/more than one ask/);
  });

  it("rejects duplicate criterion ids", () => {
    const src = "rubric R\ncriterion a\n  ask: q\ncriterion a\n  ask: q\n";
    expect(() => parseRubric(src)).toThrow(/duplicate criterion id "a"/);
  });

  it("rejects anchors outside the scale and duplicate anchors", () => {
    expect(() => parseRubric("rubric R\nscale 1..3\ncriterion a\n  ask: q\n  anchor 5: x\n")).toThrow(/outside the scale 1..3/);
    expect(() => parseRubric("rubric R\ncriterion a\n  ask: q\n  anchor 1: x\n  anchor 1: y\n")).toThrow(/duplicate anchor 1/);
  });

  it("rejects an empty or inverted scale and a rubric with no criteria", () => {
    expect(() => parseRubric("rubric R\nscale 3..3\ncriterion a\n  ask: q\n")).toThrow(/greater than min/);
    expect(() => parseRubric("rubric R\n")).toThrow(/at least one criterion/);
  });

  it("rejects ids that are not safe identifiers", () => {
    expect(() => parseRubric("rubric R\ncriterion 9lives\n  ask: q\n")).toThrow(RubricParseError);
  });
});
