import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCache, cacheKey, type VerdictCache } from "../src/cache.js";
import { parseDataset } from "../src/dataset.js";
import { JudgeParseError } from "../src/errors.js";
import { createJudge } from "../src/judges/index.js";
import { fromCompleter } from "../src/judges/llm.js";
import { buildPairPrompt, buildPrompt } from "../src/judges/prompt.js";
import type { Completer, PairRequest, JudgeRequest } from "../src/judges/types.js";
import { parseRubric } from "../src/rubric/parser.js";
import { executeRun } from "../src/runner.js";
import { RunStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evalkit-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const memoryCache = (): VerdictCache & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) };
};

function scripted(id: string, replies: string[]): Completer & { calls: number } {
  const c = {
    id,
    calls: 0,
    async complete(): Promise<string> {
      return replies[Math.min(c.calls++, replies.length - 1)];
    },
  };
  return c;
}

const rubric = parseRubric("rubric R\nscale 1..5\ncriterion a\n  ask: q\n");
const criterion = rubric.criteria[0];
const sample = (id: string) => ({ id, prompt: `prompt ${id}`, response: `response ${id}` });
const score = (id = "s1"): JudgeRequest => ({ rubric, criterion, sample: sample(id) });
const pair = (first: string, second: string): PairRequest => ({ rubric, criterion, prompt: "p", first, second });
const GOOD = '{"score": 4, "rationale": "fine"}';

describe("cacheKey", () => {
  it("is a stable 64-character hash that changes with every component", () => {
    const base = cacheKey("anthropic:m", "score", "sys", "usr");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey("anthropic:m", "score", "sys", "usr")).toBe(base);
    for (const other of [
      cacheKey("anthropic:n", "score", "sys", "usr"),
      cacheKey("anthropic:m", "compare", "sys", "usr"),
      cacheKey("anthropic:m", "score", "sys2", "usr"),
      cacheKey("anthropic:m", "score", "sys", "usr2"),
    ]) expect(other).not.toBe(base);
  });
  it("cannot be fooled by moving text across the system/user boundary", () => {
    expect(cacheKey("j", "score", "ab", "c")).not.toBe(cacheKey("j", "score", "a", "bc"));
  });
});

describe("FileCache", () => {
  const key = cacheKey("j", "score", "s", "u");

  it("stores and returns text, across instances, and counts hits and writes", async () => {
    const cache = new FileCache(join(dir, "cache"));
    expect(await cache.get(key)).toBeUndefined();
    expect(cache.hits).toBe(0);
    await cache.set(key, GOOD);
    expect(cache.stored).toBe(1);
    expect(await cache.get(key)).toBe(GOOD);
    expect(cache.hits).toBe(1);
    expect(await new FileCache(join(dir, "cache")).get(key)).toBe(GOOD);
  });

  it("shards by the first two key characters and leaves no temporary files", async () => {
    const cache = new FileCache(join(dir, "cache"));
    await cache.set(key, "x");
    const shard = await readdir(join(dir, "cache", key.slice(0, 2)));
    expect(shard).toEqual([`${key}.json`]);
  });

  it("rejects keys that could escape the directory, and treats lookups of them as misses", async () => {
    const cache = new FileCache(join(dir, "cache"));
    await expect(cache.set("../../etc/passwd", "x")).rejects.toThrow(RangeError);
    await expect(cache.set("abc", "x")).rejects.toThrow(RangeError);
    expect(await cache.get("../../etc/passwd")).toBeUndefined();
  });

  it("treats malformed or wrong-shaped files as misses", async () => {
    const cache = new FileCache(join(dir, "cache"));
    await cache.set(key, "ok");
    const file = join(dir, "cache", key.slice(0, 2), `${key}.json`);
    await writeFile(file, "not json");
    expect(await cache.get(key)).toBeUndefined();
    await writeFile(file, JSON.stringify({ v: 2, text: "future format" }));
    expect(await cache.get(key)).toBeUndefined();
    await writeFile(file, JSON.stringify({ v: 1 }));
    expect(await cache.get(key)).toBeUndefined();
    expect(cache.hits).toBe(0);
  });

  it("survives many concurrent writers of the same key", async () => {
    const cache = new FileCache(join(dir, "cache"));
    await Promise.all(Array.from({ length: 25 }, () => cache.set(key, GOOD)));
    expect(await cache.get(key)).toBe(GOOD);
    expect((await readdir(join(dir, "cache", key.slice(0, 2)))).every((f) => f.endsWith(".json"))).toBe(true);
  });

  it("reports entries and size, and zero for a directory that does not exist", async () => {
    expect(await new FileCache(join(dir, "none")).stats()).toEqual({ entries: 0, bytes: 0 });
    const cache = new FileCache(join(dir, "cache"));
    await cache.set(cacheKey("j", "score", "a", "1"), "aaaa");
    await cache.set(cacheKey("j", "score", "a", "2"), "bbbb");
    const stats = await cache.stats();
    expect(stats.entries).toBe(2);
    expect(stats.bytes).toBeGreaterThan(20);
  });

  it("clears only its own entries and leaves other files alone", async () => {
    const cache = new FileCache(join(dir, "cache"));
    await cache.set(cacheKey("j", "score", "a", "1"), "x");
    await cache.set(cacheKey("j", "score", "a", "2"), "y");
    await writeFile(join(dir, "cache", "notes.txt"), "keep me");
    expect(await cache.clear()).toBe(2);
    expect(await cache.stats()).toEqual({ entries: 0, bytes: 0 });
    expect(await readdir(join(dir, "cache"))).toEqual(["notes.txt"]);
    expect(await new FileCache(join(dir, "missing")).clear()).toBe(0);
  });

  it("removes the directory itself when nothing else is in it", async () => {
    const cache = new FileCache(join(dir, "cache"));
    await cache.set(key, "x");
    await cache.clear();
    await expect(readdir(join(dir, "cache"))).rejects.toThrow();
    await mkdir(join(dir, "cache"), { recursive: true });
  });
});

describe("fromCompleter with a cache", () => {
  it("answers a repeated score request from the cache and a different one live", async () => {
    const completer = scripted("j", [GOOD]);
    const judge = fromCompleter(completer, memoryCache());
    const first = await judge.judge(score("s1"));
    expect(await judge.judge(score("s1"))).toEqual(first);
    expect(completer.calls).toBe(1);
    await judge.judge(score("s2"));
    expect(completer.calls).toBe(2);
  });

  it("keeps different judges apart even for the same request", async () => {
    const cache = memoryCache();
    const a = scripted("anthropic:m", [GOOD]);
    const b = scripted("openai:m", ['{"score": 2}']);
    expect((await fromCompleter(a, cache).judge(score())).score).toBe(4);
    expect((await fromCompleter(b, cache).judge(score())).score).toBe(2);
    expect(cache.map.size).toBe(2);
  });

  it("never stores a reply that did not parse, so a retry asks the model again", async () => {
    const completer = scripted("j", ["I cannot do that", GOOD]);
    const cache = memoryCache();
    const judge = fromCompleter(completer, cache);
    await expect(judge.judge(score())).rejects.toThrow(JudgeParseError);
    expect(cache.map.size).toBe(0);
    expect((await judge.judge(score())).score).toBe(4);
    expect(completer.calls).toBe(2);
    await judge.judge(score());
    expect(completer.calls).toBe(2); // now served from the cache
  });

  it("does not reuse an answer when the scale changed, because the prompt differs", async () => {
    const completer = scripted("j", [GOOD, '{"score": 9}']);
    const judge = fromCompleter(completer, memoryCache());
    await judge.judge(score());
    const wide = parseRubric("rubric R\nscale 1..10\ncriterion a\n  ask: q\n");
    const verdict = await judge.judge({ rubric: wide, criterion: wide.criteria[0], sample: sample("s1") });
    expect(verdict.score).toBe(9);
    expect(completer.calls).toBe(2);
  });

  it("replaces an unusable cached entry with a live answer", async () => {
    const cache = memoryCache();
    const completer = scripted("j", [GOOD]);
    const { system, user } = buildPrompt(score());
    cache.map.set(cacheKey("j", "score", system, user), "garbage that is not a verdict");
    expect((await fromCompleter(completer, cache).judge(score())).score).toBe(4);
    expect(completer.calls).toBe(1);
    expect(cache.map.get(cacheKey("j", "score", system, user))).toBe(GOOD);
  });

  it("caches comparisons separately for each presentation order", async () => {
    const completer = scripted("j", ['{"winner": "first", "rationale": "a"}', '{"winner": "second", "rationale": "b"}']);
    const judge = fromCompleter(completer, memoryCache());
    expect((await judge.compare(pair("X", "Y"))).winner).toBe("first");
    expect((await judge.compare(pair("Y", "X"))).winner).toBe("second");
    expect(completer.calls).toBe(2);
    expect((await judge.compare(pair("X", "Y"))).winner).toBe("first");
    expect(completer.calls).toBe(2);
    expect(buildPairPrompt(pair("X", "Y")).user).not.toBe(buildPairPrompt(pair("Y", "X")).user);
  });

  it("keeps working when the cache itself fails to read or write", async () => {
    const broken: VerdictCache = { get: async () => Promise.reject(new Error("disk gone")), set: async () => Promise.reject(new Error("disk full")) };
    const completer = scripted("j", [GOOD]);
    expect((await fromCompleter(completer, broken).judge(score())).score).toBe(4);
    expect(completer.calls).toBe(1);
  });

  it("behaves exactly as before when no cache is given", async () => {
    const completer = scripted("j", [GOOD]);
    const judge = fromCompleter(completer);
    await judge.judge(score());
    await judge.judge(score());
    expect(completer.calls).toBe(2);
  });
});

describe("caching across real runs", () => {
  const cacheRubric = parseRubric("rubric R\nscale 1..5\ncriterion a\n  ask: qa\ncriterion b\n  ask: qb\n");
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => JSON.stringify({ id: `s${i}`, prompt: `p${i}`, response: `r${i}` })).join("\n");

  function countingFetch(): { fetch: typeof fetch; calls: () => number } {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return new Response(JSON.stringify({ content: [{ type: "text", text: GOOD }] }), { status: 200 });
    }) as typeof fetch;
    return { fetch: impl, calls: () => calls };
  }

  async function run(datasetText: string, cacheDir: string | undefined, f: typeof fetch) {
    const cache = cacheDir ? new FileCache(cacheDir) : undefined;
    const judge = createJudge("anthropic:m", { env: { ANTHROPIC_API_KEY: "k" }, fetch: f, cache });
    const store = new RunStore(join(dir, "runs"));
    const meta = await executeRun({
      rubric: cacheRubric, samples: parseDataset(datasetText), judges: [judge], concurrency: 2, store, datasetPath: "d.jsonl", datasetText,
    });
    return { meta, cache, results: await store.loadResults(meta.id) };
  }

  it("makes a second identical run free and gives identical scores", async () => {
    const f = countingFetch();
    const first = await run(lines(3), join(dir, "cache"), f.fetch);
    expect(f.calls()).toBe(6);
    expect(first.cache?.stored).toBe(6);
    const second = await run(lines(3), join(dir, "cache"), f.fetch);
    expect(f.calls()).toBe(6); // no new calls
    expect(second.cache?.hits).toBe(6);
    expect(second.cache?.stored).toBe(0);
    const scores = (r: { results: { sampleId: string; criterionId: string; score?: number }[] }) =>
      r.results.map((x) => `${x.sampleId}/${x.criterionId}=${x.score}`).sort();
    expect(scores(second)).toEqual(scores(first));
    expect(second.meta.status).toBe("completed");
  });

  it("charges only for new samples when a dataset grows", async () => {
    const f = countingFetch();
    await run(lines(3), join(dir, "cache"), f.fetch);
    expect(f.calls()).toBe(6);
    await run(lines(4), join(dir, "cache"), f.fetch);
    expect(f.calls()).toBe(8); // only the new sample's 2 criteria
  });

  it("calls the API every time when no cache is used", async () => {
    const f = countingFetch();
    await run(lines(3), undefined, f.fetch);
    await run(lines(3), undefined, f.fetch);
    expect(f.calls()).toBe(12);
  });
});
