import crypto from 'node:crypto';

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
  requiredChecks: [],
  otelEnabled: false,
  dryRun: true,
};

function sign(payload: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

describe('telemetry boundary instrumentation', () => {
  it('records webhook boundary metrics for accepted deliveries', async () => {
    const app = buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => null,
        getTaskView: async () => null,
        recordEventIfNew: async () => ({ inserted: true, eventId: 'evt-b1' }),
      },
      orchestrator: { enqueue: vi.fn() },
      logger: createLogger('silent'),
    });

    const payload = JSON.stringify({
      action: 'opened',
      issue: {
        number: 52,
        html_url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/52',
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
        'x-github-delivery': 'delivery-boundary-1',
        'x-hub-signature-256': sign(payload, config.github.webhookSecret),
      },
    });
    expect(response.statusCode).toBe(202);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('ralph_orchestration_boundary_calls_total');
    expect(metrics.body).toContain('boundary="webhook.verify_signature",result="success"');
    expect(metrics.body).toContain('boundary="webhook.parse_payload",result="success"');
    expect(metrics.body).toContain('boundary="webhook.record_event",result="success"');
    expect(metrics.body).toContain('boundary="webhook.enqueue",result="success"');

    await app.close();
  });
});
