import type { ZodError } from "zod";

/** Base class for every error EvalKit raises on purpose. The CLI prints these without a stack trace. */
export class EvalKitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UsageError extends EvalKitError {}
export class DatasetError extends EvalKitError {}
export class ConfigError extends EvalKitError {}
export class JudgeParseError extends EvalKitError {}
export class StoreError extends EvalKitError {}

export class RubricParseError extends EvalKitError {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
  }
}

export class HttpError extends EvalKitError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.map(String).join(".") : "value"}: ${i.message}`)
    .join("; ");
}
