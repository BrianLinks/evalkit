import { ConfigError } from "../errors.js";
import { sha256 } from "../store.js";

export type LengthUnit = "words" | "chars";

export function textLength(text: string, unit: LengthUnit): number {
  if (unit === "chars") return text.length;
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** Relative length difference in [0, 1]: |a - b| / max(a, b). 0 when both are empty. */
export function relativeDifference(a: number, b: number): number {
  const longest = Math.max(a, b);
  return longest === 0 ? 0 : Math.abs(a - b) / longest;
}

/**
 * Bias checks need the original text, which runs do not store. Make the user supply the file and
 * prove it is the same one the run used, so lengths always belong to the responses that were judged.
 */
export function assertDatasetMatches(run: { id: string; datasetSha256: string }, datasetText: string): void {
  if (sha256(datasetText) !== run.datasetSha256) {
    throw new ConfigError(`this file is not the dataset run ${run.id} used (its content differs); use the original file`);
  }
}
