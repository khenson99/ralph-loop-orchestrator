import { describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/api/server.js';
import {
  AutonomyManager,
  AutonomyModeSchema,
  AutonomyTransitionError,
  isValidTransition,
  listAllowedTransitions,
  type AutonomyMode,
} from '../src/lib/autonomy.js';
import { createLogger } from '../src/lib/logger.js';
import { canAutoMerge, canCreatePR, canExecuteSubtask } from '../src/lib/policy.js';

// ---------------------------------------------------------------------------
// 1. Mode validation
// ---------------------------------------------------------------------------

describe('AutonomyModeSchema', () => {
  it('accepts all valid modes', () => {
    for (const mode of ['dry_run', 'pr_only', 'limited_auto_merge', 'full_merge_queue'] as const) {
      expect(AutonomyModeSchema.parse(mode)).toBe(mode);
    }
  });

  it('rejects invalid mode strings', () => {
    expect(() => AutonomyModeSchema.parse('turbo')).toThrow();
    expect(() => AutonomyModeSchema.parse('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Transition rules
// ---------------------------------------------------------------------------

describe('isValidTransition', () => {
  it('allows single-step forward transitions', () => {
    expect(isValidTransition('dry_run', 'pr_only')).toBe(true);
    expect(isValidTransition('pr_only', 'limited_auto_merge')).toBe(true);
    expect(isValidTransition('limited_auto_merge', 'full_merge_queue')).toBe(true);
  });

  it('allows single-step backward transitions', () => {
    expect(isValidTransition('pr_only', 'dry_run')).toBe(true);
    expect(isValidTransition('limited_auto_merge', 'pr_only')).toBe(true);
    expect(isValidTransition('full_merge_queue', 'limited_auto_merge')).toBe(true);
  });

  it('allows emergency stop to dry_run from any mode', () => {
    expect(isValidTransition('limited_auto_merge', 'dry_run')).toBe(true);
    expect(isValidTransition('full_merge_queue', 'dry_run')).toBe(true);
  });

  it('blocks skipping steps (e.g. dry_run -> limited_auto_merge)', () => {
    expect(isValidTransition('dry_run', 'limited_auto_merge')).toBe(false);
    expect(isValidTransition('dry_run', 'full_merge_queue')).toBe(false);
    expect(isValidTransition('pr_only', 'full_merge_queue')).toBe(false);
  });

  it('blocks no-op same-mode transition', () => {
    for (const mode of ['dry_run', 'pr_only', 'limited_auto_merge', 'full_merge_queue'] as const) {
      expect(isValidTransition(mode, mode)).toBe(false);
    }
  });
});

describe('listAllowedTransitions', () => {
  it('returns correct allowed targets for each mode', () => {
    expect(listAllowedTransitions('dry_run')).toEqual(['pr_only']);
    expect(listAllowedTransitions('pr_only')).toEqual(['dry_run', 'limited_auto_merge']);
    expect(listAllowedTransitions('limited_auto_merge')).toEqual([
      'dry_run',
      'pr_only',
      'full_merge_queue',
    ]);
    expect(listAllowedTransitions('full_merge_queue')).toEqual([
      'dry_run',
      'limited_auto_merge',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. AutonomyManager
// ---------------------------------------------------------------------------

describe('AutonomyManager', () => {
  it('initialises with the given mode', () => {
    const mgr = new AutonomyManager('pr_only');
    expect(mgr.mode).toBe('pr_only');
    expect(mgr.history).toEqual([]);
  });

  it('rejects invalid initial mode', () => {
    expect(() => new AutonomyManager('turbo' as AutonomyMode)).toThrow();
  });

  it('records a valid transition', () => {
    const mgr = new AutonomyManager('pr_only');
    const record = mgr.transition({
      to: 'limited_auto_merge',
      changedBy: 'admin-alice',
      reason: 'staging looks stable',
    });

    expect(mgr.mode).toBe('limited_auto_merge');
    expect(record.from).toBe('pr_only');
    expect(record.to).toBe('limited_auto_merge');
    expect(record.changedBy).toBe('admin-alice');
    expect(record.reason).toBe('staging looks stable');
    expect(typeof record.changedAt).toBe('string');
    expect(mgr.history).toHaveLength(1);
  });

  it('throws AutonomyTransitionError for invalid transition', () => {
    const mgr = new AutonomyManager('dry_run');
    try {
      mgr.transition({ to: 'full_merge_queue', changedBy: 'admin', reason: 'yolo' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AutonomyTransitionError);
      const transitionError = err as AutonomyTransitionError;
      expect(transitionError.from).toBe('dry_run');
      expect(transitionError.to).toBe('full_merge_queue');
    }
    // mode should remain unchanged
    expect(mgr.mode).toBe('dry_run');
  });

  it('keeps a cumulative audit history across transitions', () => {
    const mgr = new AutonomyManager('dry_run');
    mgr.transition({ to: 'pr_only', changedBy: 'admin', reason: 'step 1' });
    mgr.transition({ to: 'limited_auto_merge', changedBy: 'admin', reason: 'step 2' });
    mgr.transition({ to: 'full_merge_queue', changedBy: 'admin', reason: 'step 3' });
    expect(mgr.history).toHaveLength(3);
    expect(mgr.history[0]?.from).toBe('dry_run');
    expect(mgr.history[2]?.to).toBe('full_merge_queue');
  });
});

// ---------------------------------------------------------------------------
// 4. Policy enforcement
// ---------------------------------------------------------------------------

describe('canCreatePR', () => {
  it('blocks in dry_run', () => {
    expect(canCreatePR('dry_run').allowed).toBe(false);
  });

  it('allows in pr_only, limited_auto_merge, full_merge_queue', () => {
    expect(canCreatePR('pr_only').allowed).toBe(true);
    expect(canCreatePR('limited_auto_merge').allowed).toBe(true);
    expect(canCreatePR('full_merge_queue').allowed).toBe(true);
  });

  it('logs when logger is provided', () => {
    const logger = createLogger('silent');
    const spy = vi.spyOn(logger, 'info');
    canCreatePR('pr_only', logger);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('canAutoMerge', () => {
  it('blocks in dry_run regardless of checks', () => {
    expect(canAutoMerge('dry_run', true, true).allowed).toBe(false);
  });

  it('blocks in pr_only regardless of checks', () => {
    expect(canAutoMerge('pr_only', true, true).allowed).toBe(false);
  });

  it('blocks in limited_auto_merge when checks fail', () => {
    expect(canAutoMerge('limited_auto_merge', false, true).allowed).toBe(false);
  });

  it('blocks in limited_auto_merge when human has not approved', () => {
    expect(canAutoMerge('limited_auto_merge', true, false).allowed).toBe(false);
    expect(canAutoMerge('limited_auto_merge', true).allowed).toBe(false);
  });

  it('allows in limited_auto_merge when checks pass AND human approved', () => {
    expect(canAutoMerge('limited_auto_merge', true, true).allowed).toBe(true);
  });

  it('blocks in full_merge_queue when checks fail', () => {
    expect(canAutoMerge('full_merge_queue', false).allowed).toBe(false);
  });

  it('allows in full_merge_queue when checks pass (no human gate)', () => {
    expect(canAutoMerge('full_merge_queue', true).allowed).toBe(true);
    expect(canAutoMerge('full_merge_queue', true, false).allowed).toBe(true);
  });
});

describe('canExecuteSubtask', () => {
  it('blocks in dry_run', () => {
    expect(canExecuteSubtask('dry_run').allowed).toBe(false);
  });

  it('allows in all other modes', () => {
    expect(canExecuteSubtask('pr_only').allowed).toBe(true);
    expect(canExecuteSubtask('limited_auto_merge').allowed).toBe(true);
    expect(canExecuteSubtask('full_merge_queue').allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. API routes
// ---------------------------------------------------------------------------

const testConfig = {
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
  requiredChecks: [] as string[],
  otelEnabled: false,
  dryRun: true,
  autonomyMode: 'pr_only' as const,
  corsAllowedOrigins: [] as string[],
  uiUnifiedConsole: true,
  uiRuntimeApiBase: undefined,
  runtimeSupervisor: {
    plannerPrdPath: undefined,
    plannerMaxIterations: 10,
    teamMaxIterations: 20,
    reviewerMaxIterations: 10,
    maxLogLines: 4000,
  },
};

const githubStub: Parameters<typeof buildServer>[0]['github'] = {
  getPullRequestChecksSnapshot: async (prNumber, requiredChecks) => ({
    prNumber,
    title: 'PR',
    url: `https://github.com/khenson99/ralph-loop-orchestrator/pull/${prNumber}`,
    state: 'open',
    draft: false,
    mergeable: true,
    headSha: 'abc',
    checks: requiredChecks.map((name) => ({
      name,
      status: 'completed' as const,
      conclusion: 'success' as const,
      detailsUrl: null,
      startedAt: '2026-02-11T00:00:00Z',
      completedAt: '2026-02-11T00:01:00Z',
      required: true,
    })),
    requiredCheckNames: requiredChecks,
    overallStatus: 'passing',
  }),
  listAccessibleRepositories: async () => [],
  listEpicIssues: async () => [],
  listRepositoryProjects: async () => [],
  listProjectTodoIssues: async () => [],
};

const runtimeSupervisorStub: Parameters<typeof buildServer>[0]['runtimeSupervisor'] = {
  listProcesses: () => [],
  listLogs: () => [],
  executeAction: async ({ processId }) => ({
    accepted: true,
    process: {
      process_id: processId,
      display_name: processId,
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

function createWorkflowRepoStub() {
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
  };
}

function buildApp(autonomyManager: AutonomyManager = new AutonomyManager('pr_only')) {
  return buildServer({
    config: testConfig,
    dbClient: { ready: async () => true },
    workflowRepo: createWorkflowRepoStub(),
    github: githubStub,
    orchestrator: { enqueue: vi.fn() },
    runtimeSupervisor: runtimeSupervisorStub,
    autonomyManager,
    logger: createLogger('silent'),
  });
}

describe('GET /api/v1/autonomy/status', () => {
  it('returns current mode and empty history', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/autonomy/status' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      mode: string;
      history: unknown[];
      generated_at: string;
    };
    expect(body.mode).toBe('pr_only');
    expect(body.history).toEqual([]);
    expect(body.generated_at).toBeDefined();
    await app.close();
  });

  it('reflects mode changes in status', async () => {
    const mgr = new AutonomyManager('pr_only');
    mgr.transition({ to: 'limited_auto_merge', changedBy: 'admin', reason: 'promote' });
    const app = buildApp(mgr);
    const response = await app.inject({ method: 'GET', url: '/api/v1/autonomy/status' });
    const body = JSON.parse(response.body) as {
      mode: string;
      history: Array<{ from: string; to: string }>;
    };
    expect(body.mode).toBe('limited_auto_merge');
    expect(body.history).toHaveLength(1);
    expect(body.history[0]).toMatchObject({ from: 'pr_only', to: 'limited_auto_merge' });
    await app.close();
  });
});

describe('POST /api/v1/autonomy/mode', () => {
  it('requires authentication', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/autonomy/mode',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ mode: 'dry_run', reason: 'test' }),
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('requires admin role', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/autonomy/mode',
      headers: {
        'content-type': 'application/json',
        'x-ralph-user': 'alice',
        'x-ralph-roles': 'operator',
      },
      payload: JSON.stringify({ mode: 'dry_run', reason: 'test' }),
    });
    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body) as { error: string; required_roles: string[] };
    expect(body.required_roles).toContain('admin');
    await app.close();
  });

  it('rejects invalid mode value', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/autonomy/mode',
      headers: {
        'content-type': 'application/json',
        'x-ralph-user': 'admin-bob',
        'x-ralph-roles': 'admin',
      },
      payload: JSON.stringify({ mode: 'turbo', reason: 'test' }),
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'invalid_mode' });
    await app.close();
  });

  it('requires a reason', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/autonomy/mode',
      headers: {
        'content-type': 'application/json',
        'x-ralph-user': 'admin-bob',
        'x-ralph-roles': 'admin',
      },
      payload: JSON.stringify({ mode: 'dry_run' }),
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'reason_required' });
    await app.close();
  });

  it('succeeds for admin with valid mode and reason', async () => {
    const mgr = new AutonomyManager('pr_only');
    const app = buildApp(mgr);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/autonomy/mode',
      headers: {
        'content-type': 'application/json',
        'x-ralph-user': 'admin-bob',
        'x-ralph-roles': 'admin',
      },
      payload: JSON.stringify({
        mode: 'limited_auto_merge',
        reason: 'CI stable for 24h',
      }),
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      mode: string;
      transition: { from: string; to: string; changedBy: string; reason: string };
    };
    expect(body.mode).toBe('limited_auto_merge');
    expect(body.transition.from).toBe('pr_only');
    expect(body.transition.changedBy).toBe('admin-bob');
    expect(mgr.mode).toBe('limited_auto_merge');
    await app.close();
  });

  it('returns 409 for invalid transition', async () => {
    const mgr = new AutonomyManager('dry_run');
    const app = buildApp(mgr);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/autonomy/mode',
      headers: {
        'content-type': 'application/json',
        'x-ralph-user': 'admin-bob',
        'x-ralph-roles': 'admin',
      },
      payload: JSON.stringify({
        mode: 'full_merge_queue',
        reason: 'skip ahead',
      }),
    });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as { error: string; from: string; to: string };
    expect(body.error).toBe('invalid_transition');
    expect(body.from).toBe('dry_run');
    expect(body.to).toBe('full_merge_queue');
    expect(mgr.mode).toBe('dry_run');
    await app.close();
  });
});
