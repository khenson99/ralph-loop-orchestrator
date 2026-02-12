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

describe('supervisor run detail page', () => {
  it('serves run detail shell with timeline and panel composition', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => ({
          id: 'run-123',
          status: 'in_progress',
          currentStage: 'PRReviewed',
          issueNumber: 21,
          prNumber: 99,
          specId: 'spec-1',
          deadLetterReason: null,
          createdAt: new Date('2026-02-12T07:00:00.000Z'),
          updatedAt: new Date('2026-02-12T07:10:00.000Z'),
          tasks: [{ id: 't1', taskKey: 'T21-1', status: 'completed', attempts: 1 }],
          artifacts: [{ id: 'a1', kind: 'formal_spec', createdAt: new Date('2026-02-12T07:05:00.000Z') }],
          transitions: [
            {
              id: 'st1',
              fromStage: 'TaskRequested',
              toStage: 'SpecGenerated',
              transitionedAt: new Date('2026-02-12T07:02:00.000Z'),
              metadata: {},
            },
          ],
        }),
        getTaskView: async () => null,
        recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-1' }),
      },
      orchestrator: { enqueue: () => {} },
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/supervisor/runs/run-123',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Timeline Spine');
    expect(response.body).toContain('Run Summary');
    expect(response.body).toContain('Spec Viewer');
    expect(response.body).toContain('PR and CI Status');
    expect(response.body).toContain('Logs Viewer');
    expect(response.body).toContain('Agent Transcript (Read-only)');
    expect(response.body).toContain('Agent Console v1');
    expect(response.body).toContain('agentTaskFilter');
    expect(response.body).toContain('agentPrevAttempt');
    expect(response.body).toContain('agentNextAttempt');
    expect(response.body).toContain('agentToolSummary');
    expect(response.body).toContain('auditExport');
    expect(response.body).toContain('Action Controls');
    expect(response.body).toContain('Approve PR');
    expect(response.body).toContain('roleSelect');
    expect(response.body).toContain('/api/runs/');
    expect(response.body).toContain('/logs');
    expect(response.body).toContain('/api/runs/');
    expect(response.body).toContain('Back to Board');

    await app.close();
  });
});
