import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FileCache } from "./cache.js";
import { assertDatasetMatches, type LengthUnit } from "./bias/length.js";
import { buildPairLengthBias, formatPairLengthBias } from "./bias/pairBias.js";
import { buildLengthBias, formatLengthBias } from "./bias/scoreBias.js";
import { parseDataset, readTextFile } from "./dataset.js";
import { buildPairDocument, buildScoreDocument } from "./export/documents.js";
import { renderHtml } from "./export/html.js";
import { renderMarkdown } from "./export/markdown.js";
import type { ReportDocument } from "./export/model.js";
import { EvalKitError, UsageError } from "./errors.js";
import { createJudge } from "./judges/index.js";
import { parsePairDataset } from "./pairwise/dataset.js";
import { buildPairReport, formatPairReport } from "./pairwise/report.js";
import { executePairwiseRun } from "./pairwise/runner.js";
import { PairStore } from "./pairwise/store.js";
import { buildReport, formatReport } from "./report.js";
import { parseRubric } from "./rubric/parser.js";
import { executeRun } from "./runner.js";
import type { BootstrapOptions } from "./stats/bootstrap.js";
import { RunStore } from "./store.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

const USAGE = `evalkit - score LLM outputs with judges and measure agreement

Usage:
  evalkit rubric check <file>
  evalkit run --rubric <file> --dataset <file.jsonl> --judge <spec> [--judge <spec> ...]
              [--concurrency <n>] [--store <dir>] [--resume <run-id>]
              [--cache] [--bootstrap <n> [--seed <n>]]
  evalkit report <run-id> [--json] [--store <dir>] [--bootstrap <n> [--seed <n>]]
  evalkit runs [--store <dir>]
  evalkit bias <run-id> --dataset <file.jsonl> [--unit words|chars] [--json] [--store <dir>]
               [--bootstrap <n> [--seed <n>]]

  evalkit export <run-id> [--format md|html] [--out <file>] [--force] [--dataset <file.jsonl>]
                 [--unit words|chars] [--store <dir>] [--bootstrap <n> [--seed <n>]]

  evalkit compare run --rubric <file> --pairs <file.jsonl> --judge <spec> [--judge <spec> ...]
                      [--label-a <name>] [--label-b <name>] [--concurrency <n>]
                      [--cache] [--store <dir>] [--resume <run-id>] [--bootstrap <n> [--seed <n>]]
  evalkit compare report <run-id> [--json] [--store <dir>] [--bootstrap <n> [--seed <n>]]
  evalkit compare list [--store <dir>]
  evalkit cache stats|clear [--store <dir>]

  evalkit compare export <run-id> [--format md|html] [--out <file>] [--force] [--pairs <file.jsonl>]
                         [--unit words|chars] [--min-diff <0-1>] [--store <dir>]
  evalkit compare bias <run-id> --pairs <file.jsonl> [--unit words|chars] [--min-diff <0-1>]
                       [--json] [--store <dir>]

--cache reuses earlier judge replies for identical requests (kept under <store>/cache), so a rerun,
or a dataset with a few new samples, only pays for the new calls. Off by default, because reusing
replies hides how much a judge varies between identical runs.

export writes a shareable report (Markdown or one self-contained HTML file) to stdout or --out.
With --dataset (or --pairs for compare export) it also includes the length-bias section.

bias checks whether judges favour longer responses. Pass the original dataset file; it must be the
exact file the run used, because runs do not store response text.

--bootstrap <n> adds 95% bootstrap intervals (n resamples, 100 to 20000) to kappa, rho and alpha.
--seed makes them reproducible (default 1).

An interrupted or partly failed run can be continued with --resume <run-id> and the same
rubric, dataset and judges. Only work without a result yet is redone.

Judge specs: mock:<name> | anthropic:<model> | openai:<model>
Keys come from ANTHROPIC_API_KEY and OPENAI_API_KEY in the environment.
Runs are stored under .evalkit by default.
`;

const DEFAULT_STORE = ".evalkit";

const BOOT_OPTIONS = { bootstrap: { type: "string" }, seed: { type: "string" } } as const;

/** Parse --bootstrap <iterations> and --seed <n>. Returns undefined when intervals were not requested. */
function parseBootstrap(iterations: string | undefined, seed: string | undefined): BootstrapOptions | undefined {
  if (iterations === undefined) {
    if (seed !== undefined) throw new UsageError("--seed only makes sense together with --bootstrap");
    return undefined;
  }
  const n = Number(iterations);
  if (!Number.isInteger(n) || n < 100 || n > 20000) throw new UsageError("--bootstrap must be an integer from 100 to 20000");
  const s = seed === undefined ? 1 : Number(seed);
  if (!Number.isInteger(s) || s < 0 || s > 4294967295) throw new UsageError("--seed must be an integer from 0 to 4294967295");
  return { iterations: n, confidence: 0.95, seed: s };
}

function parseConcurrency(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 32) throw new UsageError("--concurrency must be an integer from 1 to 32");
  return n;
}

async function rubricCommand(args: string[], io: CliIo): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals[0] !== "check" || positionals.length !== 2) throw new UsageError("usage: evalkit rubric check <file>");
  const rubric = parseRubric(await readTextFile(positionals[1]));
  const { min, max } = rubric.scale;
  io.out(`OK: ${rubric.name} - ${rubric.criteria.length} criteria, scale ${min}..${max}\n`);
  for (const c of rubric.criteria) io.out(`  ${c.id} (weight ${c.weight}, ${c.anchors.length} anchors)\n`);
  return 0;
}

async function runCommand(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      rubric: { type: "string" },
      dataset: { type: "string" },
      judge: { type: "string", multiple: true },
      concurrency: { type: "string", default: "4" },
      store: { type: "string", default: DEFAULT_STORE },
      resume: { type: "string" },
      cache: { type: "boolean", default: false },
      ...BOOT_OPTIONS,
    },
  });
  const bootstrap = parseBootstrap(values.bootstrap, values.seed);
  if (!values.rubric || !values.dataset) throw new UsageError("run needs --rubric and --dataset");
  const specs = values.judge ?? [];
  if (specs.length === 0) throw new UsageError("run needs at least one --judge (for example mock:a)");
  const concurrency = parseConcurrency(values.concurrency ?? "4");

  const rubric = parseRubric(await readTextFile(values.rubric));
  const datasetText = await readTextFile(values.dataset);
  const samples = parseDataset(datasetText);
  const cache = values.cache ? new FileCache(join(values.store ?? DEFAULT_STORE, "cache")) : undefined;
  const judges = specs.map((spec) => createJudge(spec, { env: io.env, fetch: io.fetch, cache }));

  const store = new RunStore(values.store ?? DEFAULT_STORE);
  const meta = await executeRun({
    rubric,
    samples,
    judges,
    concurrency,
    store,
    datasetPath: values.dataset,
    datasetText,
    resume: values.resume,
    onStart: (m) => io.err(`run ${m.id} started (if interrupted, continue with --resume ${m.id})\n`),
    onHalt: (h) => io.err(`stopped sending requests to ${h.judge}: ${h.reason}\n`),
  });
  const { results } = await store.load(meta.id);
  io.out(formatReport(buildReport(meta, results, { bootstrap })));
  if (cache) io.err(`cache: ${cache.hits} reused, ${cache.stored} new calls\n`);
  return meta.status === "failed" || meta.status === "halted" ? 1 : 0;
}

async function reportCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean", default: false }, store: { type: "string", default: DEFAULT_STORE }, ...BOOT_OPTIONS },
  });
  if (positionals.length !== 1) throw new UsageError("usage: evalkit report <run-id> [--json] [--store <dir>]");
  const bootstrap = parseBootstrap(values.bootstrap, values.seed);
  const { meta, results } = await new RunStore(values.store ?? DEFAULT_STORE).load(positionals[0]);
  const report = buildReport(meta, results, { bootstrap });
  io.out(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return 0;
}

async function runsCommand(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, allowPositionals: false, options: { store: { type: "string", default: DEFAULT_STORE } } });
  const metas = await new RunStore(values.store ?? DEFAULT_STORE).list();
  if (metas.length === 0) {
    io.out("no runs yet\n");
    return 0;
  }
  for (const m of metas) {
    const failed = m.counts ? `${m.counts.failed}/${m.counts.tasks} failed` : "unfinished";
    io.out(`${m.id}  ${m.status.padEnd(9)}  ${m.rubric.name}  ${m.raters.join(",")}  ${failed}\n`);
  }
  return 0;
}

const pairStore = (dir: string | undefined): PairStore => new PairStore(join(dir ?? DEFAULT_STORE, "pairwise"));

async function compareRunCommand(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      rubric: { type: "string" },
      pairs: { type: "string" },
      judge: { type: "string", multiple: true },
      "label-a": { type: "string", default: "A" },
      "label-b": { type: "string", default: "B" },
      concurrency: { type: "string", default: "4" },
      store: { type: "string", default: DEFAULT_STORE },
      resume: { type: "string" },
      cache: { type: "boolean", default: false },
      ...BOOT_OPTIONS,
    },
  });
  const bootstrap = parseBootstrap(values.bootstrap, values.seed);
  if (!values.rubric || !values.pairs) throw new UsageError("compare run needs --rubric and --pairs");
  const specs = values.judge ?? [];
  if (specs.length === 0) throw new UsageError("compare run needs at least one --judge (for example mock:a)");
  const concurrency = parseConcurrency(values.concurrency ?? "4");

  const rubric = parseRubric(await readTextFile(values.rubric));
  const datasetText = await readTextFile(values.pairs);
  const pairs = parsePairDataset(datasetText);
  const cache = values.cache ? new FileCache(join(values.store ?? DEFAULT_STORE, "cache")) : undefined;
  const judges = specs.map((spec) => createJudge(spec, { env: io.env, fetch: io.fetch, cache }));

  const store = pairStore(values.store);
  const meta = await executePairwiseRun({
    rubric,
    pairs,
    judges,
    concurrency,
    store,
    datasetPath: values.pairs,
    datasetText,
    labels: { a: values["label-a"] ?? "A", b: values["label-b"] ?? "B" },
    resume: values.resume,
    onStart: (m) => io.err(`compare run ${m.id} started (if interrupted, continue with --resume ${m.id})\n`),
    onHalt: (h) => io.err(`stopped sending requests to ${h.judge}: ${h.reason}\n`),
  });
  const { rows } = await store.load(meta.id);
  io.out(formatPairReport(buildPairReport(meta, rows, { bootstrap })));
  if (cache) io.err(`cache: ${cache.hits} reused, ${cache.stored} new calls\n`);
  return meta.status === "failed" || meta.status === "halted" ? 1 : 0;
}

async function compareReportCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean", default: false }, store: { type: "string", default: DEFAULT_STORE }, ...BOOT_OPTIONS },
  });
  if (positionals.length !== 1) throw new UsageError("usage: evalkit compare report <run-id> [--json] [--store <dir>]");
  const bootstrap = parseBootstrap(values.bootstrap, values.seed);
  const { meta, rows } = await pairStore(values.store).load(positionals[0]);
  const report = buildPairReport(meta, rows, { bootstrap });
  io.out(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatPairReport(report));
  return 0;
}

async function compareListCommand(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, allowPositionals: false, options: { store: { type: "string", default: DEFAULT_STORE } } });
  const metas = await pairStore(values.store).list();
  if (metas.length === 0) {
    io.out("no pairwise runs yet\n");
    return 0;
  }
  for (const m of metas) {
    const failed = m.counts ? `${m.counts.failed}/${m.counts.tasks} failed` : "unfinished";
    io.out(`${m.id}  ${m.status.padEnd(9)}  ${m.rubric.name}  ${m.labels.a} vs ${m.labels.b}  ${m.raters.join(",")}  ${failed}\n`);
  }
  return 0;
}

function parseUnit(value: string | undefined): LengthUnit {
  if (value === undefined || value === "words") return "words";
  if (value === "chars") return "chars";
  throw new UsageError("--unit must be words or chars");
}

function parseMinDiff(value: string | undefined): number {
  if (value === undefined) return 0.1;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0 || n >= 1) throw new UsageError("--min-diff must be a number from 0 up to (not including) 1");
  return n;
}

async function biasCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      dataset: { type: "string" },
      unit: { type: "string", default: "words" },
      json: { type: "boolean", default: false },
      store: { type: "string", default: DEFAULT_STORE },
      ...BOOT_OPTIONS,
    },
  });
  if (positionals.length !== 1 || !values.dataset) {
    throw new UsageError("usage: evalkit bias <run-id> --dataset <file.jsonl> [--unit words|chars] [--json] [--store <dir>] [--bootstrap <n> [--seed <n>]]");
  }
  const unit = parseUnit(values.unit);
  const bootstrap = parseBootstrap(values.bootstrap, values.seed);
  const { meta, results } = await new RunStore(values.store ?? DEFAULT_STORE).load(positionals[0]);
  const text = await readTextFile(values.dataset);
  assertDatasetMatches(meta, text);
  const report = buildLengthBias(meta, results, parseDataset(text), { unit, bootstrap });
  io.out(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatLengthBias(report));
  return 0;
}

async function compareBiasCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      pairs: { type: "string" },
      unit: { type: "string", default: "words" },
      "min-diff": { type: "string" },
      json: { type: "boolean", default: false },
      store: { type: "string", default: DEFAULT_STORE },
    },
  });
  if (positionals.length !== 1 || !values.pairs) {
    throw new UsageError("usage: evalkit compare bias <run-id> --pairs <file.jsonl> [--unit words|chars] [--min-diff <0-1>] [--json] [--store <dir>]");
  }
  const unit = parseUnit(values.unit);
  const minDiff = parseMinDiff(values["min-diff"]);
  const { meta, rows } = await pairStore(values.store).load(positionals[0]);
  const text = await readTextFile(values.pairs);
  assertDatasetMatches(meta, text);
  const report = buildPairLengthBias(meta, rows, parsePairDataset(text), { unit, minDiff });
  io.out(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatPairLengthBias(report));
  return 0;
}

function resolveFormat(format: string | undefined, out: string | undefined): "md" | "html" {
  if (format !== undefined) {
    if (format === "md" || format === "html") return format;
    throw new UsageError("--format must be md or html");
  }
  return out !== undefined && /\.html?$/i.test(out) ? "html" : "md";
}

const renderDocument = (doc: ReportDocument, format: "md" | "html"): string => (format === "html" ? renderHtml(doc) : renderMarkdown(doc));

/** Print to stdout, or write to `out`. An existing file is only replaced with --force. */
async function emit(io: CliIo, text: string, out: string | undefined, force: boolean): Promise<void> {
  if (out === undefined) {
    io.out(text);
    return;
  }
  try {
    await writeFile(out, text, { encoding: "utf8", flag: force ? "w" : "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new EvalKitError(`${out} already exists; use --force to overwrite it`);
    throw new EvalKitError(`cannot write ${out}`);
  }
  io.err(`wrote ${out}\n`);
}

async function exportCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      format: { type: "string" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      dataset: { type: "string" },
      unit: { type: "string" },
      store: { type: "string", default: DEFAULT_STORE },
      ...BOOT_OPTIONS,
    },
  });
  if (positionals.length !== 1) {
    throw new UsageError("usage: evalkit export <run-id> [--format md|html] [--out <file>] [--force] [--dataset <file.jsonl>] [--unit words|chars] [--store <dir>] [--bootstrap <n> [--seed <n>]]");
  }
  const format = resolveFormat(values.format, values.out);
  const unit = parseUnit(values.unit);
  if (values.unit !== undefined && values.dataset === undefined) throw new UsageError("--unit only applies together with --dataset");
  const bootstrap = parseBootstrap(values.bootstrap, values.seed);

  const { meta, results } = await new RunStore(values.store ?? DEFAULT_STORE).load(positionals[0]);
  let bias;
  if (values.dataset !== undefined) {
    const text = await readTextFile(values.dataset);
    assertDatasetMatches(meta, text);
    bias = buildLengthBias(meta, results, parseDataset(text), { unit, bootstrap });
  }
  const doc = buildScoreDocument(meta, buildReport(meta, results, { bootstrap }), bias);
  await emit(io, renderDocument(doc, format), values.out, values.force ?? false);
  return 0;
}

async function compareExportCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      format: { type: "string" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      pairs: { type: "string" },
      unit: { type: "string" },
      "min-diff": { type: "string" },
      store: { type: "string", default: DEFAULT_STORE },
      ...BOOT_OPTIONS,
    },
  });
  if (positionals.length !== 1) {
    throw new UsageError("usage: evalkit compare export <run-id> [--format md|html] [--out <file>] [--force] [--pairs <file.jsonl>] [--unit words|chars] [--min-diff <0-1>] [--store <dir>] [--bootstrap <n> [--seed <n>]]");
  }
  const format = resolveFormat(values.format, values.out);
  const unit = parseUnit(values.unit);
  const minDiff = parseMinDiff(values["min-diff"]);
  if ((values.unit !== undefined || values["min-diff"] !== undefined) && values.pairs === undefined) {
    throw new UsageError("--unit and --min-diff only apply together with --pairs");
  }
  const bootstrap = parseBootstrap(values.bootstrap, values.seed);

  const { meta, rows } = await pairStore(values.store).load(positionals[0]);
  let bias;
  if (values.pairs !== undefined) {
    const text = await readTextFile(values.pairs);
    assertDatasetMatches(meta, text);
    bias = buildPairLengthBias(meta, rows, parsePairDataset(text), { unit, minDiff });
  }
  const doc = buildPairDocument(meta, buildPairReport(meta, rows, { bootstrap }), bias);
  await emit(io, renderDocument(doc, format), values.out, values.force ?? false);
  return 0;
}

async function cacheCommand(args: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "stats" && sub !== "clear") throw new UsageError("usage: evalkit cache stats|clear [--store <dir>]");
  const { values } = parseArgs({ args: rest, allowPositionals: false, options: { store: { type: "string", default: DEFAULT_STORE } } });
  const cache = new FileCache(join(values.store ?? DEFAULT_STORE, "cache"));
  if (sub === "clear") {
    io.out(`removed ${await cache.clear()} cache entries\n`);
    return 0;
  }
  const { entries, bytes } = await cache.stats();
  io.out(`cache at ${cache.dir}: ${entries} entries, ${(bytes / 1024).toFixed(1)} KB\n`);
  return 0;
}

async function compareCommand(args: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "run":
      return compareRunCommand(rest, io);
    case "report":
      return compareReportCommand(rest, io);
    case "list":
      return compareListCommand(rest, io);
    case "bias":
      return compareBiasCommand(rest, io);
    case "export":
      return compareExportCommand(rest, io);
    default:
      throw new UsageError("usage: evalkit compare run|report|list|bias|export ...");
  }
}

/** Run the CLI. Returns the process exit code: 0 ok, 1 runtime error, 2 usage error. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "rubric":
        return await rubricCommand(rest, io);
      case "run":
        return await runCommand(rest, io);
      case "report":
        return await reportCommand(rest, io);
      case "runs":
        return await runsCommand(rest, io);
      case "bias":
        return await biasCommand(rest, io);
      case "export":
        return await exportCommand(rest, io);
      case "cache":
        return await cacheCommand(rest, io);
      case "compare":
        return await compareCommand(rest, io);
      case undefined:
        io.err(USAGE);
        return 2;
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      default:
        io.err(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n`);
      return 2;
    }
    if (e instanceof TypeError && (e as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`${e.message}\n`);
      return 2;
    }
    if (e instanceof EvalKitError) {
      io.err(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

