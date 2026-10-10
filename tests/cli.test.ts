import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("runs the length-bias check on a score run and refuses a different dataset", async () => {
    const run = harness();
    await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "mock:a", "--judge", "mock:b", "--store", store], run.io);
    const runId = /run (\S+) started/.exec(run.err())?.[1] as string;

    const bias = harness();
    expect(await main(["bias", runId, "--dataset", dataset, "--store", store], bias.io)).toBe(0);
    expect(bias.out()).toContain(`Length bias for run ${runId} (length measured in words)`);
    expect(bias.out()).toContain("rho(length, score)");
    expect(bias.out()).toContain("gap vs human");

    const chars = harness();
    expect(await main(["bias", runId, "--dataset", dataset, "--unit", "chars", "--bootstrap", "100", "--store", store], chars.io)).toBe(0);
    expect(chars.out()).toContain("measured in chars");
    expect(chars.out()).toContain("percentile bootstrap");

    const json = harness();
    await main(["bias", runId, "--dataset", dataset, "--json", "--store", store], json.io);
    const parsed = JSON.parse(json.out());
    expect(parsed.unit).toBe("words");
    expect(parsed.hasHuman).toBe(true);
    expect(parsed.criteria).toHaveLength(3);

    const wrong = harness();
    expect(await main(["bias", runId, "--dataset", pairs, "--store", store], wrong.io)).toBe(1);
    expect(wrong.err()).toContain("not the dataset run");
  });

  it("runs the length-bias check on a pairwise run", async () => {
    const run = harness();
    await main(["compare", "run", "--rubric", rubric, "--pairs", pairs, "--judge", "mock:a", "--store", store], run.io);
    const runId = /compare run (\S+) started/.exec(run.err())?.[1] as string;

    const bias = harness();
    expect(await main(["compare", "bias", runId, "--pairs", pairs, "--min-diff", "0.2", "--store", store], bias.io)).toBe(0);
    expect(bias.out()).toContain(`Length bias for pairwise run ${runId}`);
    expect(bias.out()).toContain("longer response wins");
    expect(bias.out()).toContain("at least 20%");

    const wrong = harness();
    expect(await main(["compare", "bias", runId, "--pairs", dataset, "--store", store], wrong.io)).toBe(1);
  });

  it("gives usage errors for the bias commands and checks flags before reading the store", async () => {
    for (const argv of [
      ["bias"], ["bias", "x"], ["bias", "x", "--dataset", dataset, "--unit", "lines"], ["bias", "x", "--dataset", dataset, "--bootstrap", "5"],
      ["compare", "bias", "x"], ["compare", "bias", "x", "--pairs", pairs, "--unit", "lines"],
      ["compare", "bias", "x", "--pairs", pairs, "--min-diff", "1"], ["compare", "bias", "x", "--pairs", pairs, "--min-diff", "abc"],
      ["compare", "bias", "x", "--pairs", pairs, "--min-diff", "-0.1"],
    ]) {
      const h = harness();
      expect(await main([...argv, "--store", store], h.io), argv.join(" ")).toBe(2);
    }
    const unknown = harness();
    expect(await main(["bias", "nope", "--dataset", dataset, "--store", store], unknown.io)).toBe(1);
    expect(unknown.err()).toContain("not found");
  });

  it("stops early and says why when the API rejects the key, then finishes after a resume", async () => {
    let calls = 0;
    const unauthorized = (async () => {
      calls++;
      return new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 });
    }) as typeof fetch;
    const env = { ANTHROPIC_API_KEY: "k" };
    const first = harness(env, unauthorized);
    const args = ["run", "--rubric", rubric, "--dataset", dataset, "--judge", "anthropic:m", "--concurrency", "1", "--store", store];
    expect(await main(args, first.io)).toBe(1);
    expect(calls).toBe(3); // 24 calls were planned; the run gave up after 3
    expect(first.err()).toContain("stopped sending requests to anthropic:m: authentication failed");
    expect(first.out()).toContain("(halted)");
    expect(first.out()).toContain("HALTED EARLY");
    const runId = /run (\S+) started/.exec(first.err())?.[1] as string;
    expect(first.out()).toContain(`--resume ${runId}`);

    const healthy = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: '{"score":4,"rationale":"ok"}' }] }), { status: 200 })) as typeof fetch;
    const second = harness(env, healthy);
    expect(await main([...args, "--resume", runId], second.io)).toBe(0);
    expect(second.out()).toContain(`Run ${runId} (completed)`);
    expect(second.out()).not.toContain("HALTED");
  });

  it("applies the same early stop to pairwise runs", async () => {
    let calls = 0;
    const noCredit = (async () => {
      calls++;
      return new Response('{"error":{"message":"Your credit balance is too low to access the API."}}', { status: 400 });
    }) as typeof fetch;
    const h = harness({ OPENAI_API_KEY: "k" }, noCredit);
    const code = await main(["compare", "run", "--rubric", rubric, "--pairs", pairs, "--judge", "openai:m", "--concurrency", "1", "--store", store], h.io);
    expect(code).toBe(1);
    expect(calls).toBe(3);
    expect(h.err()).toContain("billing or quota problem");
    expect(h.out()).toContain("HALTED EARLY");
  });

  describe("export", () => {
    async function scoreRun(): Promise<string> {
      const run = harness();
      await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "mock:a", "--judge", "mock:b", "--store", store], run.io);
      return /run (\S+) started/.exec(run.err())?.[1] as string;
    }

    it("prints Markdown to stdout by default", async () => {
      const runId = await scoreRun();
      const h = harness();
      expect(await main(["export", runId, "--store", store], h.io)).toBe(0);
      expect(h.out()).toContain("# EvalKit report: Helpfulness");
      expect(h.out()).toContain("| Rater | Score |");
      expect(h.out()).toContain(`- **Run:** ${runId}`);
    });

    it("writes self-contained HTML to a file and infers the format from the extension", async () => {
      const runId = await scoreRun();
      const out = join(store, "report.html");
      const h = harness();
      expect(await main(["export", runId, "--out", out, "--store", store], h.io)).toBe(0);
      expect(h.out()).toBe("");
      expect(h.err()).toContain(`wrote ${out}`);
      const html = await readFile(out, "utf8");
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain("Content-Security-Policy");
      expect(html).not.toMatch(/<script/i);
    });

    it("lets --format override the extension", async () => {
      const runId = await scoreRun();
      const out = join(store, "report.html");
      await main(["export", runId, "--out", out, "--format", "md", "--store", store], harness().io);
      expect((await readFile(out, "utf8")).startsWith("# EvalKit report")).toBe(true);
    });

    it("refuses to overwrite an existing file unless --force is given", async () => {
      const runId = await scoreRun();
      const out = join(store, "report.md");
      await writeFile(out, "OLD");
      const refused = harness();
      expect(await main(["export", runId, "--out", out, "--store", store], refused.io)).toBe(1);
      expect(refused.err()).toContain("--force");
      expect(await readFile(out, "utf8")).toBe("OLD");

      expect(await main(["export", runId, "--out", out, "--force", "--store", store], harness().io)).toBe(0);
      expect((await readFile(out, "utf8")).startsWith("# EvalKit report")).toBe(true);
    });

    it("reports a path it cannot write", async () => {
      const runId = await scoreRun();
      const h = harness();
      expect(await main(["export", runId, "--out", join(store, "no-such-dir", "r.md"), "--store", store], h.io)).toBe(1);
      expect(h.err()).toContain("cannot write");
    });

    it("adds length bias and bootstrap intervals when asked, and refuses the wrong dataset", async () => {
      const runId = await scoreRun();
      const h = harness();
      expect(await main(["export", runId, "--dataset", dataset, "--unit", "chars", "--bootstrap", "100", "--store", store], h.io)).toBe(0);
      expect(h.out()).toContain("## Length bias (length measured in chars)");
      expect(h.out()).toContain("percentile bootstrap");
      const wrong = harness();
      expect(await main(["export", runId, "--dataset", pairs, "--store", store], wrong.io)).toBe(1);
      expect(wrong.err()).toContain("not the dataset run");
    });

    it("exports a pairwise run, with length bias when --pairs is given", async () => {
      const run = harness();
      await main(["compare", "run", "--rubric", rubric, "--pairs", pairs, "--judge", "mock:a", "--store", store], run.io);
      const runId = /compare run (\S+) started/.exec(run.err())?.[1] as string;

      const plain = harness();
      expect(await main(["compare", "export", runId, "--store", store], plain.io)).toBe(0);
      expect(plain.out()).toContain("# EvalKit pairwise report: Helpfulness");
      expect(plain.out()).not.toContain("Length bias");

      const out = join(store, "pairs.html");
      expect(await main(["compare", "export", runId, "--pairs", pairs, "--min-diff", "0.2", "--out", out, "--store", store], harness().io)).toBe(0);
      const html = await readFile(out, "utf8");
      expect(html).toContain("Longer response wins [95% CI]");
      expect(html).toContain("at least 20%");
    });

    it("gives usage errors before reading the store, and a clear error for an unknown run", async () => {
      for (const argv of [
        ["export"], ["export", "x", "--format", "pdf"], ["export", "x", "--unit", "chars"], ["export", "x", "--bootstrap", "5"],
        ["compare", "export"], ["compare", "export", "x", "--format", "pdf"], ["compare", "export", "x", "--min-diff", "0.2"],
        ["compare", "export", "x", "--unit", "chars"],
      ]) {
        expect(await main([...argv, "--store", store], harness().io), argv.join(" ")).toBe(2);
      }
      const unknown = harness();
      expect(await main(["export", "nope", "--store", store], unknown.io)).toBe(1);
      expect(unknown.err()).toContain("not found");
    });
  });

  describe("cache", () => {
    const anthropicOk = (): { fetch: typeof fetch; calls: () => number } => {
      let calls = 0;
      return {
        calls: () => calls,
        fetch: (async () => {
          calls++;
          return new Response(JSON.stringify({ content: [{ type: "text", text: '{"score":4,"rationale":"ok"}' }] }), { status: 200 });
        }) as typeof fetch,
      };
    };
    const runArgs = (...extra: string[]): string[] => ["run", "--rubric", rubric, "--dataset", dataset, "--judge", "anthropic:m", "--store", store, ...extra];
    const env = { ANTHROPIC_API_KEY: "k" };

    it("reuses replies on a second identical run, and says how many calls it saved", async () => {
      const api = anthropicOk();
      const first = harness(env, api.fetch);
      expect(await main(runArgs("--cache"), first.io)).toBe(0);
      expect(api.calls()).toBe(24);
      expect(first.err()).toContain("cache: 0 reused, 24 new calls");

      const second = harness(env, api.fetch);
      expect(await main(runArgs("--cache"), second.io)).toBe(0);
      expect(api.calls()).toBe(24); // nothing new was sent
      expect(second.err()).toContain("cache: 24 reused, 0 new calls");
      expect(second.out()).toContain("Unresolved judge failures: 0");
    });

    it("is off unless asked for, so repeated runs still measure judge variation", async () => {
      const api = anthropicOk();
      await main(runArgs("--cache"), harness(env, api.fetch).io);
      const plain = harness(env, api.fetch);
      expect(await main(runArgs(), plain.io)).toBe(0);
      expect(api.calls()).toBe(48);
      expect(plain.err()).not.toContain("cache:");
    });

    it("shows and clears the cache", async () => {
      const api = anthropicOk();
      await main(runArgs("--cache"), harness(env, api.fetch).io);

      const stats = harness();
      expect(await main(["cache", "stats", "--store", store], stats.io)).toBe(0);
      expect(stats.out()).toMatch(/: 24 entries, \d+\.\d KB/);

      const clear = harness();
      expect(await main(["cache", "clear", "--store", store], clear.io)).toBe(0);
      expect(clear.out()).toBe("removed 24 cache entries\n");

      const after = harness();
      await main(["cache", "stats", "--store", store], after.io);
      expect(after.out()).toContain(": 0 entries, 0.0 KB");
      await main(runArgs("--cache"), harness(env, api.fetch).io);
      expect(api.calls()).toBe(48); // cleared, so the second run paid again
    });

    it("works for pairwise runs", async () => {
      let calls = 0;
      const openai = (async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"winner":"first","rationale":"x"}' } }] }), { status: 200 });
      }) as typeof fetch;
      const args = ["compare", "run", "--rubric", rubric, "--pairs", pairs, "--judge", "openai:m", "--cache", "--store", store];
      const first = harness({ OPENAI_API_KEY: "k" }, openai);
      expect(await main(args, first.io)).toBe(0);
      expect(calls).toBe(36);
      expect(first.err()).toContain("cache: 0 reused, 36 new calls");
      const second = harness({ OPENAI_API_KEY: "k" }, openai);
      expect(await main(args, second.io)).toBe(0);
      expect(calls).toBe(36);
      expect(second.err()).toContain("cache: 36 reused, 0 new calls");
    });

    it("is harmless with mock judges and gives usage errors for bad cache commands", async () => {
      const mock = harness();
      expect(await main(["run", "--rubric", rubric, "--dataset", dataset, "--judge", "mock:a", "--cache", "--store", store], mock.io)).toBe(0);
      expect(mock.err()).toContain("cache: 0 reused, 0 new calls");
      for (const argv of [["cache"], ["cache", "wipe"], ["cache", "stats", "--nope"], ["cache", "stats", "extra"]]) {
        expect(await main(argv, harness().io), argv.join(" ")).toBe(2);
      }
    });
  });
});

