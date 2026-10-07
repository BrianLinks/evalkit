import type { Sample } from "../dataset.js";
import type { Criterion, Rubric } from "../rubric/schema.js";

export interface JudgeRequest {
  rubric: Rubric;
  criterion: Criterion;
  sample: Sample;
}

export interface Verdict {
  score: number;
  rationale: string;
}

/** A judge scores one criterion of one sample. Implementations throw on failure; the runner records it. */
export interface Judge {
  readonly id: string;
  judge(request: JudgeRequest): Promise<Verdict>;
}

export interface PairRequest {
  rubric: Rubric;
  criterion: Criterion;
  prompt: string;
  /** The response shown first. The judge never learns which system produced it. */
  first: string;
  second: string;
}

export interface PairVerdict {
  winner: "first" | "second" | "tie";
  rationale: string;
}

/** A judge that picks the better of two responses on one criterion. */
export interface PairJudge {
  readonly id: string;
  compare(request: PairRequest): Promise<PairVerdict>;
}

/** What every built-in provider supports. */
export type ProviderJudge = Judge & PairJudge;

/** Raw text completion. Each provider only has to implement this. */
export interface Completer {
  readonly id: string;
  complete(system: string, user: string): Promise<string>;
}
