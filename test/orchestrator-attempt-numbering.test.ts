import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { OrchestratorService } from '../src/orchestrator/service.js';
import type { FormalSpecV1 } from '../src/schemas/contracts.js';

describe('OrchestratorService attempt numbering', () => {
  it('uses outer task execution numbering across retry-fail then success', async () => {
    const runId = 'run_1';
    const taskId = 'task_1';

    const repo = {
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
            taskKey: 'T1',
            title: 'Implement task',
            ownerRole: 'backend',
            dependsOn: [],
            attemptCount: 0,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: taskId,
            taskKey: 'T1',
            title: 'Implement task',
            ownerRole: 'backend',
            dependsOn: [],
            attemptCount: 1,
          },
        ])
        .mockResolvedValueOnce([]),
      markTaskRunning: vi.fn().mockResolvedValue(undefined),
      markTaskResult: vi.fn().mockResolvedValue(undefined),
      addAgentAttempt: vi.fn().mockResolvedValue(undefined),
      getRunView: vi.fn().mockResolvedValue({ tasks: [] }),
      addMergeDecision: vi.fn().mockResolvedValue(undefined),
      setRunPrNumber: vi.fn().mockResolvedValue(undefined),
      countPendingTasks: vi.fn().mockResolvedValue(0),
      markRunStatus: vi.fn().mockResolvedValue(undefined),
      markEventProcessed: vi.fn().mockResolvedValue(undefined),
    };

    const github = {
      getIssueContext: vi.fn().mockResolvedValue({
        owner: 'khenson99',
        repo: 'ralph-loop-orchestrator',
        issueNumber: 11,
        title: 'Workflow state durability',
        body: 'Implement #11',
      }),
      getBranchSha: vi.fn().mockResolvedValue('abc123'),
      findOpenPullRequestForIssue: vi.fn().mockResolvedValue(null),
      hasRequiredChecksPassed: vi.fn().mockResolvedValue(false),
      addIssueComment: vi.fn().mockResolvedValue(undefined),
      approvePullRequest: vi.fn().mockResolvedValue(undefined),
      enableAutoMerge: vi.fn().mockResolvedValue(undefined),
      requestChanges: vi.fn().mockResolvedValue(undefined),
    };

    const spec: FormalSpecV1 = {
      spec_version: 1,
      spec_id: 'spec_1',
      source: {
        github: {
          repo: 'khenson99/ralph-loop-orchestrator',
          issue: 11,
          commit_baseline: 'abc123',
        },
      },
      objective: 'test',
      non_goals: [],
      constraints: {
        languages: [],
        allowed_paths: [],
        forbidden_paths: [],
      },
      acceptance_criteria: ['ac'],
      design_notes: {},
      work_breakdown: [
        {
          id: 'T1',
          title: 'Implement task',
          owner_role: 'backend',
          definition_of_done: [],
          depends_on: [],
        },
      ],
      risk_checks: [],
      validation_plan: {
        ci_jobs: [],
      },
      stop_conditions: [],
    };

    const codex = {
      generateFormalSpec: vi.fn().mockResolvedValue({
        spec,
        rawYaml: 'spec_version: 1',
      }),
      summarizeReview: vi.fn().mockResolvedValue('review'),
      generateMergeDecision: vi.fn().mockResolvedValue({
        decision: 'approve',
        rationale: 'ok',
        blocking_findings: [],
      }),
    };

    let executeCalls = 0;
    const claude = {
      executeSubtask: vi.fn().mockImplementation(async () => {
        executeCalls += 1;
        if (executeCalls <= 3) {
          throw new Error('timeout');
        }
        return {
          task_id: 'T1',
          status: 'completed',
          summary: 'done',
          files_changed: [],
          commands_ran: [],
          open_questions: [],
          handoff_notes: '',
        };
      }),
    };

    const config: AppConfig = {
      nodeEnv: 'test',
      port: 3000,
      logLevel: 'info',
      databaseUrl: 'postgres://localhost/test',
      github: {
        webhookSecret: 'secret',
        baseBranch: 'main',
        targetOwner: 'khenson99',
        targetRepo: 'ralph-loop-orchestrator',
      },
      openai: {
        model: 'gpt-5.3-codex',
      },
      anthropic: {
        model: 'claude-opus-4-6',
      },
      autoMergeEnabled: false,
      requiredChecks: [],
      otelEnabled: false,
      dryRun: false,
    };

    const logger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };

    const service = new OrchestratorService(
      repo as never,
      github as never,
      codex as never,
      claude as never,
      config,
      logger as never,
    );

    await (service as unknown as { handleEvent: (item: unknown) => Promise<void> }).handleEvent({
      eventId: 'evt_1',
      envelope: {
        event_id: 'evt_1',
        event_type: 'task.requested',
        schema_version: '1.0',
        timestamp: new Date().toISOString(),
        source: {
          system: 'github',
          repo: 'khenson99/ralph-loop-orchestrator',
          delivery_id: 'delivery_1',
        },
        actor: {
          type: 'user',
          login: 'khenson99',
        },
        task_ref: {
          kind: 'issue',
          id: 11,
          url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/11',
        },
        payload: {},
      },
    });

    const attempts = repo.addAgentAttempt.mock.calls.map((call) => call[0]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(expect.objectContaining({ attemptNumber: 1, status: 'failed' }));
    expect(attempts[1]).toEqual(expect.objectContaining({ attemptNumber: 2, status: 'completed' }));
  });
});
