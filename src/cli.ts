import { parseArgs } from "node:util";
import { parseDataset, readTextFile } from "./dataset.js";
import { EvalKitError, UsageError } from "./errors.js";
import { createJudge } from "./judges/index.js";
import { buildReport, formatReport } from "./report.js";
import { parseRubric } from "./rubric/parser.js";
import { executeRun } from "./runner.js";
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
              [--concurrency <n>] [--store <dir>]
  evalkit report <run-id> [--json] [--store <dir>]
  evalkit runs [--store <dir>]

Judge specs: mock:<name> | anthropic:<model> | openai:<model>
Keys come from ANTHROPIC_API_KEY and OPENAI_API_KEY in the environment.
Runs are stored under .evalkit by default.
`;

const DEFAULT_STORE = ".evalkit";

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
    },
  });
  if (!values.rubric || !values.dataset) throw new UsageError("run needs --rubric and --dataset");
  const specs = values.judge ?? [];
  if (specs.length === 0) throw new UsageError("run needs at least one --judge (for example mock:a)");
  const concurrency = parseConcurrency(values.concurrency ?? "4");

  const rubric = parseRubric(await readTextFile(values.rubric));
  const datasetText = await readTextFile(values.dataset);
  const samples = parseDataset(datasetText);
  const judges = specs.map((spec) => createJudge(spec, { env: io.env, fetch: io.fetch }));

  const store = new RunStore(values.store ?? DEFAULT_STORE);
  const meta = await executeRun({ rubric, samples, judges, concurrency, store, datasetPath: values.dataset, datasetText });
  const { results } = await store.load(meta.id);
  io.out(formatReport(buildReport(meta, results)));
  return meta.status === "failed" ? 1 : 0;
}

async function reportCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean", default: false }, store: { type: "string", default: DEFAULT_STORE } },
  });
  if (positionals.length !== 1) throw new UsageError("usage: evalkit report <run-id> [--json] [--store <dir>]");
  const { meta, results } = await new RunStore(values.store ?? DEFAULT_STORE).load(positionals[0]);
  const report = buildReport(meta, results);
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

