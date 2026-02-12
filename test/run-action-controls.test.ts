import { describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { createLogger } from '../src/lib/logger.js';

const config = {
  nodeEnv: 'test' as const,
  port: 3000,
  logLevel: 'silent' as const,
  databaseUrl: 'postgres://example',
  github: {
    webhookSecret: 'test-secret',
    appId: '1',
    appPrivateKey: 'key',
    installationId: 1,
    targetOwner: 'khenson99',
    targetRepo: 'ralph-loop-orchestrator',
    baseBranch: 'main',
  },
  openai: { apiKey: 'k', model: 'm' },
  anthropic: { apiKey: 'k', model: 'm' },
  autoMergeEnabled: true,
  requiredChecks: [],
  otelEnabled: false,
  dryRun: true,
};

describe('run action controls API', () => {
  it('requires reason and dispatches manual PR actions', async () => {
    const approvePullRequest = vi.fn().mockResolvedValue(undefined);
    const requestChanges = vi.fn().mockResolvedValue(undefined);

    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => ({
          id: 'run-1',
          status: 'in_progress',
          currentStage: 'PRReviewed',
          issueNumber: 24,
          prNumber: 55,
          specId: null,
          deadLetterReason: null,
          createdAt: new Date('2026-02-12T07:00:00.000Z'),
          updatedAt: new Date('2026-02-12T07:10:00.000Z'),
          tasks: [],
          artifacts: [],
          transitions: [],
        }),
        getTaskView: async () => null,
        recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-1' }),
      },
      github: {
        getPullRequestChecks: async () => ({ prNumber: 55, headSha: 'sha', checks: [] }),
        approvePullRequest,
        requestChanges,
      },
      orchestrator: { enqueue: () => {} },
      logger: createLogger('silent'),
    });

    const missingReason = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/actions',
      payload: JSON.stringify({ action: 'approve', reason: '' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(missingReason.statusCode).toBe(400);
    expect(JSON.parse(missingReason.body)).toMatchObject({ error: 'reason_required' });

    const approve = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/actions',
      payload: JSON.stringify({ action: 'approve', reason: 'All checks verified manually.' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approvePullRequest).toHaveBeenCalledTimes(1);

    const block = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/actions',
      payload: JSON.stringify({ action: 'block', reason: 'Security findings unresolved.' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(block.statusCode).toBe(200);
    expect(requestChanges).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
