export type RetryOptions = {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  factor?: number;
  /** When provided, errors classified as 'deterministic' are not retried. */
  classifyError?: (error: unknown) => string;
};

export type RetryResult<T> = {
  value: T;
  attempts: number;
  lastBackoffMs: number | null;
};

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly lastBackoffMs: number | null;
  readonly lastError: unknown;

  constructor(lastError: unknown, attempts: number, lastBackoffMs: number | null) {
    super(lastError instanceof Error ? lastError.message : 'Retry attempts exhausted');
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.lastBackoffMs = lastBackoffMs;
    this.lastError = lastError;
  }
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  const factor = options.factor ?? 2;
  let lastError: unknown;
  let lastBackoffMs: number | null = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    attemptsUsed = attempt;
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt, lastBackoffMs };
    } catch (error) {
      lastError = error;

      // Short-circuit: deterministic errors are never retried
      if (options.classifyError && options.classifyError(error) === 'deterministic') {
        break;
      }

      if (attempt > options.retries) {
        break;
      }

      const waitMs = Math.min(
        options.maxDelayMs,
        options.baseDelayMs * Math.pow(factor, attempt - 1),
      );
      lastBackoffMs = waitMs;
      await sleep(waitMs + randomJitter(50));
    }
  }

  throw new RetryExhaustedError(lastError, attemptsUsed, lastBackoffMs);
}

function randomJitter(max: number): number {
  return Math.floor(Math.random() * max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
