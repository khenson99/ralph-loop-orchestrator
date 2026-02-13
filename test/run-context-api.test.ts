import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { AutonomyManager } from '../src/lib/autonomy.js';
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
  autonomyMode: 'pr_only' as const,
  corsAllowedOrigins: [],
  uiUnifiedConsole: true,
  uiRuntimeApiBase: undefined,
  runtimeSupervisor: {
    plannerPrdPath: './docs/deep-research-report.md',
    plannerMaxIterations: 10,
    teamMaxIterations: 20,
    reviewerMaxIterations: 10,
    maxLogLines: 4000,
  },
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
        getTaskDetail: async () => null,
        recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-1' }),
        listBoardCards: async () => [],
        listRecentRuns: async () => [],
        listRecentTasks: async () => [],
        listTaskTimeline: async () => [],
        applyTaskAction: async () => null,
        getLatestArtifactByKind: async () => ({
          id: 'a1',
          kind: 'formal_spec',
          content: 'spec_version: 1',
          createdAt: new Date('2026-02-12T07:05:00.000Z'),
        }),
      },
      github: {
        getPullRequestChecksSnapshot: async () => ({ prNumber: 0, title: '', url: '', state: 'open' as const, draft: false, mergeable: true, headSha: '', checks: [], requiredCheckNames: [], overallStatus: 'unknown' as const }),
        listAccessibleRepositories: async () => [],
        listEpicIssues: async () => [],
        listRepositoryProjects: async () => [],
        listProjectTodoIssues: async () => [],
        getPullRequestChecks: async () => ({
          prNumber: 50,
          headSha: 'abc123',
          checks: [{ name: 'CI / Tests', status: 'completed', conclusion: 'success' }],
        }),
      },
      orchestrator: { enqueue: () => {} },
      runtimeSupervisor: {
        listProcesses: () => [],
        listLogs: () => [],
        executeAction: async () => ({ accepted: true, process: { process_id: 'planner' as const, display_name: 'Planner', status: 'idle' as const, pid: null, run_count: 0, last_started_at: null, last_stopped_at: null, last_exit_code: null, last_signal: null, command: 'bash', args: [], error: null } }),
        subscribe: () => () => {},
      },
      autonomyManager: new AutonomyManager('pr_only'),
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
