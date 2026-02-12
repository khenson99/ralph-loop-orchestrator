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

describe('run context API for spec and PR/CI panels', () => {
  it('returns spec artifact and PR check status for a run', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => ({
          id: 'run-1',
          status: 'in_progress',
          currentStage: 'PRReviewed',
          issueNumber: 22,
          prNumber: 50,
          specId: 'spec-22',
          deadLetterReason: null,
          createdAt: new Date('2026-02-12T07:00:00.000Z'),
          updatedAt: new Date('2026-02-12T07:10:00.000Z'),
          tasks: [],
          artifacts: [],
          transitions: [],
        }),
        getTaskView: async () => null,
        recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-1' }),
        getLatestArtifactByKind: async () => ({
          id: 'a1',
          kind: 'formal_spec',
          content: 'spec_version: 1',
          createdAt: new Date('2026-02-12T07:05:00.000Z'),
        }),
      },
      github: {
        getPullRequestChecks: async () => ({
          prNumber: 50,
          headSha: 'abc123',
          checks: [{ name: 'CI / Tests', status: 'completed', conclusion: 'success' }],
        }),
      },
      orchestrator: { enqueue: () => {} },
      logger: createLogger('silent'),
    });

    const specResponse = await app.inject({ method: 'GET', url: '/api/runs/run-1/spec' });
    expect(specResponse.statusCode).toBe(200);
    expect(JSON.parse(specResponse.body)).toMatchObject({
      runId: 'run-1',
      kind: 'formal_spec',
      content: 'spec_version: 1',
    });

    const prResponse = await app.inject({ method: 'GET', url: '/api/runs/run-1/pr-status' });
    expect(prResponse.statusCode).toBe(200);
    expect(JSON.parse(prResponse.body)).toMatchObject({
      runId: 'run-1',
      prNumber: 50,
      headSha: 'abc123',
    });

    await app.close();
  });
});
