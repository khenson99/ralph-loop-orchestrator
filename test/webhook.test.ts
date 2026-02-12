import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AppServices, buildServer } from '../src/api/server.js';
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

function makePayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: 'opened',
    issue: { number: 123, html_url: 'https://github.com/khenson99/ralph-loop-orchestrator/issues/123' },
    sender: { login: 'khenson99' },
    repository: { name: 'ralph-loop-orchestrator', owner: { login: 'khenson99' } },
    ...overrides,
  });
}

function sign(payload: string, secret: string = config.github.webhookSecret): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function buildTestServer(overrides: {
  recordEventIfNew?: () => Promise<{ inserted: boolean; eventId: string }>;
  enqueue?: ReturnType<typeof vi.fn>;
} = {}) {
  const enqueue = overrides.enqueue ?? vi.fn();
  return {
    app: buildServer({
      config,
      dbClient: { ready: async () => true },
      workflowRepo: {
        getRunView: async () => null,
        getTaskView: async () => null,
        recordEventIfNew: overrides.recordEventIfNew ?? (async () => ({ inserted: true, eventId: 'evt-1' })),
      },
      orchestrator: { enqueue: enqueue as AppServices['orchestrator']['enqueue'] },
      logger: createLogger('silent'),
    }),
    enqueue,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('webhook signature verification', () => {
  it('accepts valid HMAC-SHA256 signed webhook and enqueues run', async () => {
    const { app, enqueue } = buildTestServer();
    const payload = makePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-1',
        'x-hub-signature-256': sign(payload),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ accepted: true, eventId: 'evt-1' });
    expect(enqueue).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rejects request with invalid signature with 401', async () => {
    const { app } = buildTestServer();
    const payload = makePayload();

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
    expect(JSON.parse(response.body)).toMatchObject({ error: 'invalid_signature' });

    await app.close();
  });

  it('rejects request with missing signature with 401', async () => {
    const { app } = buildTestServer();
    const payload = makePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-1',
        // no x-hub-signature-256 header
      },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'missing_signature' });

    await app.close();
  });
});

describe('delivery idempotency', () => {
  it('first delivery is accepted and enqueued', async () => {
    const recordEventIfNew = vi.fn().mockResolvedValue({ inserted: true, eventId: 'evt-new' });
    const { app, enqueue } = buildTestServer({ recordEventIfNew });
    const payload = makePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-first',
        'x-hub-signature-256': sign(payload),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ accepted: true, eventId: 'evt-new' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(recordEventIfNew).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'delivery-first' }),
    );

    await app.close();
  });

  it('duplicate delivery returns 200 OK and is not re-processed', async () => {
    const recordEventIfNew = vi.fn().mockResolvedValue({ inserted: false, eventId: 'evt-existing' });
    const { app, enqueue } = buildTestServer({ recordEventIfNew });
    const payload = makePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-dup',
        'x-hub-signature-256': sign(payload),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ accepted: false, duplicate: true });
    expect(enqueue).toHaveBeenCalledTimes(0);

    await app.close();
  });

  it('delivery ID is passed through from X-GitHub-Delivery header', async () => {
    const recordEventIfNew = vi.fn().mockResolvedValue({ inserted: true, eventId: 'evt-1' });
    const { app } = buildTestServer({ recordEventIfNew });
    const payload = makePayload();
    const deliveryId = 'unique-uuid-delivery-abc123';

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(payload),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(recordEventIfNew).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId }),
    );

    await app.close();
  });
});

describe('webhook edge cases', () => {
  it('rejects request with missing event name', async () => {
    const { app } = buildTestServer();
    const payload = makePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        // no x-github-event
        'x-github-delivery': 'delivery-1',
        'x-hub-signature-256': sign(payload),
      },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('rejects request with missing delivery ID', async () => {
    const { app } = buildTestServer();
    const payload = makePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        // no x-github-delivery
        'x-hub-signature-256': sign(payload),
      },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('ignores non-actionable events', async () => {
    const { app, enqueue } = buildTestServer();
    const payload = makePayload({ action: 'deleted' });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-ignored',
        'x-hub-signature-256': sign(payload),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ accepted: false, reason: 'event_not_actionable' });
    expect(enqueue).toHaveBeenCalledTimes(0);

    await app.close();
  });
});
