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

describe('supervisor board to action happy path', () => {
  it('covers board cards, run detail shell, and manual approval action', async () => {
    const approvePullRequest = vi.fn().mockResolvedValue(undefined);

    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async (runId: string) => {
          if (runId !== 'run-25') {
            return null;
          }
          return {
            id: 'run-25',
            status: 'in_progress',
            currentStage: 'PRReviewed',
            issueNumber: 25,
            prNumber: 65,
            specId: 'spec-25',
            deadLetterReason: null,
            createdAt: new Date('2026-02-12T08:15:00.000Z'),
            updatedAt: new Date('2026-02-12T08:25:00.000Z'),
            tasks: [{ id: 't1', taskKey: 'FE-P0-6', status: 'completed', attempts: 1 }],
            artifacts: [{ id: 'a1', kind: 'formal_spec', createdAt: new Date('2026-02-12T08:20:00.000Z') }],
            transitions: [
              {
                id: 'st1',
                fromStage: 'SpecGenerated',
                toStage: 'PRReviewed',
                transitionedAt: new Date('2026-02-12T08:22:00.000Z'),
                metadata: {},
              },
            ],
          };
        },
        getTaskView: async () => null,
        recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-1' }),
        listBoardCards: async () => [
          {
            runId: 'run-25',
            issueNumber: 25,
            prNumber: 65,
            status: 'in_progress',
            currentStage: 'PRReviewed',
            updatedAt: new Date('2026-02-12T08:25:00.000Z').toISOString(),
            taskCounts: { queued: 0, running: 0, retry: 0, completed: 1, failed: 0 },
          },
        ],
        getLatestArtifactByKind: async () => ({
          id: 'a1',
          kind: 'formal_spec',
          content: 'spec_version: 1',
          createdAt: new Date('2026-02-12T08:20:00.000Z'),
        }),
        listRunLogEntries: async () => [
          {
            id: 'l1',
            timestamp: '2026-02-12T08:24:30.000Z',
            source: 'attempt' as const,
            taskKey: 'FE-P0-6',
            status: 'success',
            message: 'UI checks complete.',
            metadata: {},
          },
        ],
      },
      github: {
        getPullRequestChecks: async () => ({
          prNumber: 65,
          headSha: 'sha-65',
          checks: [{ name: 'CI / Tests', status: 'completed', conclusion: 'success' }],
        }),
        approvePullRequest,
      },
      orchestrator: { enqueue: () => {} },
      logger: createLogger('silent'),
    });

    const boardResponse = await app.inject({ method: 'GET', url: '/api/board/cards' });
    expect(boardResponse.statusCode).toBe(200);
    const boardBody = JSON.parse(boardResponse.body) as {
      cards: Array<{ runId: string; issueNumber: number | null; prNumber: number | null; lane: string }>;
    };
    expect(boardBody.cards).toHaveLength(1);
    expect(boardBody.cards[0]).toMatchObject({
      runId: 'run-25',
      issueNumber: 25,
      prNumber: 65,
      lane: 'review',
    });

    const detailResponse = await app.inject({ method: 'GET', url: '/supervisor/runs/run-25' });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.headers['content-type']).toContain('text/html');
    expect(detailResponse.body).toContain('Action Controls');
    expect(detailResponse.body).toContain('/api/runs/');
    expect(detailResponse.body).toContain('run-25');

    const actionResponse = await app.inject({
      method: 'POST',
      url: '/api/runs/run-25/actions',
      payload: JSON.stringify({ action: 'approve', reason: 'Ready to merge.' }),
      headers: { 'content-type': 'application/json', 'x-supervisor-role': 'admin' },
    });
    expect(actionResponse.statusCode).toBe(200);
    expect(JSON.parse(actionResponse.body)).toMatchObject({
      runId: 'run-25',
      action: 'approve',
      prNumber: 65,
    });
    expect(approvePullRequest).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
