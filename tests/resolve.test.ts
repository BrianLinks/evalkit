import { describe, expect, it } from "vitest";
import { resolveRows } from "../src/resolve.js";
import { resolveResults, type ResultRecord } from "../src/store.js";

type Row = { k: string; v?: number; error?: string };
const isOk = (r: Row): r is Row & { v: number } => r.v !== undefined;

describe("resolveRows", () => {
  it("keeps the latest success per key", () => {
    const { ok } = resolveRows<Row, Row & { v: number }>([{ k: "a", v: 1 }, { k: "a", v: 2 }], (r) => r.k, isOk);
    expect(ok).toEqual([{ k: "a", v: 2 }]);
  });
  it("drops an error once the same key later succeeds", () => {
    const { ok, failures } = resolveRows<Row, Row & { v: number }>([{ k: "a", error: "x" }, { k: "a", v: 3 }], (r) => r.k, isOk);
    expect(ok).toHaveLength(1);
    expect(failures).toEqual([]);
  });
  it("keeps a failure when no success exists, using the latest error", () => {
    const { ok, failures } = resolveRows<Row, Row & { v: number }>(
      [{ k: "a", error: "first" }, { k: "a", error: "second" }, { k: "b", v: 1 }],
      (r) => r.k,
      isOk,
    );
    expect(ok.map((r) => r.k)).toEqual(["b"]);
    expect(failures).toEqual([{ k: "a", error: "second" }]);
  });
  it("does not let a stale error override an existing success", () => {
    const { ok, failures } = resolveRows<Row, Row & { v: number }>([{ k: "a", v: 1 }, { k: "a", error: "late" }], (r) => r.k, isOk);
    expect(ok).toHaveLength(1);
    expect(failures).toEqual([]);
  });
});

describe("resolveResults", () => {
  it("keys on rater, sample and criterion", () => {
    const rows: ResultRecord[] = [
      { sampleId: "s", criterionId: "a", rater: "j1", kind: "judge", score: 1 },
      { sampleId: "s", criterionId: "a", rater: "j2", kind: "judge", score: 2 },
      { sampleId: "s", criterionId: "b", rater: "j1", kind: "judge", error: "boom" },
    ];
    const { ok, failures } = resolveResults(rows);
    expect(ok).toHaveLength(2);
    expect(failures).toHaveLength(1);
  });
});
