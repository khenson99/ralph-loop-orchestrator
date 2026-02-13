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
