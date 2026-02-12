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

describe('run logs API', () => {
  it('returns filtered log entries with cursor support', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => null,
        getTaskView: async () => null,
        recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-1' }),
        listRunLogEntries: async (_runId, options) => [
          {
            id: 'l1',
            timestamp: options?.after ? '2026-02-12T07:10:00.000Z' : '2026-02-12T07:00:00.000Z',
            source: 'attempt',
            taskKey: 'T1',
            status: 'failed',
            message: 'timeout',
            metadata: {},
          },
        ],
      },
      orchestrator: { enqueue: () => {} },
      logger: createLogger('silent'),
    });

    const first = await app.inject({ method: 'GET', url: '/api/runs/run-1/logs?source=attempt' });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body) as {
      entries: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.entries).toHaveLength(1);
    expect(firstBody.nextCursor).toBe('2026-02-12T07:00:00.000Z');

    const tail = await app.inject({
      method: 'GET',
      url: '/api/runs/run-1/logs?source=attempt&after=2026-02-12T07:00:00.000Z',
    });
    expect(tail.statusCode).toBe(200);
    const tailBody = JSON.parse(tail.body) as {
      entries: Array<{ timestamp: string }>;
    };
    expect(tailBody.entries[0]).toMatchObject({ timestamp: '2026-02-12T07:10:00.000Z' });

    await app.close();
  });
});
