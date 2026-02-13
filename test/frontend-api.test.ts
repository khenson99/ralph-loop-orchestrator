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
  requiredChecks: ['CI / Lint + Typecheck', 'CI / Tests'],
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

function createWorkflowRepoStub(overrides: Partial<Parameters<typeof buildServer>[0]['workflowRepo']> = {}) {
  return {
    getRunView: async () => null,
    listRecentRuns: async () => [],
    getTaskView: async () => null,
    listRecentTasks: async () => [],
    getTaskDetail: async () => null,
    listTaskTimeline: async () => [],
    listBoardCards: async () => [],
    applyTaskAction: async () => null,
    recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-1' }),
    ...overrides,
  };
}

const githubStub: Parameters<typeof buildServer>[0]['github'] = {
  getPullRequestChecksSnapshot: async (prNumber, requiredChecks) => ({
    prNumber,
    title: 'Live PR',
    url: `https://github.com/khenson99/ralph-loop-orchestrator/pull/${prNumber}`,
    state: 'open',
    draft: false,
    mergeable: true,
    headSha: 'abc123',
    checks: requiredChecks.map((name) => ({
      name,
      status: 'completed',
      conclusion: 'success',
      detailsUrl: null,
      startedAt: '2026-02-11T21:00:00Z',
      completedAt: '2026-02-11T21:01:00Z',
      required: true,
    })),
    requiredCheckNames: requiredChecks,
    overallStatus: 'passing',
  }),
  listAccessibleRepositories: async () => [
    {
      owner: 'khenson99',
      repo: 'ralph-loop-orchestrator',
      fullName: 'khenson99/ralph-loop-orchestrator',
      private: false,
      defaultBranch: 'main',
      url: 'https://github.com/khenson99/ralph-loop-orchestrator',
    },
  ],
  listEpicIssues: async () => [
    {
      number: 123,
      title: 'Epic: Supervisor board',
      state: 'open',
      labels: ['epic'],
      url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/123',
      updatedAt: '2026-02-11T21:00:00Z',
      createdAt: '2026-02-11T20:00:00Z',
    },
  ],
  listRepositoryProjects: async () => [
    {
      id: 'PVT_x',
      number: 7,
      title: 'Ralph Delivery',
      url: 'https://github.com/orgs/khenson99/projects/7',
      closed: false,
      updatedAt: '2026-02-11T22:00:00Z',
    },
  ],
  listProjectTodoIssues: async () => [
    {
      itemId: 'PVTI_y',
      issueNumber: 123,
      title: 'Epic: Supervisor board',
      url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/123',
      state: 'open',
      labels: ['epic'],
      statusName: 'Todo',
      repositoryFullName: 'khenson99/ralph-loop-orchestrator',
    },
  ],
};

const runtimeSupervisorStub: Parameters<typeof buildServer>[0]['runtimeSupervisor'] = {
  listProcesses: () => [],
  listLogs: () => [],
  executeAction: async ({ processId }) => ({
    accepted: true,
    process: {
      process_id: processId,
      display_name: processId[0]?.toUpperCase() + processId.slice(1),
      status: 'idle',
      pid: null,
      run_count: 0,
      last_started_at: null,
      last_stopped_at: null,
      last_exit_code: null,
      last_signal: null,
      command: 'bash',
      args: [],
      error: null,
    },
  }),
  subscribe: () => () => {},
};

describe('frontend API routes', () => {
  it('returns auth context and action permissions', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        'x-ralph-user': 'alice',
        'x-ralph-roles': 'operator',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      authenticated: boolean;
      user_id: string;
      roles: string[];
      permissions: { actions: string[] };
    };
    expect(body.authenticated).toBe(true);
    expect(body.user_id).toBe('alice');
    expect(body.roles).toContain('operator');
    expect(body.permissions.actions).toContain('retry');
    expect(body.permissions.actions).not.toContain('block');

    await app.close();
  });

  it('lists accessible repositories and epic issues', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const reposResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/github/repos',
    });
    expect(reposResponse.statusCode).toBe(200);
    const reposBody = JSON.parse(reposResponse.body) as {
      items: Array<{ full_name: string }>;
    };
    expect(reposBody.items[0]?.full_name).toBe('khenson99/ralph-loop-orchestrator');

    const epicsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/github/epics?owner=khenson99&repo=ralph-loop-orchestrator',
    });
    expect(epicsResponse.statusCode).toBe(200);
    const epicsBody = JSON.parse(epicsResponse.body) as {
      items: Array<{ number: number }>;
    };
    expect(epicsBody.items[0]?.number).toBe(123);

    await app.close();
  });

  it('lists repository projects and project todo issues', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const projectsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/github/projects?owner=khenson99&repo=ralph-loop-orchestrator',
    });
    expect(projectsResponse.statusCode).toBe(200);
    const projectsBody = JSON.parse(projectsResponse.body) as {
      items: Array<{ number: number; title: string }>;
    };
    expect(projectsBody.items[0]).toMatchObject({ number: 7, title: 'Ralph Delivery' });

    const todosResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/github/project-todos?owner=khenson99&repo=ralph-loop-orchestrator&project_number=7',
    });
    expect(todosResponse.statusCode).toBe(200);
    const todosBody = JSON.parse(todosResponse.body) as {
      items: Array<{ issue_number: number; status_name: string }>;
    };
    expect(todosBody.items[0]).toMatchObject({ issue_number: 123, status_name: 'Todo' });

    await app.close();
  });

  it('dispatches selected epics into workflow queue', async () => {
    const enqueue = vi.fn();
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/epics/dispatch',
      headers: {
        'content-type': 'application/json',
        'x-ralph-user': 'alice',
        'x-ralph-roles': 'operator',
      },
      payload: JSON.stringify({
        repo_full_name: 'khenson99/ralph-loop-orchestrator',
        epic_numbers: [123, 456],
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { accepted: Array<{ epic_number: number }> };
    expect(body.accepted.length).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it('dispatches selected project todo issues into workflow queue', async () => {
    const enqueue = vi.fn();
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/project-todos/dispatch',
      headers: {
        'content-type': 'application/json',
        'x-ralph-user': 'alice',
        'x-ralph-roles': 'operator',
      },
      payload: JSON.stringify({
        repo_full_name: 'khenson99/ralph-loop-orchestrator',
        project_number: 7,
        issue_numbers: [123],
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { accepted: Array<{ issue_number: number }>; project_number: number };
    expect(body.project_number).toBe(7);
    expect(body.accepted.length).toBe(1);
    expect(body.accepted[0]?.issue_number).toBe(123);
    expect(enqueue).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('lists runtime processes and logs', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: {
        ...runtimeSupervisorStub,
        listProcesses: () => [
          {
            process_id: 'planner',
            display_name: 'Planner',
            status: 'running',
            pid: 12345,
            run_count: 4,
            last_started_at: '2026-02-12T00:00:00Z',
            last_stopped_at: null,
            last_exit_code: null,
            last_signal: null,
            command: 'bash',
            args: ['/repo/scripts/run-planner.sh', '--prd', '/repo/PRD.md'],
            error: null,
          },
        ],
        listLogs: () => [
          {
            seq: 10,
            process_id: 'planner',
            run_id: 4,
            timestamp: '2026-02-12T00:01:00Z',
            stream: 'stdout',
            line: 'Planner iteration 2',
          },
        ],
      },
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const processResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/runtime/processes',
    });
    expect(processResponse.statusCode).toBe(200);
    const processBody = JSON.parse(processResponse.body) as {
      items: Array<{ process_id: string; status: string }>;
    };
    expect(processBody.items[0]).toMatchObject({ process_id: 'planner', status: 'running' });

    const logsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/runtime/processes/planner/logs?limit=20',
    });
    expect(logsResponse.statusCode).toBe(200);
    const logsBody = JSON.parse(logsResponse.body) as {
      items: Array<{ process_id: string; line: string }>;
    };
    expect(logsBody.items[0]).toMatchObject({ process_id: 'planner', line: 'Planner iteration 2' });

    await app.close();
  });

  it('enforces auth for runtime process actions', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const anonymousResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime/processes/planner/actions/start',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ reason: 'run planner' }),
    });
    expect(anonymousResponse.statusCode).toBe(401);

    const forbiddenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime/processes/planner/actions/start',
      headers: {
        'content-type': 'application/json',
        'x-ralph-user': 'alice',
        'x-ralph-roles': 'viewer',
      },
      payload: JSON.stringify({ reason: 'run planner' }),
    });
    expect(forbiddenResponse.statusCode).toBe(403);

    await app.close();
  });

  it('serves the built-in frontend app', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/app',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/app/index.html');

    const indexResponse = await app.inject({
      method: 'GET',
      url: '/app/index.html',
    });
    expect(indexResponse.statusCode).toBe(200);
    expect(indexResponse.headers['content-type']).toContain('text/html');
    expect(indexResponse.body).toContain('<!doctype html>');
    expect(indexResponse.body).toContain('World-Class Orchestrator Console');

    const scriptResponse = await app.inject({
      method: 'GET',
      url: '/app/main.js',
    });
    expect(scriptResponse.statusCode).toBe(200);
    expect(scriptResponse.headers['content-type']).toContain('application/javascript');

    const appConfigResponse = await app.inject({
      method: 'GET',
      url: '/app/app-config.js',
    });
    expect(appConfigResponse.statusCode).toBe(200);
    expect(appConfigResponse.body).toContain('window.__RALPH_CONFIG__');

    await app.close();
  });

  it('injects runtime API base into app config script when configured', async () => {
    const app = buildServer({
      config: {
        ...config,
        uiRuntimeApiBase: 'https://api.staging.example.com',
      },
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const appConfigResponse = await app.inject({
      method: 'GET',
      url: '/app/app-config.js',
    });
    expect(appConfigResponse.statusCode).toBe(200);
    expect(appConfigResponse.body).toContain('https://api.staging.example.com');

    await app.close();
  });

  it('returns a kanban board response', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub({
        listBoardCards: async () => [
          {
            runId: 'run-1',
            issueNumber: 123,
            prNumber: 44,
            status: 'in_progress',
            currentStage: 'SubtasksDispatched',
            updatedAt: new Date('2026-02-11T21:00:00Z').toISOString(),
            taskCounts: { queued: 0, running: 1, retry: 0, completed: 1, failed: 0 },
          },
        ],
      }),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/boards/default',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      board_id: string;
      cards: Record<string, { lane: string; owner: { display_name: string }; signals: { ci_status: string } }>;
    };
    expect(body.board_id).toBe('default');
    expect(body.cards['run-1']).toBeDefined();
    const card = body.cards['run-1'];
    expect(card).toBeDefined();
    expect(card?.lane).toBe('execute');
    expect(card?.owner.display_name).toBe('Orchestrator');
    expect(card?.signals.ci_status).toBe('unknown');

    await app.close();
  });

  it('returns v1 recent run and task summaries', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub({
        listRecentRuns: async () => [
          {
            id: 'run-1',
            status: 'in_progress',
            currentStage: 'SubtasksDispatched',
            issueNumber: 123,
            prNumber: 44,
            createdAt: new Date('2026-02-11T20:00:00Z'),
            updatedAt: new Date('2026-02-11T21:00:00Z'),
          },
        ],
        listRecentTasks: async () => [
          {
            id: 'task-1',
            workflowRunId: 'run-1',
            taskKey: 'MVP-1',
            status: 'running',
            attempts: 2,
            createdAt: new Date('2026-02-11T20:10:00Z'),
            updatedAt: new Date('2026-02-11T21:05:00Z'),
          },
        ],
      }),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const runsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/runs/recent?limit=20',
    });
    expect(runsResponse.statusCode).toBe(200);
    const runsBody = JSON.parse(runsResponse.body) as {
      items: Array<{ id: string; current_stage: string }>;
    };
    expect(runsBody.items[0]).toMatchObject({ id: 'run-1', current_stage: 'SubtasksDispatched' });

    const tasksResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/tasks/recent?limit=20',
    });
    expect(tasksResponse.statusCode).toBe(200);
    const tasksBody = JSON.parse(tasksResponse.body) as {
      items: Array<{ id: string; task_key: string }>;
    };
    expect(tasksBody.items[0]).toMatchObject({ id: 'task-1', task_key: 'MVP-1' });

    await app.close();
  });

  it('returns live PR checks in task detail response', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub({
        getTaskDetail: async () => ({
          cardBase: {
            id: 'task-1',
            workflowRunId: 'run-1',
            taskKey: 'MVP-1',
            title: 'Build board page',
            ownerRole: 'frontend',
            status: 'running',
            attemptCount: 2,
            createdAt: new Date('2026-02-11T20:00:00Z'),
            updatedAt: new Date('2026-02-11T21:00:00Z'),
            issueNumber: 123,
            prNumber: 44,
            currentStage: 'InReview',
            sourceOwner: 'khenson99',
            sourceRepo: 'ralph-loop-orchestrator',
          },
          run: {
            id: 'run-1',
            status: 'in_progress',
            currentStage: 'InReview',
            specId: 'spec-1',
          },
          task: {
            id: 'task-1',
            taskKey: 'MVP-1',
            title: 'Build board page',
            ownerRole: 'frontend',
            status: 'running',
            attempts: 2,
            definitionOfDone: ['board exists'],
            dependsOn: [],
            lastResult: null,
          },
          attempts: [],
          artifacts: [],
          timeline: [],
        }),
      }),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/tasks/task-1/detail',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      pull_request: { overall_status: string; checks: Array<{ required: boolean }> } | null;
      card: { signals: { ci_status: string } };
    };
    expect(body.pull_request).not.toBeNull();
    expect(body.pull_request?.overall_status).toBe('passing');
    expect(body.pull_request?.checks.length).toBe(2);
    expect(body.pull_request?.checks.every((check) => check.required)).toBe(true);
    expect(body.card.signals.ci_status).toBe('passing');

    await app.close();
  });

  it('requires authentication for task actions', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/task-1/actions/retry',
      payload: JSON.stringify({ reason: 'Try again' }),
      headers: {
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'authentication_required' });

    await app.close();
  });

  it('enforces role permissions for task actions', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/task-1/actions/block',
      payload: JSON.stringify({ reason: 'Pause for review' }),
      headers: {
        'content-type': 'application/json',
        'x-ralph-user': 'alice',
        'x-ralph-roles': 'operator',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'forbidden', action: 'block' });

    await app.close();
  });

  it('requires a reason for task actions', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      autonomyManager: new AutonomyManager('pr_only'),
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/task-1/actions/retry',
      payload: JSON.stringify({}),
      headers: {
        'content-type': 'application/json',
        'x-ralph-user': 'alice',
        'x-ralph-roles': 'operator',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'reason_required' });

    await app.close();
  });
});
