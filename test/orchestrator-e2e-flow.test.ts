import crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { CodexAdapter } from '../src/integrations/openai/codex.js';
import { createLogger } from '../src/lib/logger.js';
import { OrchestratorService, type EnqueuePayload } from '../src/orchestrator/service.js';
import { buildServer } from '../src/api/server.js';

function sign(payload: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
    databaseUrl: 'postgres://example',
    github: {
      webhookSecret: 'test-secret',
      targetOwner: 'khenson99',
      targetRepo: 'ralph-loop-orchestrator',
      baseBranch: 'main',
    },
    openai: {
      model: 'gpt-5.3-codex',
    },
    anthropic: {
      model: 'claude-opus-4-6',
    },
    autoMergeEnabled: false,
    requiredChecks: ['CI / Tests', 'CI / Lint + Typecheck'],
    otelEnabled: false,
    dryRun: true,
    ...overrides,
  };
}

function createHarness(params: { checksPassed: boolean; prNumber: number | null }) {
  const config = createConfig();
  const runId = 'run_e2e_1';
  const taskId = 'task_e2e_1';
  const queued: EnqueuePayload[] = [];

  const repo = {
    // API server methods
    getRunView: vi.fn().mockResolvedValue(null),
    getTaskView: vi.fn().mockResolvedValue(null),
    recordEventIfNew: vi.fn().mockResolvedValue({ inserted: true, eventId: 'evt_e2e_1' }),

    // Orchestrator methods
    createWorkflowRun: vi.fn().mockResolvedValue(runId),
    linkEventToRun: vi.fn().mockResolvedValue(undefined),
    storeSpec: vi.fn().mockResolvedValue(undefined),
    addArtifact: vi.fn().mockResolvedValue(undefined),
    createTasks: vi.fn().mockResolvedValue(undefined),
    updateRunStage: vi.fn().mockResolvedValue(undefined),
    listRunnableTasks: vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: taskId,
          taskKey: 'T123-1',
          title: 'Implement task',
          ownerRole: 'backend-engineer',
          dependsOn: [],
          attemptCount: 0,
        },
      ])
      .mockResolvedValueOnce([]),
    markTaskRunning: vi.fn().mockResolvedValue(undefined),
    markTaskResult: vi.fn().mockResolvedValue(undefined),
    addAgentAttempt: vi.fn().mockResolvedValue(undefined),
    setRunPrNumber: vi.fn().mockResolvedValue(undefined),
    addMergeDecision: vi.fn().mockResolvedValue(undefined),
    countPendingTasks: vi.fn().mockResolvedValue(0),
    markRunStatus: vi.fn().mockResolvedValue(undefined),
    markEventProcessed: vi.fn().mockResolvedValue(undefined),
  };

  const github = {
    getIssueContext: vi.fn().mockResolvedValue({
      owner: 'khenson99',
      repo: 'ralph-loop-orchestrator',
      issueNumber: 123,
      title: 'E2E issue',
      body: 'Implement e2e flow',
    }),
    getBranchSha: vi.fn().mockResolvedValue('abc123'),
    findOpenPullRequestForIssue: vi.fn().mockResolvedValue(params.prNumber),
    hasRequiredChecksPassed: vi.fn().mockResolvedValue(params.checksPassed),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    approvePullRequest: vi.fn().mockResolvedValue(undefined),
    enableAutoMerge: vi.fn().mockResolvedValue(undefined),
    requestChanges: vi.fn().mockResolvedValue(undefined),
  };

  const claude = {
    executeSubtask: vi.fn().mockResolvedValue({
      task_id: 'T123-1',
      status: 'completed',
      summary: 'Implemented task',
      files_changed: ['src/example.ts'],
      commands_ran: [{ cmd: 'npm run test', exit_code: 0 }],
      open_questions: [],
      handoff_notes: '',
    }),
  };

  const codex = new CodexAdapter(config.openai, true);
  const logger = createLogger('silent');

  const orchestrator = new OrchestratorService(
    repo as never,
    github as never,
    codex,
    claude as never,
    config,
    logger,
  );

  const app = buildServer({
    config,
    dbClient: { ready: async () => true },
    workflowRepo: repo as never,
    orchestrator: {
      enqueue: (item) => {
        queued.push(item);
      },
    },
    logger,
  });

  return { app, repo, github, queued, orchestrator, config };
}

describe('orchestrator E2E flow: webhook -> spec -> PR/checks -> merge decision', () => {
  it('approves when webhook is accepted and required checks pass', async () => {
    const { app, queued, orchestrator, repo, github, config } = createHarness({
      checksPassed: true,
      prNumber: 321,
    });

    const payload = JSON.stringify({
      action: 'opened',
      issue: {
        number: 123,
        html_url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/123',
      },
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
        'x-github-delivery': 'delivery-e2e-1',
        'x-hub-signature-256': sign(payload, config.github.webhookSecret),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(queued).toHaveLength(1);
    const queuedItem = queued[0];
    expect(queuedItem).toBeDefined();

    await (orchestrator as unknown as { handleEvent: (item: EnqueuePayload) => Promise<void> }).handleEvent(
      queuedItem as EnqueuePayload,
    );

    expect(repo.storeSpec).toHaveBeenCalledTimes(1);
    expect(repo.createTasks).toHaveBeenCalledTimes(1);
    expect(repo.markTaskResult).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'completed' }),
      'completed',
    );
    expect(github.hasRequiredChecksPassed).toHaveBeenCalledWith(
      321,
      config.requiredChecks,
    );
    expect(github.approvePullRequest).toHaveBeenCalledTimes(1);
    expect(github.requestChanges).not.toHaveBeenCalled();
    expect(repo.addMergeDecision).toHaveBeenCalledWith(
      expect.any(String),
      321,
      expect.objectContaining({ decision: 'approve' }),
    );
    expect(repo.markRunStatus).toHaveBeenCalledWith(expect.any(String), 'completed');

    await app.close();
  });

  it('requests changes when required checks fail', async () => {
    const { app, queued, orchestrator, repo, github, config } = createHarness({
      checksPassed: false,
      prNumber: 654,
    });

    const payload = JSON.stringify({
      action: 'opened',
      issue: {
        number: 123,
        html_url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/123',
      },
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
        'x-github-delivery': 'delivery-e2e-2',
        'x-hub-signature-256': sign(payload, config.github.webhookSecret),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(queued).toHaveLength(1);
    const queuedItem = queued[0];
    expect(queuedItem).toBeDefined();

    await (orchestrator as unknown as { handleEvent: (item: EnqueuePayload) => Promise<void> }).handleEvent(
      queuedItem as EnqueuePayload,
    );

    expect(github.hasRequiredChecksPassed).toHaveBeenCalledWith(
      654,
      config.requiredChecks,
    );
    expect(github.approvePullRequest).not.toHaveBeenCalled();
    expect(github.requestChanges).toHaveBeenCalledTimes(1);
    expect(repo.addMergeDecision).toHaveBeenCalledWith(
      expect.any(String),
      654,
      expect.objectContaining({ decision: 'request_changes' }),
    );
    expect(repo.markRunStatus).toHaveBeenCalledWith(expect.any(String), 'completed');

    await app.close();
  });
});
