import { RubricParseError, formatZodIssues } from "../errors.js";
import { RubricSchema, type Rubric } from "./schema.js";

interface Draft {
  id: string;
  weight: number;
  ask?: string;
  anchors: { score: number; text: string }[];
  line: number;
}

/**
 * Parse the line-based rubric DSL (see docs/adr/0001-line-based-rubric-dsl.md).
 *
 *   rubric Helpfulness
 *   scale 1..5
 *   criterion accuracy weight 2
 *     ask: Is the answer factually correct?
 *     anchor 1: Mostly wrong
 *     anchor 5: Fully correct
 */
export function parseRubric(source: string): Rubric {
  let name: string | undefined;
  let scale = { min: 1, max: 5 };
  const drafts: Draft[] = [];
  let current: Draft | undefined;

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (text === "" || text.startsWith("#")) return;

    if (/^\s/.test(raw)) {
      if (!current) throw new RubricParseError("indented line outside a criterion", line);
      const ask = /^ask:\s*(.+)$/.exec(text);
      const anchor = /^anchor\s+(-?\d+):\s*(.+)$/.exec(text);
      if (ask) {
        if (current.ask !== undefined) throw new RubricParseError(`criterion "${current.id}" has more than one ask`, line);
        current.ask = ask[1];
      } else if (anchor) {
        current.anchors.push({ score: Number(anchor[1]), text: anchor[2] });
      } else {
        throw new RubricParseError(`unrecognised criterion line: ${text}`, line);
      }
      return;
    }

    const rubricLine = /^rubric\s+(.+)$/.exec(text);
    const scaleLine = /^scale\s+(-?\d+)\.\.(-?\d+)$/.exec(text);
    const criterionLine = /^criterion\s+(\S+)(?:\s+weight\s+(\d+(?:\.\d+)?))?$/.exec(text);

    if (rubricLine) {
      if (name !== undefined) throw new RubricParseError("rubric name declared twice", line);
      name = rubricLine[1];
    } else if (scaleLine) {
      scale = { min: Number(scaleLine[1]), max: Number(scaleLine[2]) };
    } else if (criterionLine) {
      current = { id: criterionLine[1], weight: criterionLine[2] === undefined ? 1 : Number(criterionLine[2]), anchors: [], line };
      drafts.push(current);
    } else {
      throw new RubricParseError(`unrecognised directive: ${text}`, line);
    }
  });

  if (name === undefined) throw new RubricParseError("missing `rubric <name>` line");

  const criteria = drafts.map((d) => {
    if (d.ask === undefined) throw new RubricParseError(`criterion "${d.id}" is missing an "ask:" line`, d.line);
    return { id: d.id, weight: d.weight, ask: d.ask, anchors: d.anchors };
  });

  const parsed = RubricSchema.safeParse({ name, scale, criteria });
  if (!parsed.success) throw new RubricParseError(formatZodIssues(parsed.error));
  return parsed.data;
}
