import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import {
  extractIssueNumber,
  isActionableEvent,
  mapGithubWebhookToEnvelope,
  verifyGitHubSignature,
} from '../integrations/github/webhook.js';
import { metricsRegistry, webhookEventsTotal } from '../lib/metrics.js';
import {
  RunResponseSchema,
  TaskResponseSchema,
  type WebhookEventEnvelope,
} from '../schemas/contracts.js';

export type AppServices = {
  config: AppConfig;
  dbClient: {
    ready: () => Promise<boolean>;
  };
  workflowRepo: {
    getRunView: (runId: string) => Promise<
      | {
          id: string;
          status: string;
          currentStage: string;
          issueNumber: number | null;
          prNumber: number | null;
          specId: string | null;
          createdAt: Date;
          updatedAt: Date;
          tasks: Array<{ id: string; taskKey: string; status: string; attempts: number }>;
          artifacts: Array<{ id: string; kind: string; createdAt: Date }>;
        }
      | null
    >;
    getTaskView: (taskId: string) => Promise<
      | {
          id: string;
          workflowRunId: string;
          taskKey: string;
          status: string;
          attempts: number;
          lastResult: unknown;
          createdAt: Date;
          updatedAt: Date;
        }
      | null
    >;
    listRecentRuns: (limit?: number) => Promise<
      Array<{
        id: string;
        status: string;
        currentStage: string;
        issueNumber: number | null;
        prNumber: number | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >;
    listRecentTasks: (limit?: number) => Promise<
      Array<{
        id: string;
        workflowRunId: string;
        taskKey: string;
        status: string;
        attempts: number;
        createdAt: Date;
        updatedAt: Date;
      }>
    >;
    recordEventIfNew: (params: {
      deliveryId: string;
      eventType: string;
      sourceOwner: string;
      sourceRepo: string;
      payload: Record<string, unknown>;
    }) => Promise<{ inserted: boolean; eventId: string }>;
  };
  orchestrator: {
    enqueue: (item: { eventId: string; envelope: WebhookEventEnvelope }) => void;
  };
  logger: Logger;
};

export function buildServer(services: AppServices) {
  const app = Fastify({ loggerInstance: services.logger });

  app.register(sensible);
  app.register(cors, {
    origin:
      services.config.corsAllowedOrigins.length === 0
        ? false
        : services.config.corsAllowedOrigins,
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    done(null, body);
  });

  app.get('/healthz', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/readyz', async (_, reply) => {
    const ready = await services.dbClient.ready();
    if (!ready) {
      return reply.status(503).send({ status: 'not_ready' });
    }

    return { status: 'ready' };
  });

  app.get('/metrics', async (_, reply) => {
    reply.header('Content-Type', metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  app.get('/api/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await services.workflowRepo.getRunView(runId);

    if (!run) {
      return reply.status(404).send({ error: 'run_not_found' });
    }

    const response = RunResponseSchema.parse({
      ...run,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      tasks: run.tasks,
      artifacts: run.artifacts.map((artifact) => ({
        ...artifact,
        createdAt: artifact.createdAt.toISOString(),
      })),
    });

    return response;
  });

  app.get('/api/runs', async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsedLimit = Number.parseInt(limit ?? '50', 10);
    const rows = await services.workflowRepo.listRecentRuns(Number.isFinite(parsedLimit) ? parsedLimit : 50);

    return {
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        currentStage: row.currentStage,
        issueNumber: row.issueNumber,
        prNumber: row.prNumber,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  });

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = await services.workflowRepo.getTaskView(taskId);

    if (!task) {
      return reply.status(404).send({ error: 'task_not_found' });
    }

    const response = TaskResponseSchema.parse({
      ...task,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    });

    return response;
  });

  app.get('/api/tasks', async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsedLimit = Number.parseInt(limit ?? '100', 10);
    const rows = await services.workflowRepo.listRecentTasks(Number.isFinite(parsedLimit) ? parsedLimit : 100);

    return {
      items: rows.map((row) => ({
        id: row.id,
        workflowRunId: row.workflowRunId,
        taskKey: row.taskKey,
        status: row.status,
        attempts: row.attempts,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  });

  app.post('/webhooks/github', async (request, reply) => {
    const eventName = String(request.headers['x-github-event'] ?? '');
    const deliveryId = String(request.headers['x-github-delivery'] ?? '');
    const signature = String(request.headers['x-hub-signature-256'] ?? '');
    const rawBody = request.body;

    if (!eventName || !deliveryId || !signature || typeof rawBody !== 'string') {
      webhookEventsTotal.inc({ event_type: eventName || 'unknown', result: 'bad_request' });
      return reply.status(400).send({ error: 'missing_required_headers_or_body' });
    }

    const valid = await verifyGitHubSignature({
      secret: services.config.github.webhookSecret,
      payload: rawBody,
      signature,
    });

    if (!valid) {
      webhookEventsTotal.inc({ event_type: eventName, result: 'invalid_signature' });
      return reply.status(401).send({ error: 'invalid_signature' });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      webhookEventsTotal.inc({ event_type: eventName, result: 'invalid_json' });
      return reply.status(400).send({ error: 'invalid_json' });
    }

    if (!isActionableEvent(eventName, payload)) {
      webhookEventsTotal.inc({ event_type: eventName, result: 'ignored' });
      return reply.status(202).send({ accepted: false, reason: 'event_not_actionable' });
    }

    const issueNumber = extractIssueNumber(payload);
    if (issueNumber === null) {
      webhookEventsTotal.inc({ event_type: eventName, result: 'missing_issue_number' });
      return reply.status(202).send({ accepted: false, reason: 'missing_issue_number' });
    }

    const envelope = mapGithubWebhookToEnvelope({
      eventName,
      deliveryId,
      payload,
    });

    const eventResult = await services.workflowRepo.recordEventIfNew({
      deliveryId,
      eventType: envelope.event_type,
      sourceOwner: services.config.github.targetOwner,
      sourceRepo: services.config.github.targetRepo,
      payload,
    });

    if (!eventResult.inserted) {
      webhookEventsTotal.inc({ event_type: eventName, result: 'duplicate' });
      return reply.status(202).send({ accepted: false, duplicate: true });
    }

    services.orchestrator.enqueue({
      eventId: eventResult.eventId,
      envelope,
    });

    webhookEventsTotal.inc({ event_type: eventName, result: 'accepted' });
    return reply.status(202).send({ accepted: true, eventId: eventResult.eventId });
  });

  return app;
}
