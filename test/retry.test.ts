import { describe, expect, it } from 'vitest';

import { RetryExhaustedError, withRetry } from '../src/lib/retry.js';

describe('withRetry', () => {
  it('returns attempts and backoff metadata on success after retries', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('transient');
        }
        return 'ok';
      },
      { retries: 3, baseDelayMs: 1, maxDelayMs: 10 },
    );

    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(3);
    expect(result.lastBackoffMs).toBe(2);
  });

  it('short-circuits deterministic errors without retrying', async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error('validation failed');
        },
        {
          retries: 3,
          baseDelayMs: 1,
          maxDelayMs: 10,
          classifyError: () => 'deterministic',
        },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    try {
      await withRetry(
        async () => {
          throw new Error('validation failed');
        },
        {
          retries: 3,
          baseDelayMs: 1,
          maxDelayMs: 10,
          classifyError: () => 'deterministic',
        },
      );
    } catch (error) {
      const retryError = error as RetryExhaustedError;
      expect(retryError.attempts).toBe(1);
      expect(retryError.lastBackoffMs).toBeNull();
    }
  });

  it('exposes retry metadata on exhausted retries', async () => {
    try {
      await withRetry(
        async () => {
          throw new Error('timeout');
        },
        { retries: 2, baseDelayMs: 1, maxDelayMs: 1 },
      );
      throw new Error('expected retry exhaustion');
    } catch (error) {
      const retryError = error as RetryExhaustedError;
      expect(retryError).toBeInstanceOf(RetryExhaustedError);
      expect(retryError.attempts).toBe(3);
      expect(retryError.lastBackoffMs).toBe(1);
    }
  });
});
