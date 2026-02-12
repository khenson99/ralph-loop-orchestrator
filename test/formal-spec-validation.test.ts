import { describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { ZodError } from 'zod';

import { FormalSpecV1Schema, type FormalSpecV1 } from '../src/schemas/contracts.js';
import { WorkflowRepository } from '../src/state/repository.js';
import { RetryExhaustedError } from '../src/lib/retry.js';
import { formatDeadLetterReason } from '../src/lib/errors.js';
import { classifyError } from '../src/orchestrator/stages.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validSpecObject(): FormalSpecV1 {
  return {
    spec_version: 1,
    spec_id: 'spec_42_1700000000000',
    source: {
      github: {
        repo: 'khenson99/ralph-loop-orchestrator',
        issue: 42,
        commit_baseline: 'abc123',
      },
    },
    objective: 'Implement issue #42',
    non_goals: [],
    constraints: {
      languages: ['typescript'],
      allowed_paths: ['src/'],
      forbidden_paths: [],
    },
    acceptance_criteria: ['Tests pass'],
    design_notes: {},
    work_breakdown: [
      {
        id: 'T42-1',
        title: 'Implement feature',
        owner_role: 'backend-engineer',
        definition_of_done: ['Done'],
        depends_on: [],
      },
    ],
    risk_checks: [],
    validation_plan: { ci_jobs: ['CI / Tests'] },
    stop_conditions: ['All tasks complete'],
  };
}

// ---------------------------------------------------------------------------
// FormalSpecV1Schema validation
// ---------------------------------------------------------------------------

describe('FormalSpecV1Schema validation', () => {
  it('accepts a valid spec object', () => {
    const spec = validSpecObject();
    const parsed = FormalSpecV1Schema.parse(spec);
    expect(parsed.spec_id).toBe(spec.spec_id);
    expect(parsed.work_breakdown).toHaveLength(1);
  });

  it('rejects a spec with empty acceptance_criteria', () => {
    const spec = { ...validSpecObject(), acceptance_criteria: [] };
    expect(() => FormalSpecV1Schema.parse(spec)).toThrow(ZodError);
  });

  it('rejects a spec with empty work_breakdown', () => {
    const spec = { ...validSpecObject(), work_breakdown: [] };
    expect(() => FormalSpecV1Schema.parse(spec)).toThrow(ZodError);
  });

  it('rejects a spec with wrong spec_version', () => {
    const spec = { ...validSpecObject(), spec_version: 2 };
    expect(() => FormalSpecV1Schema.parse(spec)).toThrow(ZodError);
  });

  it('rejects a spec missing required fields', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { objective, ...partial } = validSpecObject();
    expect(() => FormalSpecV1Schema.parse(partial)).toThrow(ZodError);
  });
});

// ---------------------------------------------------------------------------
// Round-trip validation: object → YAML → parse → validate
// ---------------------------------------------------------------------------

describe('round-trip spec validation', () => {
  it('round-trips a valid spec through YAML serialization and Zod parsing', () => {
    const original = validSpecObject();
    const rawYaml = yaml.dump(original);
    const reparsed = yaml.load(rawYaml);
    const validated = FormalSpecV1Schema.parse(reparsed);

    expect(validated.spec_id).toBe(original.spec_id);
    expect(validated.objective).toBe(original.objective);
    expect(validated.work_breakdown).toHaveLength(1);
    expect(validated.acceptance_criteria).toEqual(original.acceptance_criteria);
  });

  it('rejects invalid YAML content after round-trip', () => {
    const badYaml = yaml.dump({
      spec_version: 1,
      spec_id: 'spec-bad',
      // Missing most required fields
    });
    const reparsed = yaml.load(badYaml);
    expect(() => FormalSpecV1Schema.parse(reparsed)).toThrow(ZodError);
  });
});

// ---------------------------------------------------------------------------
// storeSpec defense-in-depth: rejects invalid YAML
// ---------------------------------------------------------------------------

describe('storeSpec defense-in-depth', () => {
  it('rejects invalid YAML that does not conform to FormalSpecV1Schema', async () => {
    const invalidYaml = yaml.dump({ spec_version: 1, spec_id: 'bad' });

    const db = {
      select: vi.fn(),
      transaction: vi.fn(),
    };

    const repo = new WorkflowRepository({ db } as never);

    await expect(repo.storeSpec('run_1', 'bad', invalidYaml)).rejects.toThrow(ZodError);

    // Verify the DB was never touched — validation rejects before DB calls
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('accepts valid YAML and proceeds to DB operations', async () => {
    const spec = validSpecObject();
    const validYaml = yaml.dump(spec);

    const selectLimit = vi.fn().mockResolvedValue([{ currentStage: 'TaskRequested' }]);
    const selectWhere = vi.fn(() => ({ limit: selectLimit }));
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from: selectFrom }));

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const txInsert = vi.fn(() => ({ values: insertValues }));
    const tx = { update: txUpdate, insert: txInsert };
    const transaction = vi.fn(async (cb: (trx: typeof tx) => Promise<void>) => cb(tx));

    const db = { select, transaction };
    const repo = new WorkflowRepository({ db } as never);

    await repo.storeSpec('run_1', spec.spec_id, validYaml);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Prompt template loading
// ---------------------------------------------------------------------------

describe('prompt template loading', () => {
  it('formal-spec-v1 prompt file exists and is non-empty', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const templatePath = resolve(__dirname, '../src/prompts/formal-spec-v1.md');
    const content = readFileSync(templatePath, 'utf-8');

    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('FormalSpecV1');
  });
});

// ---------------------------------------------------------------------------
// classifyError treats ZodError as deterministic
// ---------------------------------------------------------------------------

describe('classifyError with ZodError', () => {
  it('classifies ZodError as deterministic', () => {
    try {
      FormalSpecV1Schema.parse({ spec_version: 2 });
    } catch (error) {
      expect(classifyError(error)).toBe('deterministic');
    }
  });

  it('classifies ZodError before string-matching applies', () => {
    // ZodError messages contain JSON-like output, not "validation" keyword
    // Ensure ZodError is caught by the instanceof check, not message matching
    try {
      FormalSpecV1Schema.parse({});
    } catch (error) {
      expect(classifyError(error)).toBe('deterministic');
    }
  });
});

// ---------------------------------------------------------------------------
// formatDeadLetterReason
// ---------------------------------------------------------------------------

describe('formatDeadLetterReason', () => {
  it('includes Zod issue details for a direct ZodError', () => {
    try {
      FormalSpecV1Schema.parse({ spec_version: 2 });
    } catch (error) {
      const reason = formatDeadLetterReason(error);
      expect(reason).toContain('Spec validation failed:');
      expect(reason).toContain('spec_version');
    }
  });

  it('unwraps ZodError from RetryExhaustedError', () => {
    let zodError: ZodError | undefined;
    try {
      FormalSpecV1Schema.parse({ spec_version: 2 });
    } catch (error) {
      zodError = error as ZodError;
    }

    const retryError = new RetryExhaustedError(zodError!, 3, 500);
    const reason = formatDeadLetterReason(retryError);

    expect(reason).toContain('Spec validation failed:');
    expect(reason).toContain('spec_version');
  });

  it('returns plain message for non-Zod errors', () => {
    const reason = formatDeadLetterReason(new Error('timeout after 30s'));
    expect(reason).toBe('timeout after 30s');
  });

  it('returns plain message for RetryExhaustedError wrapping non-Zod error', () => {
    const retryError = new RetryExhaustedError(new Error('network error'), 3, 1000);
    const reason = formatDeadLetterReason(retryError);
    // RetryExhaustedError.message comes from the lastError, so it will be 'network error'
    expect(reason).toBe('network error');
  });

  it('returns fallback for non-Error values', () => {
    expect(formatDeadLetterReason('string')).toBe('unknown run failure');
    expect(formatDeadLetterReason(null)).toBe('unknown run failure');
    expect(formatDeadLetterReason(undefined)).toBe('unknown run failure');
  });
});

// ---------------------------------------------------------------------------
// Dead-letter on persistent spec validation failure (integration-style)
// ---------------------------------------------------------------------------

describe('dead-letter on persistent spec validation failure', () => {
  it('dead-letters with Zod details when spec generation always returns invalid YAML', async () => {
    const { OrchestratorService } = await import('../src/orchestrator/service.js');

    const runId = 'run_dl';
    let deadLetterReason = '';

    const repo = {
      createWorkflowRun: vi.fn().mockResolvedValue(runId),
      linkEventToRun: vi.fn().mockResolvedValue(undefined),
      storeSpec: vi.fn().mockResolvedValue(undefined),
      addArtifact: vi.fn().mockResolvedValue(undefined),
      createTasks: vi.fn().mockResolvedValue(undefined),
      updateRunStage: vi.fn().mockResolvedValue(undefined),
      listRunnableTasks: vi.fn().mockResolvedValue([]),
      markTaskRunning: vi.fn().mockResolvedValue(undefined),
      markTaskResult: vi.fn().mockResolvedValue(undefined),
      addAgentAttempt: vi.fn().mockResolvedValue(undefined),
      getRunView: vi.fn().mockResolvedValue({ tasks: [] }),
      addMergeDecision: vi.fn().mockResolvedValue(undefined),
      setRunPrNumber: vi.fn().mockResolvedValue(undefined),
      countPendingTasks: vi.fn().mockResolvedValue(0),
      markRunStatus: vi.fn().mockImplementation(
        async (_id: string, _status: string, reason?: string) => {
          if (reason) deadLetterReason = reason;
        },
      ),
      markEventProcessed: vi.fn().mockResolvedValue(undefined),
    };

    const github = {
      getIssueContext: vi.fn().mockResolvedValue({
        owner: 'khenson99',
        repo: 'ralph-loop-orchestrator',
        issueNumber: 42,
        title: 'Test issue',
        body: 'Test body',
      }),
      getBranchSha: vi.fn().mockResolvedValue('abc123'),
      findOpenPullRequestForIssue: vi.fn().mockResolvedValue(null),
      hasRequiredChecksPassed: vi.fn().mockResolvedValue(false),
      addIssueComment: vi.fn().mockResolvedValue(undefined),
      approvePullRequest: vi.fn().mockResolvedValue(undefined),
      enableAutoMerge: vi.fn().mockResolvedValue(undefined),
      requestChanges: vi.fn().mockResolvedValue(undefined),
    };

    // codex.generateFormalSpec throws a ZodError (simulating invalid LLM output)
    const codex = {
      generateFormalSpec: vi.fn().mockImplementation(async () => {
        // Simulate: LLM returns invalid YAML that fails Zod validation
        FormalSpecV1Schema.parse({ spec_version: 2 });
      }),
      summarizeReview: vi.fn().mockResolvedValue('review'),
      generateMergeDecision: vi.fn().mockResolvedValue({
        decision: 'approve',
        rationale: 'ok',
        blocking_findings: [],
      }),
    };

    const claude = {
      executeSubtask: vi.fn().mockResolvedValue({
        task_id: 'T1',
        status: 'completed',
        summary: 'done',
        files_changed: [],
        commands_ran: [],
        open_questions: [],
        handoff_notes: '',
      }),
    };

    const config = {
      nodeEnv: 'test' as const,
      port: 3000,
      logLevel: 'info' as const,
      databaseUrl: 'postgres://localhost/test',
      github: {
        webhookSecret: 'secret',
        baseBranch: 'main',
        targetOwner: 'khenson99',
        targetRepo: 'ralph-loop-orchestrator',
      },
      openai: { model: 'gpt-5.3-codex' },
      anthropic: { model: 'claude-opus-4-6' },
      autoMergeEnabled: false,
      requiredChecks: [],
      otelEnabled: false,
      dryRun: false,
    };

    const logger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };

    const service = new OrchestratorService(
      repo as never,
      github as never,
      codex as never,
      claude as never,
      config,
      logger as never,
    );

    await (service as unknown as { handleEvent: (item: unknown) => Promise<void> }).handleEvent({
      eventId: 'evt_dl',
      envelope: {
        event_id: 'evt_dl',
        event_type: 'task.requested',
        schema_version: '1.0',
        timestamp: new Date().toISOString(),
        source: {
          system: 'github',
          repo: 'khenson99/ralph-loop-orchestrator',
          delivery_id: 'delivery_dl',
        },
        actor: { type: 'user', login: 'khenson99' },
        task_ref: {
          kind: 'issue',
          id: 42,
          url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/42',
        },
        payload: {},
      },
    });

    // Run should be dead-lettered
    expect(repo.markRunStatus).toHaveBeenCalledWith(
      runId,
      'dead_letter',
      expect.stringContaining('Spec validation failed:'),
    );

    // The reason should include Zod field-level details
    expect(deadLetterReason).toContain('spec_version');

    // ZodError is deterministic — should NOT be retried (only 1 call)
    expect(codex.generateFormalSpec).toHaveBeenCalledTimes(1);
  });
});
