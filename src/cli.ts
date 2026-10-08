import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseDataset, readTextFile } from "./dataset.js";
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
              [--bootstrap <n> [--seed <n>]]
  evalkit report <run-id> [--json] [--store <dir>] [--bootstrap <n> [--seed <n>]]
  evalkit runs [--store <dir>]

  evalkit compare run --rubric <file> --pairs <file.jsonl> --judge <spec> [--judge <spec> ...]
                      [--label-a <name>] [--label-b <name>] [--concurrency <n>]
                      [--store <dir>] [--resume <run-id>] [--bootstrap <n> [--seed <n>]]
  evalkit compare report <run-id> [--json] [--store <dir>] [--bootstrap <n> [--seed <n>]]
  evalkit compare list [--store <dir>]

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
  const judges = specs.map((spec) => createJudge(spec, { env: io.env, fetch: io.fetch }));

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
  });
  const { results } = await store.load(meta.id);
  io.out(formatReport(buildReport(meta, results, { bootstrap })));
  return meta.status === "failed" ? 1 : 0;
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
  const judges = specs.map((spec) => createJudge(spec, { env: io.env, fetch: io.fetch }));

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
  });
  const { rows } = await store.load(meta.id);
  io.out(formatPairReport(buildPairReport(meta, rows, { bootstrap })));
  return meta.status === "failed" ? 1 : 0;
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

async function compareCommand(args: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "run":
      return compareRunCommand(rest, io);
    case "report":
      return compareReportCommand(rest, io);
    case "list":
      return compareListCommand(rest, io);
    default:
      throw new UsageError("usage: evalkit compare run|report|list ...");
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

