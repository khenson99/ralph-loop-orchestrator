import { describe, expect, it } from 'vitest';

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

describe('supervisor kanban board endpoints', () => {
  it('returns projected cards grouped by lane from /api/board/cards', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => null,
        getTaskView: async () => null,
        recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-1' }),
        listBoardCards: async () => [
          {
            runId: 'run-1',
            issueNumber: 20,
            prNumber: null,
            status: 'in_progress',
            currentStage: 'TaskRequested',
            updatedAt: new Date('2026-02-12T07:00:00.000Z').toISOString(),
            taskCounts: { queued: 1, running: 0, retry: 0, completed: 0, failed: 0 },
          },
          {
            runId: 'run-2',
            issueNumber: 21,
            prNumber: 55,
            status: 'completed',
            currentStage: 'MergeDecision',
            updatedAt: new Date('2026-02-12T08:00:00.000Z').toISOString(),
            taskCounts: { queued: 0, running: 0, retry: 0, completed: 2, failed: 0 },
          },
        ],
      },
      orchestrator: { enqueue: () => {} },
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/board/cards?lane=done',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      lanes: Array<{ id: string }>;
      cards: Array<{ runId: string; lane: string }>;
      grouped: Record<string, Array<{ runId: string }>>;
    };
    expect(body.lanes.length).toBeGreaterThan(0);
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]).toMatchObject({ runId: 'run-2', lane: 'done' });
    const doneCards = body.grouped.done;
    expect(doneCards).toBeDefined();
    expect(doneCards).toHaveLength(1);
    expect(doneCards![0]).toMatchObject({ runId: 'run-2' });

    await app.close();
  });

  it('serves supervisor board shell from /supervisor', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => null,
        getTaskView: async () => null,
        recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-1' }),
      },
      orchestrator: { enqueue: () => {} },
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/supervisor',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Ralph Supervisor Board');
    expect(response.body).toContain('/api/board/cards');

    await app.close();
  });
});
