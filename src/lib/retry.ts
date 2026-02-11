export type RetryOptions = {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  factor?: number;
};

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const factor = options.factor ?? 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt > options.retries) {
        break;
      }

      const waitMs = Math.min(
        options.maxDelayMs,
        options.baseDelayMs * Math.pow(factor, attempt - 1),
      );
      await sleep(waitMs + randomJitter(50));
    }
  }

  throw lastError;
}

function randomJitter(max: number): number {
  return Math.floor(Math.random() * max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
