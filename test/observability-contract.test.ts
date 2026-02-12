import { describe, expect, it } from 'vitest';

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
};

function buildTestServer(dbReady: boolean) {
  return buildServer({
    config,
    dbClient: { ready: async () => dbReady },
    workflowRepo: {
      getRunView: async () => null,
      getTaskView: async () => null,
      recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-1' }),
    },
    orchestrator: { enqueue: () => {} },
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
