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
});
