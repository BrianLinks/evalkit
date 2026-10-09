import { HttpError } from "./errors.js";

/** Billing and quota problems come back as 400, 402, 403 or 429 with a message, not as a distinct status. */
const BILLING_STATUSES = new Set([400, 402, 403, 429]);
const BILLING_TEXT = /credit balance|billing|insufficient[_ ]quota|exceeded your current quota|payment required/i;

/**
 * Why this error means every further call will fail too, or undefined if it might be specific to
 * one request (bad content, a rate limit, a flaky network). Only provider rejections of the key,
 * the model or the account qualify.
 */
export function fatalReason(error: unknown): string | undefined {
  if (!(error instanceof HttpError) || error.status === undefined) return undefined;
  const { status } = error;
  if (status === 401) return "authentication failed (HTTP 401): check the API key";
  if (status === 402 || (BILLING_STATUSES.has(status) && BILLING_TEXT.test(error.message))) {
    return `billing or quota problem (HTTP ${status}): add credit or raise the limit`;
  }
  if (status === 403) return "access denied (HTTP 403): the key may not have permission";
  if (status === 404) return "not found (HTTP 404): check the model name";
  return undefined;
}

export interface Halt {
  judge: string;
  reason: string;
}

/**
 * Stops sending requests to a judge after `threshold` identical fatal errors in a row.
 * A success, or any error that is not fatal, resets that judge's streak, so a flaky provider
 * is never halted by scattered failures.
 */
export class FatalBreaker {
  private readonly streaks = new Map<string, { reason: string; count: number }>();
  private readonly halts = new Map<string, string>();

  constructor(
    private readonly threshold: number,
    private readonly onHalt?: (halt: Halt) => void,
  ) {
    if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError("threshold must be a positive integer");
  }

  isHalted(judge: string): boolean {
    return this.halts.has(judge);
  }

  recordSuccess(judge: string): void {
    this.streaks.delete(judge);
  }

  recordFailure(judge: string, error: unknown): void {
    const reason = fatalReason(error);
    if (reason === undefined) {
      this.streaks.delete(judge);
      return;
    }
    const previous = this.streaks.get(judge);
    const count = previous?.reason === reason ? previous.count + 1 : 1;
    this.streaks.set(judge, { reason, count });
    if (count >= this.threshold && !this.halts.has(judge)) {
      this.halts.set(judge, reason);
      this.onHalt?.({ judge, reason });
    }
  }

  get halted(): Halt[] {
    return [...this.halts].map(([judge, reason]) => ({ judge, reason }));
  }
}
