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

function buildTestServer(dbReady: boolean) {
  return buildServer({
    config,
    dbClient: { ready: async () => dbReady },
    workflowRepo: {
      getRunView: async () => null,
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
}

describe('observability contract', () => {
  it('exposes health and readiness endpoints with expected status semantics', async () => {
    const healthyApp = buildTestServer(true);
    const health = await healthyApp.inject({ method: 'GET', url: '/healthz' });
    const ready = await healthyApp.inject({ method: 'GET', url: '/readyz' });

    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok' });
    expect(ready.statusCode).toBe(200);
    expect(JSON.parse(ready.body)).toMatchObject({ status: 'ready' });
    await healthyApp.close();

    const notReadyApp = buildTestServer(false);
    const notReady = await notReadyApp.inject({ method: 'GET', url: '/readyz' });
    expect(notReady.statusCode).toBe(503);
    expect(JSON.parse(notReady.body)).toMatchObject({ status: 'not_ready' });
    await notReadyApp.close();
  });

  it('publishes required Prometheus metrics at /metrics', async () => {
    const app = buildTestServer(true);
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('ralph_workflow_runs_total');
    expect(response.body).toContain('ralph_workflow_run_duration_ms');
    expect(response.body).toContain('ralph_webhook_events_total');
    expect(response.body).toContain('ralph_retries_total');
    expect(response.body).toContain('ralph_orchestration_boundary_calls_total');
    expect(response.body).toContain('ralph_orchestration_boundary_duration_ms');

    await app.close();
  });
});
