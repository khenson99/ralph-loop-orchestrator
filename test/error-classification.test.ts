import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ClaudeStructuredOutputError } from '../src/integrations/anthropic/claude.js';
import { RetryExhaustedError } from '../src/lib/retry.js';
import { classifyError } from '../src/orchestrator/stages.js';

describe('classifyError', () => {
  it('classifies Claude structured-output errors as deterministic', () => {
    expect(classifyError(new ClaudeStructuredOutputError('bad output'))).toBe('deterministic');
  });

  it('classifies Zod errors as deterministic', () => {
    const schema = z.object({ value: z.string().min(1) });
    try {
      schema.parse({ value: '' });
      throw new Error('expected zod parse to fail');
    } catch (error) {
      expect(classifyError(error)).toBe('deterministic');
    }
  });

  it('classifies transient network/rate-limit failures as transient', () => {
    expect(classifyError(new Error('request timeout from upstream'))).toBe('transient');
    expect(classifyError(new Error('HTTP 429 Too Many Requests'))).toBe('transient');
    expect(classifyError(new Error('socket hang up from provider'))).toBe('transient');
  });

  it('classifies deterministic auth/validation failures as deterministic', () => {
    expect(classifyError(new Error('HTTP 422 Unprocessable Entity'))).toBe('deterministic');
    expect(classifyError(new Error('forbidden'))).toBe('deterministic');
    expect(classifyError(new Error('validation failed'))).toBe('deterministic');
  });

  it('unwraps RetryExhaustedError and classifies by root cause', () => {
    const transientWrapped = new RetryExhaustedError(new Error('503 service unavailable'), 3, 1000);
    expect(classifyError(transientWrapped)).toBe('transient');

    const deterministicWrapped = new RetryExhaustedError(
      new ClaudeStructuredOutputError('schema violation'),
      1,
      null,
    );
    expect(classifyError(deterministicWrapped)).toBe('deterministic');
  });

  it('returns unknown when no known signal is present', () => {
    expect(classifyError(new Error('something odd happened'))).toBe('unknown');
  });
});
