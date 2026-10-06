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
