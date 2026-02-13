import { describe, expect, it, vi } from 'vitest';

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

describe('run action controls API', () => {
  it('requires reason and dispatches manual PR actions', async () => {
    const approvePullRequest = vi.fn().mockResolvedValue(undefined);
    const requestChanges = vi.fn().mockResolvedValue(undefined);

    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => ({
          id: 'run-1',
          status: 'in_progress',
          currentStage: 'PRReviewed',
          issueNumber: 24,
          prNumber: 55,
          specId: null,
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
      },
      github: {
        getPullRequestChecksSnapshot: async () => ({ prNumber: 0, title: '', url: '', state: 'open' as const, draft: false, mergeable: true, headSha: '', checks: [], requiredCheckNames: [], overallStatus: 'unknown' as const }),
        listAccessibleRepositories: async () => [],
        listEpicIssues: async () => [],
        listRepositoryProjects: async () => [],
        listProjectTodoIssues: async () => [],
        getPullRequestChecks: async () => ({ prNumber: 55, headSha: 'sha', checks: [] }),
        approvePullRequest,
        requestChanges,
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

    const missingReason = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/actions',
      payload: JSON.stringify({ action: 'approve', reason: '' }),
      headers: { 'content-type': 'application/json', 'x-supervisor-role': 'admin' },
    });
    expect(missingReason.statusCode).toBe(400);
    expect(JSON.parse(missingReason.body)).toMatchObject({ error: 'reason_required' });

    const approve = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/actions',
      payload: JSON.stringify({ action: 'approve', reason: 'All checks verified manually.' }),
      headers: { 'content-type': 'application/json', 'x-supervisor-role': 'admin' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approvePullRequest).toHaveBeenCalledTimes(1);

    const block = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/actions',
      payload: JSON.stringify({ action: 'block', reason: 'Security findings unresolved.' }),
      headers: { 'content-type': 'application/json', 'x-supervisor-role': 'operator' },
    });
    expect(block.statusCode).toBe(200);
    expect(requestChanges).toHaveBeenCalledTimes(1);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/actions',
      payload: JSON.stringify({ action: 'approve', reason: 'viewer cannot approve' }),
      headers: { 'content-type': 'application/json', 'x-supervisor-role': 'viewer' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(JSON.parse(forbidden.body)).toMatchObject({ error: 'forbidden_action' });

    await app.close();
  });
});
