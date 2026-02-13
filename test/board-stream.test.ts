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

describe('board SSE stream', () => {
  it('emits board snapshot event with id and data payload', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => null,
        getTaskView: async () => null,
        getTaskDetail: async () => null,
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
        listRecentRuns: async () => [],
        listRecentTasks: async () => [],
        listTaskTimeline: async () => [],
        applyTaskAction: async () => null,
      },
      github: {
        getPullRequestChecksSnapshot: async () => ({ prNumber: 0, title: '', url: '', state: 'open' as const, draft: false, mergeable: true, headSha: '', checks: [], requiredCheckNames: [], overallStatus: 'unknown' as const }),
        listAccessibleRepositories: async () => [],
        listEpicIssues: async () => [],
        listRepositoryProjects: async () => [],
        listProjectTodoIssues: async () => [],
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
