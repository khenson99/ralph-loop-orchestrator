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

describe('audit export API', () => {
  it('returns run evidence bundle with transcript entries and download headers', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => ({
          id: 'run-1',
          status: 'in_progress',
          currentStage: 'PRReviewed',
          issueNumber: 29,
          prNumber: 52,
          specId: 'spec-29',
          deadLetterReason: null,
          createdAt: new Date('2026-02-12T08:00:00.000Z'),
          updatedAt: new Date('2026-02-12T08:10:00.000Z'),
          tasks: [{ id: 't1', taskKey: 'FE-P1-4', status: 'completed', attempts: 2 }],
          artifacts: [{ id: 'a1', kind: 'formal_spec', createdAt: new Date('2026-02-12T08:05:00.000Z') }],
          transitions: [
            {
              id: 'st1',
              fromStage: 'SpecGenerated',
              toStage: 'PRReviewed',
              transitionedAt: new Date('2026-02-12T08:08:00.000Z'),
              metadata: {},
            },
          ],
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
          id: 'a2',
          kind: 'formal_spec',
          content: 'spec_version: 1',
          createdAt: new Date('2026-02-12T08:05:00.000Z'),
        }),
        listRunLogEntries: async () => [
          {
            id: 'l1',
            timestamp: '2026-02-12T08:09:00.000Z',
            source: 'attempt' as const,
            taskKey: 'FE-P1-4',
            status: 'success',
            message: 'Agent completed requested implementation.',
            metadata: {},
          },
          {
            id: 'l2',
            timestamp: '2026-02-12T08:09:30.000Z',
            source: 'artifact' as const,
            taskKey: null,
            status: null,
            message: 'formal_spec persisted',
            metadata: {},
          },
        ],
      },
      github: {
        getPullRequestChecksSnapshot: async () => ({ prNumber: 0, title: '', url: '', state: 'open' as const, draft: false, mergeable: true, headSha: '', checks: [], requiredCheckNames: [], overallStatus: 'unknown' as const }),
        listAccessibleRepositories: async () => [],
        listEpicIssues: async () => [],
        listRepositoryProjects: async () => [],
        listProjectTodoIssues: async () => [],
        getPullRequestChecks: async () => ({
          prNumber: 52,
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

    const response = await app.inject({ method: 'GET', url: '/api/runs/run-1/audit-export' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-disposition']).toContain('run-run-1-audit.json');
    expect(JSON.parse(response.body)).toMatchObject({
      run: {
        id: 'run-1',
        issueNumber: 29,
        prNumber: 52,
        createdAt: '2026-02-12T08:00:00.000Z',
      },
      spec: {
        kind: 'formal_spec',
        content: 'spec_version: 1',
      },
      prStatus: {
        prNumber: 52,
        headSha: 'abc123',
      },
      transcript: [
        {
          id: 'l1',
          source: 'attempt',
          taskKey: 'FE-P1-4',
        },
      ],
    });

    await app.close();
  });
});
