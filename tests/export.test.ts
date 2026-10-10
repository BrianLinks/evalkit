import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLengthBias } from "../src/bias/scoreBias.js";
import { buildPairLengthBias } from "../src/bias/pairBias.js";
import { parseDataset } from "../src/dataset.js";
import { buildPairDocument, buildScoreDocument } from "../src/export/documents.js";
import { escapeHtml, renderHtml } from "../src/export/html.js";
import { escapeMarkdown, renderMarkdown } from "../src/export/markdown.js";
import type { ReportDocument } from "../src/export/model.js";
import { mockJudge } from "../src/judges/mock.js";
import { parsePairDataset } from "../src/pairwise/dataset.js";
import { buildPairReport } from "../src/pairwise/report.js";
import { executePairwiseRun } from "../src/pairwise/runner.js";
import { PairStore } from "../src/pairwise/store.js";
import { buildReport } from "../src/report.js";
import { parseRubric } from "../src/rubric/parser.js";
import { executeRun } from "../src/runner.js";
import { RunStore } from "../src/store.js";

const example = (name: string): Promise<string> => readFile(fileURLToPath(new URL(`../examples/${name}`, import.meta.url)), "utf8");

describe("renderMarkdown", () => {
  const doc: ReportDocument = {
    title: "T",
    subtitle: "S",
    facts: [["Run", "r1"]],
    blocks: [
      { type: "heading", level: 2, text: "H" },
      { type: "paragraph", text: "P" },
      { type: "table", header: ["A", "B"], rows: [["x", "1"]] },
      { type: "warning", text: "W" },
      { type: "note", text: "N" },
    ],
  };

  it("produces the expected document", () => {
    expect(renderMarkdown(doc)).toBe(
      ["# T", "", "*S*", "", "- **Run:** r1", "", "## H", "", "P", "", "| A | B |", "| :--- | ---: |", "| x | 1 |", "", "> **Warning:** W", "", "*N*", ""].join("\n"),
    );
  });

  it("escapes characters that change meaning, including pipes and raw HTML", () => {
    expect(escapeMarkdown("a|b *c* _d_ <e> `f` \\g")).toBe("a\\|b \\*c\\* \\_d\\_ \\<e\\> \\`f\\` \\\\g");
    expect(escapeMarkdown("two\nlines")).toBe("two lines");
    const md = renderMarkdown({ title: "x", facts: [], blocks: [{ type: "table", header: ["a|b", "c"], rows: [["<script>", "ok"]] }] });
    expect(md).toContain("| a\\|b | c |");
    expect(md).toContain("| \\<script\\> | ok |");
  });

  it("omits tables with no rows", () => {
    const md = renderMarkdown({ title: "x", facts: [], blocks: [{ type: "table", header: ["a"], rows: [] }, { type: "paragraph", text: "after" }] });
    expect(md).not.toContain("| a |");
    expect(md).toContain("after");
  });
});

describe("renderHtml", () => {
  const hostile: ReportDocument = {
    title: "<script>alert(1)</script>",
    subtitle: 'say "hi" & <b>bye</b>',
    facts: [["<img src=x onerror=alert(1)>", "'quoted'"]],
    blocks: [
      { type: "heading", level: 2, text: "<h2>" },
      { type: "table", header: ['"><svg onload=1>'], rows: [["<td>"]] },
      { type: "warning", text: "<iframe>" },
    ],
  };

  it("escapes every piece of user-controlled text", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
    const html = renderHtml(hostile);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    for (const raw of ["<script>alert", "<img src=x", "<svg onload", "<iframe>", "<b>bye"]) expect(html).not.toContain(raw);
  });

  it("is self-contained: no scripts, no external resources, and a CSP forbidding both", () => {
    const html = renderHtml(hostile);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("renders tables with header and body and skips empty ones", () => {
    const html = renderHtml({
      title: "t", facts: [],
      blocks: [{ type: "table", header: ["Rater", "n"], rows: [["human", "3"]] }, { type: "table", header: ["empty"], rows: [] }],
    });
    expect(html).toContain('<th scope="col">Rater</th>');
    expect(html).toContain("<td>human</td><td>3</td>");
    expect(html).not.toContain("empty");
  });
});

describe("report documents", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "evalkit-export-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function scoreFixture() {
    const rubric = parseRubric(await example("helpfulness.rubric"));
    const datasetText = await example("sample.jsonl");
    const samples = parseDataset(datasetText);
    const store = new RunStore(dir);
    const meta = await executeRun({ rubric, samples, judges: [mockJudge("a"), mockJudge("b")], concurrency: 2, store, datasetPath: "sample.jsonl", datasetText });
    const { results } = await store.load(meta.id);
    return { meta, results, samples };
  }

  it("builds a score document with facts, an overall table and a section per criterion", async () => {
    const { meta, results } = await scoreFixture();
    const doc = buildScoreDocument(meta, buildReport(meta, results));
    expect(doc.title).toBe("EvalKit report: Helpfulness");
    expect(doc.facts.find(([k]) => k === "Run")?.[1]).toBe(meta.id);
    expect(doc.facts.find(([k]) => k === "Judges")?.[1]).toBe("mock:a, mock:b");
    expect(doc.facts.find(([k]) => k === "Dataset")?.[1]).toMatch(/^sample\.jsonl \(sha256 [0-9a-f]{12}\.\.\.\)$/);
    const headings = doc.blocks.filter((b) => b.type === "heading").map((b) => (b as { text: string }).text);
    expect(headings).toEqual(expect.arrayContaining(["Overall weighted score", "Criterion: accuracy (weight 2)", "Criterion: clarity (weight 1)", "How to read this"]));
    const overall = doc.blocks.find((b) => b.type === "table") as { rows: string[][] };
    expect(overall.rows.map((r) => r[0])).toEqual(["human", "mock:a", "mock:b"]);
  });

  it("carries bootstrap intervals and the method note into the document", async () => {
    const { meta, results } = await scoreFixture();
    const boot = { iterations: 200, confidence: 0.95, seed: 1 };
    const md = renderMarkdown(buildScoreDocument(meta, buildReport(meta, results, { bootstrap: boot })));
    expect(md).toMatch(/Krippendorff's alpha \(interval\): -?\d\.\d\d \[/);
    expect(md).toContain("percentile bootstrap");
  });

  it("includes the length-bias section only when asked, and flags appear as warnings", async () => {
    const { meta, results, samples } = await scoreFixture();
    const report = buildReport(meta, results);
    expect(renderMarkdown(buildScoreDocument(meta, report))).not.toContain("Length bias");
    const bias = buildLengthBias(meta, results, samples, { unit: "words" });
    const md = renderMarkdown(buildScoreDocument(meta, report, bias));
    expect(md).toContain("## Length bias (length measured in words)");
    expect(md).toContain("Gap vs human");
    const flagged = { ...bias, criteria: [{ ...bias.criteria[0], raters: bias.criteria[0].raters.map((r) => ({ ...r, flagged: r.rater === "mock:a" })) }] };
    expect(renderMarkdown(buildScoreDocument(meta, report, flagged))).toContain("> **Warning:** mock:a follows response length");
  });

  it("shows a halted run as a warning with the exact resume command", async () => {
    const { meta, results } = await scoreFixture();
    const halted = { ...meta, status: "halted" as const, halted: [{ judge: "mock:b", reason: "authentication failed (HTTP 401): check the API key" }] };
    const text = renderHtml(buildScoreDocument(halted, buildReport(halted, results)));
    expect(text).toContain("mock:b was stopped early: authentication failed");
    expect(text).toContain(`--resume ${meta.id}`);
    expect(text).toContain("<dd>halted</dd>");
  });

  it("keeps Markdown and HTML in step: every cell appears in both", async () => {
    const { meta, results } = await scoreFixture();
    const doc = buildScoreDocument(meta, buildReport(meta, results));
    const md = renderMarkdown(doc);
    const html = renderHtml(doc);
    for (const block of doc.blocks) {
      if (block.type !== "table") continue;
      for (const row of block.rows) for (const cell of row) {
        expect(html).toContain(escapeHtml(cell));
        expect(md).toContain(escapeMarkdown(cell));
      }
    }
  });

  it("produces balanced HTML tags for a full report", async () => {
    const { meta, results, samples } = await scoreFixture();
    const html = renderHtml(buildScoreDocument(meta, buildReport(meta, results), buildLengthBias(meta, results, samples, { unit: "words" })));
    for (const tag of ["table", "thead", "tbody", "tr", "div", "dl", "h2", "h3", "p", "main", "html", "head", "body"]) {
      const opens = (html.match(new RegExp(`<${tag}(\\s[^>]*)?>`, "g")) ?? []).length;
      const closes = (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      expect(opens, tag).toBe(closes);
    }
  });

  it("builds a pairwise document with labels, win-rate tables and optional length bias", async () => {
    const rubric = parseRubric(await example("helpfulness.rubric"));
    const datasetText = await example("pairs.jsonl");
    const pairs = parsePairDataset(datasetText);
    const store = new PairStore(join(dir, "pairwise"));
    const meta = await executePairwiseRun({
      rubric, pairs, judges: [mockJudge("a"), mockJudge("b")], concurrency: 2, store, datasetPath: "pairs.jsonl", datasetText, labels: { a: "baseline", b: "candidate" },
    });
    const { rows } = await store.load(meta.id);
    const report = buildPairReport(meta, rows);
    const plain = renderMarkdown(buildPairDocument(meta, report));
    expect(plain).toContain("# EvalKit pairwise report: Helpfulness");
    expect(plain).toContain("- **Systems:** A = baseline, B = candidate");
    expect(plain).toContain("A win rate [95% CI]");
    expect(plain).not.toContain("Length bias");

    const bias = buildPairLengthBias(meta, rows, pairs, { unit: "words", minDiff: 0.1 });
    const withBias = renderMarkdown(buildPairDocument(meta, report, bias));
    expect(withBias).toContain("Longer response wins [95% CI]");
    expect(withBias).toContain("On pairs the human called a tie");
  });
});
