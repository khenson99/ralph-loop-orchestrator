import { describe, expect, it, vi } from 'vitest';

import { InvalidTransitionError } from '../src/orchestrator/stages.js';
import { WorkflowRepository } from '../src/state/repository.js';

describe('WorkflowRepository transaction and retry metadata behavior', () => {
  it('updates stage and inserts transition in a single transaction', async () => {
    const selectLimit = vi.fn().mockResolvedValue([{ currentStage: 'TaskRequested' }]);
    const selectWhere = vi.fn(() => ({ limit: selectLimit }));
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from: selectFrom }));

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertValues = vi.fn().mockResolvedValue(undefined);
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = {
      update: txUpdate,
      insert: txInsert,
    };

    const transaction = vi.fn(async (callback: (trx: typeof tx) => Promise<void>) => callback(tx));

    const db = {
      select,
      transaction,
    };

    const repo = new WorkflowRepository({ db } as never);
    await repo.updateRunStage('run_1', 'SpecGenerated', { source: 'test' });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowRunId: 'run_1',
        fromStage: 'TaskRequested',
        toStage: 'SpecGenerated',
      }),
    );
  });

  it('rejects invalid DeadLetter self-transition before writing transaction', async () => {
    const selectLimit = vi.fn().mockResolvedValue([{ currentStage: 'DeadLetter' }]);
    const selectWhere = vi.fn(() => ({ limit: selectLimit }));
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from: selectFrom }));

    const transaction = vi.fn();
    const db = {
      select,
      transaction,
    };

    const repo = new WorkflowRepository({ db } as never);
    await expect(repo.markRunStatus('run_2', 'dead_letter', 'boom')).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );

    expect(transaction).not.toHaveBeenCalled();
  });

  it('persists retry metadata fields on agent attempts', async () => {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values: insertValues }));
    const db = { insert };

    const repo = new WorkflowRepository({ db } as never);
    await repo.addAgentAttempt({
      taskId: 'task_1',
      agentRole: 'backend',
      attemptNumber: 3,
      status: 'failed',
      output: { token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' },
      error: 'timeout token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      errorCategory: 'transient',
      backoffDelayMs: 500,
      durationMs: 1234,
    });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_1',
        attemptNumber: 3,
        errorCategory: 'transient',
        backoffDelayMs: 500,
        output: { token: '[REDACTED]' },
        error: 'timeout token=[REDACTED]',
      }),
    );
  });

  it('redacts sensitive values in artifact content and metadata', async () => {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values: insertValues }));
    const db = { insert };

    const repo = new WorkflowRepository({ db } as never);
    await repo.addArtifact({
      workflowRunId: 'run_1',
      kind: 'review_summary',
      content: 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456',
      metadata: {
        secret: 'ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      },
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'api_key=[REDACTED]',
        metadata: { secret: '[REDACTED]' },
      }),
    );
  });
});
