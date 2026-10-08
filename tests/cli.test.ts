import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli.js";

const example = (name: string): string => fileURLToPath(new URL(`../examples/${name}`, import.meta.url));
const rubric = example("helpfulness.rubric");
const dataset = example("sample.jsonl");
const pairs = example("pairs.jsonl");

let store: string;
beforeEach(async () => {
  store = await mkdtemp(join(tmpdir(), "evalkit-cli-"));
});
afterEach(async () => {
  await rm(store, { recursive: true, force: true });
});

function harness(env: Record<string, string | undefined> = {}, fetchImpl?: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (s) => void out.push(s), err: (s) => void err.push(s), env, fetch: fetchImpl };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

describe("cli", () => {
  it("checks the example rubric", async () => {
    const h = harness();
    expect(await main(["rubric", "check", rubric], h.io)).toBe(0);
    expect(h.out()).toContain("OK: Helpfulness - 3 criteria, scale 1..5");
  });

  it("runs two mock judges against the example dataset, then lists and re-reports the run", async () => {
    const run = harness();
    const code = await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "mock:a", "--judge", "mock:b", "--store", store], run.io);
    expect(code).toBe(0);
    expect(run.out()).toContain("Raters: human, mock:a, mock:b");
    expect(run.out()).toContain("Krippendorff alpha");
    expect(run.out()).toContain("Unresolved judge failures: 0");

    const list = harness();
    expect(await main(["runs", "--store", store], list.io)).toBe(0);
    const runId = list.out().split("  ")[0];
    expect(runId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/);

    const json = harness();
    expect(await main(["report", runId, "--json", "--store", store], json.io)).toBe(0);
    const parsed = JSON.parse(json.out());
    expect(parsed.runId).toBe(runId);
    expect(parsed.criteria).toHaveLength(3);
    expect(parsed.criteria[0].pairs).toHaveLength(3);
  });

  it("serves a real provider through an injected fetch and records failures without crashing", async () => {
    const failing = (async () => new Response("{}", { status: 400 })) as typeof fetch;
    const h = harness({ ANTHROPIC_API_KEY: "k" }, failing);
    const code = await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "anthropic:m", "--store", store], h.io);
    expect(code).toBe(1); // every call failed, so the run is marked failed
    expect(h.out()).toContain("Unresolved judge failures: 24");
  });

  it("exits 2 on usage errors", async () => {
    for (const argv of [[], ["bogus"], ["run"], ["run", "--rubric", rubric, "--dataset", dataset], ["report"], ["run", "--nope"], ["rubric", "check"]]) {
      const h = harness();
      expect(await main(argv, h.io), JSON.stringify(argv)).toBe(2);
      expect(h.err().length).toBeGreaterThan(0);
    }
    const bad = harness();
    expect(await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "mock:a", "--concurrency", "0"], bad.io)).toBe(2);
  });

  it("exits 1 with a clear message for bad inputs, missing keys and unknown runs", async () => {
    const missingFile = harness();
    expect(await main(["rubric", "check", "/no/such/file"], missingFile.io)).toBe(1);
    expect(missingFile.err()).toContain("cannot read file");

    const noKey = harness();
    expect(await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "anthropic:m", "--store", store], noKey.io)).toBe(1);
    expect(noKey.err()).toContain("ANTHROPIC_API_KEY is not set");

    const unknown = harness();
    expect(await main(["report", "nope", "--store", store], unknown.io)).toBe(1);
    expect(unknown.err()).toContain("not found");
  });

  it("says so when there are no runs and prints help", async () => {
    const empty = harness();
    expect(await main(["runs", "--store", join(store, "none")], empty.io)).toBe(0);
    expect(empty.out()).toBe("no runs yet\n");
    const help = harness();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.out()).toContain("Usage:");
  });

  it("resumes a run whose calls all failed, using the same run id", async () => {
    const failing = (async () => new Response("{}", { status: 400 })) as typeof fetch;
    const env = { ANTHROPIC_API_KEY: "k" };
    const first = harness(env, failing);
    expect(await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "anthropic:m", "--store", store], first.io)).toBe(1);
    const runId = /run (\S+) started/.exec(first.err())?.[1] as string;
    expect(runId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    expect(first.err()).toContain(`--resume ${runId}`);

    const healthy = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: '{"score":4,"rationale":"fine"}' }] }), { status: 200 })) as typeof fetch;
    const second = harness(env, healthy);
    const code = await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "anthropic:m", "--store", store, "--resume", runId], second.io);
    expect(code).toBe(0);
    expect(second.out()).toContain(`Run ${runId} (completed)`);
    expect(second.out()).toContain("Unresolved judge failures: 0");

    const list = harness();
    await main(["runs", "--store", store], list.io);
    expect(list.out().trim().split("\n")).toHaveLength(1);
  });

  it("refuses to resume with different judges", async () => {
    const first = harness();
    await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "mock:a", "--store", store], first.io);
    const runId = /run (\S+) started/.exec(first.err())?.[1] as string;
    const second = harness();
    expect(await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "mock:b", "--store", store, "--resume", runId], second.io)).toBe(1);
    expect(second.err()).toContain("judges must match");
  });

  it("runs, lists and re-reports a pairwise comparison with the mock judges", async () => {
    const run = harness();
    const code = await main(
      ["compare", "run", "--rubric", rubric, "--pairs", pairs, "--judge", "mock:a", "--judge", "mock:b", "--label-a", "baseline", "--label-b", "candidate", "--store", store],
      run.io,
    );
    expect(code).toBe(0);
    expect(run.out()).toContain("A = baseline, B = candidate");
    expect(run.out()).toContain("Raters: human, mock:a, mock:b");
    expect(run.out()).toContain("Criterion: accuracy");

    const list = harness();
    expect(await main(["compare", "list", "--store", store], list.io)).toBe(0);
    expect(list.out()).toContain("baseline vs candidate");
    const runId = list.out().split("  ")[0];

    const json = harness();
    expect(await main(["compare", "report", runId, "--json", "--store", store], json.io)).toBe(0);
    const parsed = JSON.parse(json.out());
    expect(parsed.runId).toBe(runId);
    expect(parsed.criteria).toHaveLength(3);
    expect(parsed.labels).toEqual({ a: "baseline", b: "candidate" });

    // score runs and pairwise runs are tracked separately
    const scoreRuns = harness();
    await main(["runs", "--store", store], scoreRuns.io);
    expect(scoreRuns.out()).toBe("no runs yet\n");
  });

  it("gives clear usage errors for compare", async () => {
    for (const argv of [["compare"], ["compare", "nope"], ["compare", "run"], ["compare", "run", "--rubric", rubric, "--pairs", pairs], ["compare", "report"]]) {
      const h = harness();
      expect(await main(argv, h.io), JSON.stringify(argv)).toBe(2);
    }
    const empty = harness();
    expect(await main(["compare", "list", "--store", join(store, "none")], empty.io)).toBe(0);
    expect(empty.out()).toBe("no pairwise runs yet\n");
  });

  it("adds reproducible bootstrap intervals with --bootstrap and --seed", async () => {
    const run = harness();
    await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "mock:a", "--store", store], run.io);
    const runId = /run (\S+) started/.exec(run.err())?.[1] as string;

    const plain = harness();
    await main(["report", runId, "--store", store], plain.io);
    expect(plain.out()).not.toContain("bootstrap");

    const one = harness();
    const two = harness();
    expect(await main(["report", runId, "--bootstrap", "200", "--seed", "5", "--store", store], one.io)).toBe(0);
    await main(["report", runId, "--bootstrap", "200", "--seed", "5", "--store", store], two.io);
    expect(one.out()).toBe(two.out());
    expect(one.out()).toContain("200 resamples, seed 5");

    const json = harness();
    await main(["report", runId, "--bootstrap", "200", "--json", "--store", store], json.io);
    const parsed = JSON.parse(json.out());
    expect(parsed.bootstrap).toEqual({ iterations: 200, confidence: 0.95, seed: 1 });
    expect("alphaCI" in parsed.criteria[0]).toBe(true);
    expect("kappaCI" in parsed.criteria[0].pairs[0]).toBe(true);
  });

  it("accepts --bootstrap on run, compare run and compare report", async () => {
    const run = harness();
    expect(await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "mock:a", "--judge", "mock:b", "--bootstrap", "100", "--store", store], run.io)).toBe(0);
    expect(run.out()).toContain("percentile bootstrap");

    const cmp = harness();
    expect(await main(["compare", "run", "--rubric", rubric, "--pairs", pairs, "--judge", "mock:a", "--judge", "mock:b", "--bootstrap", "100", "--store", store], cmp.io)).toBe(0);
    expect(cmp.out()).toContain("percentile bootstrap");
    const id = /compare run (\S+) started/.exec(cmp.err())?.[1] as string;

    const rep = harness();
    expect(await main(["compare", "report", id, "--bootstrap", "100", "--seed", "9", "--store", store], rep.io)).toBe(0);
    expect(rep.out()).toContain("seed 9");
  });

  it("rejects bad bootstrap settings with a usage error", async () => {
    for (const extra of [["--bootstrap", "5"], ["--bootstrap", "abc"], ["--bootstrap", "99999"], ["--seed", "3"], ["--bootstrap", "200", "--seed", "-1"], ["--bootstrap", "200", "--seed", "1.5"]]) {
      const h = harness();
      const code = await main(["report", "whatever", ...extra, "--store", store], h.io);
      expect(code, extra.join(" ")).toBe(2);
    }
  });
});

