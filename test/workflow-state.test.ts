import { describe, expect, it } from 'vitest';

import {
  InvalidTransitionError,
  VALID_TRANSITIONS,
  WORKFLOW_STAGES,
  classifyError,
  isValidTransition,
} from '../src/orchestrator/stages.js';
import { StageTransitionSchema, RunResponseSchema } from '../src/schemas/contracts.js';

// ---------------------------------------------------------------------------
// Stage transition validation
// ---------------------------------------------------------------------------

describe('VALID_TRANSITIONS map', () => {
  it('covers every workflow stage as a key', () => {
    for (const stage of WORKFLOW_STAGES) {
      expect(VALID_TRANSITIONS).toHaveProperty(stage);
    }
  });

  it('DeadLetter has no outgoing transitions', () => {
    expect(VALID_TRANSITIONS.DeadLetter.size).toBe(0);
  });

  it('every stage except DeadLetter can reach DeadLetter', () => {
    for (const stage of WORKFLOW_STAGES) {
      if (stage === 'DeadLetter') continue;
      expect(VALID_TRANSITIONS[stage].has('DeadLetter')).toBe(true);
    }
  });
});

describe('isValidTransition', () => {
  it('allows TaskRequested → SpecGenerated', () => {
    expect(isValidTransition('TaskRequested', 'SpecGenerated')).toBe(true);
  });

  it('allows SpecGenerated → SubtasksDispatched', () => {
    expect(isValidTransition('SpecGenerated', 'SubtasksDispatched')).toBe(true);
  });

  it('allows SubtasksDispatched → PRReviewed', () => {
    expect(isValidTransition('SubtasksDispatched', 'PRReviewed')).toBe(true);
  });

  it('allows PRReviewed → MergeDecision', () => {
    expect(isValidTransition('PRReviewed', 'MergeDecision')).toBe(true);
  });

  it('allows any non-terminal stage → DeadLetter', () => {
    expect(isValidTransition('TaskRequested', 'DeadLetter')).toBe(true);
    expect(isValidTransition('SubtasksDispatched', 'DeadLetter')).toBe(true);
    expect(isValidTransition('MergeDecision', 'DeadLetter')).toBe(true);
  });

  it('rejects backward transitions', () => {
    expect(isValidTransition('SpecGenerated', 'TaskRequested')).toBe(false);
    expect(isValidTransition('MergeDecision', 'SubtasksDispatched')).toBe(false);
    expect(isValidTransition('PRReviewed', 'TaskRequested')).toBe(false);
  });

  it('rejects self-transitions', () => {
    expect(isValidTransition('TaskRequested', 'TaskRequested')).toBe(false);
    expect(isValidTransition('SpecGenerated', 'SpecGenerated')).toBe(false);
  });

  it('rejects skipping stages', () => {
    expect(isValidTransition('TaskRequested', 'SubtasksDispatched')).toBe(false);
    expect(isValidTransition('TaskRequested', 'PRReviewed')).toBe(false);
    expect(isValidTransition('TaskRequested', 'MergeDecision')).toBe(false);
  });

  it('rejects transitions from DeadLetter', () => {
    expect(isValidTransition('DeadLetter', 'TaskRequested')).toBe(false);
    expect(isValidTransition('DeadLetter', 'SpecGenerated')).toBe(false);
  });

  it('returns false for unknown stages', () => {
    expect(isValidTransition('Unknown', 'TaskRequested')).toBe(false);
    expect(isValidTransition('TaskRequested', 'Unknown')).toBe(false);
  });
});

describe('InvalidTransitionError', () => {
  it('has correct name and message', () => {
    const err = new InvalidTransitionError('MergeDecision', 'TaskRequested');
    expect(err.name).toBe('InvalidTransitionError');
    expect(err.message).toBe('Invalid stage transition: MergeDecision → TaskRequested');
    expect(err.fromStage).toBe('MergeDecision');
    expect(err.toStage).toBe('TaskRequested');
  });

  it('is an instance of Error', () => {
    const err = new InvalidTransitionError('A', 'B');
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Error classification for retry metadata
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  it('classifies timeout errors as transient', () => {
    expect(classifyError(new Error('Request timeout after 30s'))).toBe('transient');
  });

  it('classifies ECONNRESET as transient', () => {
    expect(classifyError(new Error('read ECONNRESET'))).toBe('transient');
  });

  it('classifies ECONNREFUSED as transient', () => {
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe('transient');
  });

  it('classifies rate limit errors as transient', () => {
    expect(classifyError(new Error('Rate limit exceeded'))).toBe('transient');
  });

  it('classifies 429 as transient', () => {
    expect(classifyError(new Error('HTTP 429 Too Many Requests'))).toBe('transient');
  });

  it('classifies 503 as transient', () => {
    expect(classifyError(new Error('HTTP 503 Service Unavailable'))).toBe('transient');
  });

  it('classifies validation errors as deterministic', () => {
    expect(classifyError(new Error('Validation failed: missing field'))).toBe('deterministic');
  });

  it('classifies unauthorized errors as deterministic', () => {
    expect(classifyError(new Error('Unauthorized access'))).toBe('deterministic');
  });

  it('classifies 401 as deterministic', () => {
    expect(classifyError(new Error('HTTP 401 Unauthorized'))).toBe('deterministic');
  });

  it('classifies 404 as deterministic', () => {
    expect(classifyError(new Error('Resource not found (404)'))).toBe('deterministic');
  });

  it('classifies unknown errors as unknown', () => {
    expect(classifyError(new Error('Something unexpected happened'))).toBe('unknown');
  });

  it('classifies non-Error values as unknown', () => {
    expect(classifyError('string error')).toBe('unknown');
    expect(classifyError(42)).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
    expect(classifyError(undefined)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Schema validation for transition records and enriched RunResponse
// ---------------------------------------------------------------------------

describe('StageTransitionSchema', () => {
  it('accepts a valid transition record', () => {
    const record = {
      id: 'abc-123',
      fromStage: 'TaskRequested',
      toStage: 'SpecGenerated',
      transitionedAt: '2026-02-12T10:00:00.000Z',
      metadata: { specId: 'spec-1' },
    };
    const parsed = StageTransitionSchema.parse(record);
    expect(parsed.fromStage).toBe('TaskRequested');
    expect(parsed.toStage).toBe('SpecGenerated');
  });

  it('rejects a record missing required fields', () => {
    expect(() =>
      StageTransitionSchema.parse({
        id: 'abc',
        fromStage: 'TaskRequested',
        // toStage missing
        transitionedAt: '2026-02-12T10:00:00.000Z',
        metadata: {},
      }),
    ).toThrow();
  });
});

describe('RunResponseSchema with transitions', () => {
  const baseRun = {
    id: 'run-1',
    status: 'in_progress',
    currentStage: 'SpecGenerated',
    issueNumber: 42,
    prNumber: null,
    specId: 'spec-1',
    createdAt: '2026-02-12T10:00:00.000Z',
    updatedAt: '2026-02-12T10:01:00.000Z',
    tasks: [],
    artifacts: [],
  };

  it('accepts a run with transition history', () => {
    const run = {
      ...baseRun,
      transitions: [
        {
          id: 't1',
          fromStage: 'TaskRequested',
          toStage: 'SpecGenerated',
          transitionedAt: '2026-02-12T10:00:30.000Z',
          metadata: { specId: 'spec-1' },
        },
      ],
    };
    const parsed = RunResponseSchema.parse(run);
    expect(parsed.transitions).toHaveLength(1);
    expect(parsed.transitions[0]?.fromStage).toBe('TaskRequested');
  });

  it('defaults transitions to empty array when omitted', () => {
    const parsed = RunResponseSchema.parse(baseRun);
    expect(parsed.transitions).toEqual([]);
  });

  it('includes deadLetterReason when present', () => {
    const run = {
      ...baseRun,
      status: 'dead_letter',
      currentStage: 'DeadLetter',
      deadLetterReason: 'Spec generation failed after retries',
    };
    const parsed = RunResponseSchema.parse(run);
    expect(parsed.deadLetterReason).toBe('Spec generation failed after retries');
  });

  it('allows deadLetterReason to be null', () => {
    const run = { ...baseRun, deadLetterReason: null };
    const parsed = RunResponseSchema.parse(run);
    expect(parsed.deadLetterReason).toBeNull();
  });
});
