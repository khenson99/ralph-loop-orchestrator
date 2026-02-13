import { ZodError } from 'zod';

import { RetryExhaustedError } from './retry.js';

/**
 * Build a dead-letter reason string that includes Zod validation details
 * when the root cause is a ZodError (directly or wrapped in RetryExhaustedError).
 */
export function formatDeadLetterReason(error: unknown): string {
  const root = error instanceof RetryExhaustedError ? error.lastError : error;

  if (root instanceof ZodError) {
    const issues = root.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    return `Spec validation failed:\n${issues}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'unknown run failure';
}
