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
  requiredChecks: ['CI / Lint + Typecheck', 'CI / Tests'],
  otelEnabled: false,
  dryRun: true,
  corsAllowedOrigins: [],
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
};

describe('frontend API routes', () => {
  it('returns auth context and action permissions', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
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

  it('dispatches selected epics into workflow queue', async () => {
    const enqueue = vi.fn();
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue },
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

  it('serves the built-in frontend app', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      logger: createLogger('silent'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/app',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<!doctype html>');
    expect(response.body).toContain('Ralph Loop Control Board');

    await app.close();
  });

  it('returns a kanban board response', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub({
        listBoardCards: async () => [
          {
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
            latestAttempt: { id: 'attempt-1', status: 'running' },
            latestMergeDecision: null,
          },
        ],
      }),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
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
    expect(body.cards['task-1']).toBeDefined();
    const card = body.cards['task-1'];
    expect(card).toBeDefined();
    expect(card?.lane).toBe('in_progress');
    expect(card?.owner.display_name).toBe('Frontend');
    expect(card?.signals.ci_status).toBe('passing');

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
