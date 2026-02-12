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

describe('accessibility and keyboard baseline', () => {
  it('includes ARIA labels and keyboard hooks on supervisor board and detail pages', async () => {
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

    const board = await app.inject({ method: 'GET', url: '/supervisor' });
    expect(board.statusCode).toBe(200);
    expect(board.body).toContain('aria-label="Search runs"');
    expect(board.body).toContain('aria-label="Filter by lane"');
    expect(board.body).toContain("window.addEventListener('keydown'");

    const detail = await app.inject({ method: 'GET', url: '/supervisor/runs/run-1' });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('aria-live="polite"');
    expect(detail.body).toContain('aria-label="Action reason"');
    expect(detail.body).toContain("event.key === '/'");

    await app.close();
  });
});
