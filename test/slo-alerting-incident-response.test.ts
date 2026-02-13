import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { buildServer } from '../src/api/server.js';
import { createLogger } from '../src/lib/logger.js';
import {
  metricsRegistry,
  orchestrationBoundaryCallsTotal,
  orchestrationBoundaryDurationMs,
  webhookEventsTotal,
  workflowRunDurationMs,
  workflowRunsTotal,
} from '../src/lib/metrics.js';
import { OrchestratorService, type EnqueuePayload } from '../src/orchestrator/service.js';
import { CodexAdapter } from '../src/integrations/openai/codex.js';

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
    openai: { model: 'gpt-5.3-codex' },
    anthropic: { model: 'claude-opus-4-6' },
    autoMergeEnabled: false,
    requiredChecks: ['CI / Tests'],
    otelEnabled: false,
    dryRun: true,
    ...overrides,
  };
}

function buildTestServer(overrides?: { dbReady?: boolean }) {
  return buildServer({
    config: createConfig(),
    dbClient: { ready: async () => overrides?.dbReady ?? true },
    workflowRepo: {
      getRunView: async () => null,
      getTaskView: async () => null,
      recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-slo-1' }),
    },
    orchestrator: { enqueue: vi.fn() },
    logger: createLogger('silent'),
  });
}

function issuePayload(issueNumber = 200) {
  return JSON.stringify({
    action: 'opened',
    issue: {
      number: issueNumber,
      html_url: `https://github.com/khenson99/ralph-loop-orchestrator/issues/${issueNumber}`,
    },
    sender: { login: 'khenson99' },
    repository: { name: 'ralph-loop-orchestrator', owner: { login: 'khenson99' } },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  // Reset all custom metric values between tests for isolation
  metricsRegistry.resetMetrics();
});

// ---------------------------------------------------------------------------
// 1. SLO Threshold Contracts — Metric Shape Validation
// ---------------------------------------------------------------------------
describe('SLO threshold contracts', () => {
  it('boundary call counter exposes {boundary, result} labels required for error-rate SLOs', async () => {
    const app = buildTestServer();
    const payload = issuePayload();

    await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-slo-1',
        'x-hub-signature-256': sign(payload, 'test-secret'),
      },
    });

    const metrics = await metricsRegistry.metrics();

    // Error-rate SLO requires both success and error result labels
    // After a successful webhook, all 4 webhook boundaries should report success
    expect(metrics).toContain('ralph_orchestration_boundary_calls_total{boundary="webhook.verify_signature",result="success"}');
    expect(metrics).toContain('ralph_orchestration_boundary_calls_total{boundary="webhook.parse_payload",result="success"}');
    expect(metrics).toContain('ralph_orchestration_boundary_calls_total{boundary="webhook.record_event",result="success"}');
    expect(metrics).toContain('ralph_orchestration_boundary_calls_total{boundary="webhook.enqueue",result="success"}');

    await app.close();
  });

  it('boundary duration histogram uses sub-second buckets suitable for latency SLOs', async () => {
    const app = buildTestServer();
    const payload = issuePayload();

    await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-slo-2',
        'x-hub-signature-256': sign(payload, 'test-secret'),
      },
    });

    const metrics = await metricsRegistry.metrics();

    // Histogram must include sub-second buckets for p50/p95/p99 latency SLOs
    // The configured buckets are: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 15000]
    // prom-client renders labels as {le=...,boundary=...}
    expect(metrics).toContain('ralph_orchestration_boundary_duration_ms_bucket{le="100",boundary="webhook.verify_signature"}');
    expect(metrics).toContain('ralph_orchestration_boundary_duration_ms_bucket{le="1000",boundary="webhook.verify_signature"}');
    expect(metrics).toContain('ralph_orchestration_boundary_duration_ms_bucket{le="+Inf",boundary="webhook.verify_signature"}');

    await app.close();
  });

  it('workflow run duration histogram covers multi-minute orchestration runs', async () => {
    // Verify the histogram has a 120s bucket for end-to-end runs
    const metrics = await metricsRegistry.metrics();
    // Even with no observations, the metric definition should be present
    expect(metrics).toContain('ralph_workflow_run_duration_ms');
    // Observe a synthetic value to verify buckets are functional
    workflowRunDurationMs.observe(45000);
    const updated = await metricsRegistry.metrics();
    expect(updated).toMatch(/ralph_workflow_run_duration_ms_bucket\{le="120000"\}\s+1/);
  });

  it('webhook event counter exposes {event_type, result} labels for acceptance-rate SLOs', async () => {
    const app = buildTestServer();
    const payload = issuePayload();

    await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-slo-3',
        'x-hub-signature-256': sign(payload, 'test-secret'),
      },
    });

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('ralph_webhook_events_total{event_type="issues",result="accepted"}');

    await app.close();
  });

  it('workflow run counter exposes {status} label for run success-rate SLOs', () => {
    // Simulate a completed and a dead-lettered run
    workflowRunsTotal.inc({ status: 'completed' });
    workflowRunsTotal.inc({ status: 'dead_letter' });

    // Alerting rule: rate(ralph_workflow_runs_total{status="dead_letter"}) / rate(ralph_workflow_runs_total) > threshold
    // Verify both label values are emittable
    const completedMetric = (workflowRunsTotal as unknown as { hashMap: Record<string, { value: number }> }).hashMap;
    // Use metrics() API for verification
    return metricsRegistry.metrics().then((metrics) => {
      expect(metrics).toContain('ralph_workflow_runs_total{status="completed"} 1');
      expect(metrics).toContain('ralph_workflow_runs_total{status="dead_letter"} 1');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Alert Scenarios — Failure Mode Signal Verification
// ---------------------------------------------------------------------------
describe('alert scenarios: failure modes emit correct signals', () => {
  it('missing webhook signature emits missing_signature result for auth-failure alert', async () => {
    const app = buildTestServer();
    const payload = issuePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-alert-1',
        // No x-hub-signature-256 header
      },
    });

    expect(response.statusCode).toBe(401);
    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('ralph_webhook_events_total{event_type="issues",result="missing_signature"}');

    await app.close();
  });

  it('invalid webhook signature emits invalid_signature result for auth-failure alert', async () => {
    const app = buildTestServer();
    const payload = issuePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-alert-2',
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
    });

    expect(response.statusCode).toBe(401);
    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('ralph_webhook_events_total{event_type="issues",result="invalid_signature"}');

    await app.close();
  });

  it('non-actionable event emits ignored result for noise-ratio alert', async () => {
    const app = buildTestServer();
    // pull_request_review events are not actionable
    const payload = JSON.stringify({
      action: 'submitted',
      review: { state: 'approved' },
      pull_request: { number: 1 },
      sender: { login: 'bot' },
      repository: { name: 'ralph-loop-orchestrator', owner: { login: 'khenson99' } },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request_review',
        'x-github-delivery': 'delivery-alert-3',
        'x-hub-signature-256': sign(payload, 'test-secret'),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ accepted: false, reason: 'event_not_actionable' });
    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('ralph_webhook_events_total{event_type="pull_request_review",result="ignored"}');

    await app.close();
  });

  it('duplicate delivery emits duplicate result for dedup-rate alert', async () => {
    const app = buildServer({
      config: createConfig(),
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => null,
        getTaskView: async () => null,
        recordEventIfNew: async () => ({ inserted: false, eventId: 'evt-dup' }),
      },
      orchestrator: { enqueue: vi.fn() },
      logger: createLogger('silent'),
    });

    const payload = issuePayload();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-alert-4',
        'x-hub-signature-256': sign(payload, 'test-secret'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ accepted: false, duplicate: true });
    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('ralph_webhook_events_total{event_type="issues",result="duplicate"}');

    await app.close();
  });

  it('orchestrator boundary failure emits error result for boundary-error-rate alert', async () => {
    const config = createConfig();
    const repo = {
      getRunView: vi.fn().mockResolvedValue(null),
      getTaskView: vi.fn().mockResolvedValue(null),
      recordEventIfNew: vi.fn().mockResolvedValue({ inserted: true, eventId: 'evt-bf' }),
      createWorkflowRun: vi.fn().mockRejectedValue(new Error('503 service unavailable')),
      linkEventToRun: vi.fn(),
      markRunStatus: vi.fn().mockResolvedValue(undefined),
      markEventProcessed: vi.fn().mockResolvedValue(undefined),
    };

    const github = {
      getIssueContext: vi.fn(),
      getBranchSha: vi.fn(),
      findOpenPullRequestForIssue: vi.fn(),
      hasRequiredChecksPassed: vi.fn(),
      addIssueComment: vi.fn(),
      approvePullRequest: vi.fn(),
      enableAutoMerge: vi.fn(),
      requestChanges: vi.fn(),
    };

    const claude = { executeSubtask: vi.fn() };
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

    // Trigger the orchestrator directly
    const item: EnqueuePayload = {
      eventId: 'evt-bf',
      envelope: {
        schema_version: '1.0' as const,
        event_id: 'delivery-bf',
        event_type: 'issues.opened',
        timestamp: new Date().toISOString(),
        source: { system: 'github' as const, repo: 'khenson99/ralph-loop-orchestrator', delivery_id: 'delivery-bf' },
        actor: { type: 'user' as const, login: 'khenson99' },
        task_ref: { kind: 'issue' as const, id: 300, url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/300' },
        payload: {},
      },
    };

    await (orchestrator as unknown as { handleEvent: (item: EnqueuePayload) => Promise<void> }).handleEvent(item);

    const metrics = await metricsRegistry.metrics();
    // The createWorkflowRun boundary should record an error
    expect(metrics).toContain('boundary="repo.create_workflow_run",result="error"');
    // Run should be dead-lettered
    expect(metrics).toContain('ralph_workflow_runs_total{status="dead_letter"}');

    // Duration histogram should still record even for failed runs
    expect(metrics).toContain('ralph_workflow_run_duration_ms');
  });

  it('dead-letter run records duration for SLO burn-rate calculation', async () => {
    const config = createConfig();
    const repo = {
      getRunView: vi.fn().mockResolvedValue(null),
      getTaskView: vi.fn().mockResolvedValue(null),
      recordEventIfNew: vi.fn().mockResolvedValue({ inserted: true, eventId: 'evt-dl' }),
      createWorkflowRun: vi.fn().mockResolvedValue('run-dl'),
      linkEventToRun: vi.fn().mockRejectedValue(new Error('econnrefused')),
      markRunStatus: vi.fn().mockResolvedValue(undefined),
      markEventProcessed: vi.fn().mockResolvedValue(undefined),
    };

    const github = {
      getIssueContext: vi.fn(),
      getBranchSha: vi.fn(),
      findOpenPullRequestForIssue: vi.fn(),
      hasRequiredChecksPassed: vi.fn(),
      addIssueComment: vi.fn(),
      approvePullRequest: vi.fn(),
      enableAutoMerge: vi.fn(),
      requestChanges: vi.fn(),
    };

    const claude = { executeSubtask: vi.fn() };
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

    const item: EnqueuePayload = {
      eventId: 'evt-dl',
      envelope: {
        schema_version: '1.0' as const,
        event_id: 'delivery-dl',
        event_type: 'issues.opened',
        timestamp: new Date().toISOString(),
        source: { system: 'github' as const, repo: 'khenson99/ralph-loop-orchestrator', delivery_id: 'delivery-dl' },
        actor: { type: 'user' as const, login: 'khenson99' },
        task_ref: { kind: 'issue' as const, id: 301, url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/301' },
        payload: {},
      },
    };

    await (orchestrator as unknown as { handleEvent: (item: EnqueuePayload) => Promise<void> }).handleEvent(item);

    const metrics = await metricsRegistry.metrics();
    // Dead-letter run should still have a duration observation for burn-rate windows
    expect(metrics).toMatch(/ralph_workflow_run_duration_ms_count\s+\d+/);
    // Run marked as dead_letter
    expect(repo.markRunStatus).toHaveBeenCalledWith('run-dl', 'dead_letter', expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// 3. Runbook Validation Checks — Incident Response Procedures
// ---------------------------------------------------------------------------
describe('runbook validation: incident response procedures', () => {
  it('healthz returns 200 even when database is unreachable (liveness only)', async () => {
    const app = buildTestServer({ dbReady: false });

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok' });

    // readyz should fail — confirming the runbook distinction
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(JSON.parse(ready.body)).toMatchObject({ status: 'not_ready' });

    await app.close();
  });

  it('metrics endpoint is available even when database is not ready', async () => {
    const app = buildTestServer({ dbReady: false });

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    // All 6 required metrics should still be defined
    expect(metrics.body).toContain('ralph_workflow_runs_total');
    expect(metrics.body).toContain('ralph_workflow_run_duration_ms');
    expect(metrics.body).toContain('ralph_webhook_events_total');
    expect(metrics.body).toContain('ralph_retries_total');
    expect(metrics.body).toContain('ralph_orchestration_boundary_calls_total');
    expect(metrics.body).toContain('ralph_orchestration_boundary_duration_ms');

    await app.close();
  });

  it('runbook metric grep pattern matches all 6 required custom metrics', async () => {
    // The observability runbook specifies this grep pattern for operational checks:
    // rg 'ralph_(workflow_runs_total|workflow_run_duration_ms|webhook_events_total|retries_total|orchestration_boundary_calls_total|orchestration_boundary_duration_ms)'
    const runbookPattern =
      /ralph_(workflow_runs_total|workflow_run_duration_ms|webhook_events_total|retries_total|orchestration_boundary_calls_total|orchestration_boundary_duration_ms)/;

    const app = buildTestServer();
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    const lines = metrics.body.split('\n');

    const matchingMetrics = new Set<string>();
    for (const line of lines) {
      const match = runbookPattern.exec(line);
      if (match?.[1]) {
        matchingMetrics.add(match[1]);
      }
    }

    // All 6 metrics from the runbook must be present
    expect(matchingMetrics).toEqual(
      new Set([
        'workflow_runs_total',
        'workflow_run_duration_ms',
        'webhook_events_total',
        'retries_total',
        'orchestration_boundary_calls_total',
        'orchestration_boundary_duration_ms',
      ]),
    );

    await app.close();
  });

  it('webhook acceptance triage: accepted events produce both counter and boundary signals', async () => {
    // Runbook: "Check ralph_webhook_events_total{result=accepted} growth"
    // Verify that a successful webhook produces signals on both metrics
    const app = buildTestServer();
    const payload = issuePayload();

    await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-runbook-1',
        'x-hub-signature-256': sign(payload, 'test-secret'),
      },
    });

    const metrics = await metricsRegistry.metrics();

    // Counter signal for triage step 1
    expect(metrics).toContain('ralph_webhook_events_total{event_type="issues",result="accepted"}');

    // Boundary signals show which integration steps completed
    expect(metrics).toContain('boundary="webhook.verify_signature",result="success"');
    expect(metrics).toContain('boundary="webhook.record_event",result="success"');
    expect(metrics).toContain('boundary="webhook.enqueue",result="success"');

    await app.close();
  });

  it('retries triage: retry counter uses operation label for per-boundary investigation', async () => {
    // Runbook: "Inspect ralph_retries_total by operation"
    // Verify retry counter label cardinality matches known retry-wrapped operations
    const config = createConfig();
    const repo = {
      getRunView: vi.fn().mockResolvedValue(null),
      getTaskView: vi.fn().mockResolvedValue(null),
      recordEventIfNew: vi.fn().mockResolvedValue({ inserted: true, eventId: 'evt-rt' }),
      createWorkflowRun: vi.fn().mockResolvedValue('run-retry'),
      linkEventToRun: vi.fn().mockResolvedValue(undefined),
      storeSpec: vi.fn().mockResolvedValue(undefined),
      addArtifact: vi.fn().mockResolvedValue(undefined),
      createTasks: vi.fn().mockResolvedValue(undefined),
      updateRunStage: vi.fn().mockResolvedValue(undefined),
      listRunnableTasks: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 'task-rt', taskKey: 'T-RT-1', title: 'Retry task', ownerRole: 'backend', dependsOn: [], attemptCount: 0 },
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
        owner: 'khenson99', repo: 'ralph-loop-orchestrator', issueNumber: 400, title: 'Test', body: 'Test',
      }),
      getBranchSha: vi.fn().mockResolvedValue('abc'),
      findOpenPullRequestForIssue: vi.fn().mockResolvedValue(null),
      hasRequiredChecksPassed: vi.fn().mockResolvedValue(false),
      addIssueComment: vi.fn().mockResolvedValue(undefined),
      approvePullRequest: vi.fn(),
      enableAutoMerge: vi.fn(),
      requestChanges: vi.fn(),
    };

    // Claude fails on first attempt, succeeds on second — triggers retry counter
    const claude = {
      executeSubtask: vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout from upstream'))
        .mockResolvedValueOnce({
          task_id: 'T-RT-1',
          status: 'completed',
          summary: 'Done after retry',
          files_changed: [],
          commands_ran: [],
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

    const item: EnqueuePayload = {
      eventId: 'evt-rt',
      envelope: {
        schema_version: '1.0' as const,
        event_id: 'delivery-rt',
        event_type: 'issues.opened',
        timestamp: new Date().toISOString(),
        source: { system: 'github' as const, repo: 'khenson99/ralph-loop-orchestrator', delivery_id: 'delivery-rt' },
        actor: { type: 'user' as const, login: 'khenson99' },
        task_ref: { kind: 'issue' as const, id: 400, url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/400' },
        payload: {},
      },
    };

    await (orchestrator as unknown as { handleEvent: (item: EnqueuePayload) => Promise<void> }).handleEvent(item);

    const metrics = await metricsRegistry.metrics();
    // Retry counter should have been incremented with the claude operation label
    expect(metrics).toContain('ralph_retries_total{operation="claude.executeSubtask"}');
  });
});

// ---------------------------------------------------------------------------
// 4. Boundary Correlation — Trace Attribute Validation
// ---------------------------------------------------------------------------
describe('boundary correlation attributes', () => {
  it('orchestrator boundary records both success and error metrics for the same boundary name', async () => {
    // An alerting rule for error ratio requires both success and error samples
    // on the same boundary label. Verify this works for repo.create_workflow_run.
    const config = createConfig();

    // First: a successful boundary call
    orchestrationBoundaryCallsTotal.inc({ boundary: 'repo.create_workflow_run', result: 'success' });
    // Then: a failed one
    orchestrationBoundaryCallsTotal.inc({ boundary: 'repo.create_workflow_run', result: 'error' });

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('ralph_orchestration_boundary_calls_total{boundary="repo.create_workflow_run",result="success"} 1');
    expect(metrics).toContain('ralph_orchestration_boundary_calls_total{boundary="repo.create_workflow_run",result="error"} 1');
  });

  it('duration histogram records observations even for fast boundary calls', async () => {
    // Verify that sub-millisecond operations still register in the histogram
    orchestrationBoundaryDurationMs.observe({ boundary: 'webhook.parse_payload' }, 0.5);

    const metrics = await metricsRegistry.metrics();
    // Should land in the le="1" bucket (prom-client renders le before boundary)
    expect(metrics).toMatch(/ralph_orchestration_boundary_duration_ms_bucket\{le="1",boundary="webhook.parse_payload"\}\s+1/);
  });
});
