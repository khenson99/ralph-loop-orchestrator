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

describe('board SSE stream', () => {
  it('emits board snapshot event with id and data payload', async () => {
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
            issueNumber: 26,
            prNumber: null,
            status: 'in_progress',
            currentStage: 'SubtasksDispatched',
            updatedAt: new Date('2026-02-12T07:00:00.000Z').toISOString(),
            taskCounts: { queued: 0, running: 1, retry: 0, completed: 0, failed: 0 },
          },
        ],
      },
      orchestrator: { enqueue: () => {} },
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/board/stream?once=true&lastEventId=12345',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: board.snapshot');
    expect(response.body).toContain('id: ');
    expect(response.body).toContain('"fromLastEventId":"12345"');

    await app.close();
  });
});
