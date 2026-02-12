import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.restoreAllMocks();
});

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
  getPullRequestChecksSnapshot: async (prNumber) => ({
    prNumber,
    title: `PR #${prNumber}`,
    url: `https://github.com/khenson99/ralph-loop-orchestrator/pull/${prNumber}`,
    state: 'open',
    draft: false,
    mergeable: true,
    headSha: 'abc123',
    checks: [],
    requiredCheckNames: [],
    overallStatus: 'unknown',
  }),
  listAccessibleRepositories: async () => [],
  listEpicIssues: async () => [],
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

describe('github webhook route', () => {
  it('accepts valid signed webhook and enqueues run', async () => {
    const enqueue = vi.fn();

    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue },
      runtimeSupervisor: runtimeSupervisorStub,
      logger: createLogger('silent'),
    });

    const payload = JSON.stringify({
      action: 'opened',
      issue: { number: 123, html_url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/123' },
      sender: { login: 'khenson99' },
      repository: { name: 'ralph-loop-orchestrator', owner: { login: 'khenson99' } },
    });

    const signature =
      'sha256=' + crypto.createHmac('sha256', config.github.webhookSecret).update(payload).digest('hex');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-1',
        'x-hub-signature-256': signature,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rejects invalid signature', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub(),
      github: githubStub,
      orchestrator: { enqueue: vi.fn() },
      runtimeSupervisor: runtimeSupervisorStub,
      logger: createLogger('silent'),
    });

    const payload = JSON.stringify({
      action: 'opened',
      issue: { number: 123, html_url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/123' },
      sender: { login: 'khenson99' },
      repository: { name: 'ralph-loop-orchestrator', owner: { login: 'khenson99' } },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-1',
        'x-hub-signature-256': 'sha256=badsignature',
      },
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('handles duplicate delivery idempotently', async () => {
    const enqueue = vi.fn();

    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: createWorkflowRepoStub({
        recordEventIfNew: async () => ({ inserted: false, eventId: 'evt-existing' }),
      }),
      github: githubStub,
      orchestrator: { enqueue },
      runtimeSupervisor: runtimeSupervisorStub,
      logger: createLogger('silent'),
    });

    const payload = JSON.stringify({
      action: 'opened',
      issue: { number: 123, html_url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/123' },
      sender: { login: 'khenson99' },
      repository: { name: 'ralph-loop-orchestrator', owner: { login: 'khenson99' } },
    });

    const signature =
      'sha256=' + crypto.createHmac('sha256', config.github.webhookSecret).update(payload).digest('hex');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-dup',
        'x-hub-signature-256': signature,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ accepted: false, duplicate: true });
    expect(enqueue).toHaveBeenCalledTimes(0);

    await app.close();
  });
});
