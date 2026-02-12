import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import type { PullRequestChecksSnapshot, RepoRef } from '../integrations/github/client.js';
import {
  extractIssueNumber,
  isActionableEvent,
  mapGithubWebhookToEnvelope,
  verifyGitHubSignature,
} from '../integrations/github/webhook.js';
import { metricsRegistry, webhookEventsTotal } from '../lib/metrics.js';
import {
  AuthMeResponseSchema,
  BoardResponseSchema,
  EpicDispatchResponseSchema,
  EpicListResponseSchema,
  ProjectListResponseSchema,
  ProjectTodoDispatchResponseSchema,
  ProjectTodoListResponseSchema,
  RepoListResponseSchema,
  RuntimeActionResponseSchema,
  RuntimeLogsResponseSchema,
  RuntimeProcessIdSchema,
  RuntimeProcessListResponseSchema,
  RunResponseSchema,
  TaskActionResponseSchema,
  TaskDetailResponseSchema,
  TaskResponseSchema,
  TimelineEventSchema,
  type BoardCard,
  type RuntimeProcessId,
  type WebhookEventEnvelope,
} from '../schemas/contracts.js';
import type { WorkflowRepository } from '../state/repository.js';
import { FRONTEND_APP_HTML, readUnifiedFrontendAsset } from './frontend-app.js';
import type {
  RuntimeProcessAction as SupervisorProcessAction,
  RuntimeProcessSnapshot,
  RuntimeSupervisorEvent,
} from '../runtime/process-supervisor.js';

type LaneId = 'intake' | 'spec_drafting' | 'ready' | 'in_progress' | 'in_review' | 'blocked' | 'done';
type UserRole = 'viewer' | 'operator' | 'reviewer' | 'admin';
type TaskAction = 'retry' | 'retry_attempt' | 'reassign' | 'escalate' | 'block' | 'unblock';
type RuntimeAction = 'start' | 'stop' | 'restart';

const laneOrder: Array<{ lane: LaneId; wip_limit: number }> = [
  { lane: 'intake', wip_limit: 20 },
  { lane: 'spec_drafting', wip_limit: 10 },
  { lane: 'ready', wip_limit: 20 },
  { lane: 'in_progress', wip_limit: 10 },
  { lane: 'in_review', wip_limit: 10 },
  { lane: 'blocked', wip_limit: 99 },
  { lane: 'done', wip_limit: 99 },
];

type StreamClient = {
  id: number;
  topics: Set<string>;
  send: (params: { event: string; payload: Record<string, unknown>; id?: string }) => void;
  dispose: () => void;
};

type WorkflowRepoContract = Pick<
  WorkflowRepository,
  | 'applyTaskAction'
  | 'getRunView'
  | 'getTaskDetail'
  | 'getTaskView'
  | 'listBoardCards'
  | 'listRecentRuns'
  | 'listRecentTasks'
  | 'listTaskTimeline'
  | 'recordEventIfNew'
>;

type RuntimeSupervisorContract = {
  listProcesses: () => RuntimeProcessSnapshot[];
  listLogs: (
    processId: RuntimeProcessId,
    limit?: number,
  ) => Array<{
    seq: number;
    process_id: RuntimeProcessId;
    run_id: number;
    timestamp: string;
    stream: 'stdout' | 'stderr' | 'system';
    line: string;
  }>;
  executeAction: (params: {
    processId: RuntimeProcessId;
    action: SupervisorProcessAction;
    requestedBy: string;
    reason: string;
    maxIterations?: number;
    prdPath?: string;
  }) => Promise<{ accepted: boolean; process: RuntimeProcessSnapshot; error?: string }>;
  subscribe: (listener: (event: RuntimeSupervisorEvent) => void) => () => void;
};

type GitHubContract = {
  getPullRequestChecksSnapshot: (
    prNumber: number,
    requiredChecks: string[],
    ref?: RepoRef,
  ) => Promise<PullRequestChecksSnapshot>;
  listAccessibleRepositories: (params?: {
    owner?: string;
    limit?: number;
  }) => Promise<
    Array<{
      owner: string;
      repo: string;
      fullName: string;
      private: boolean;
      defaultBranch: string;
      url: string;
    }>
  >;
  listEpicIssues: (
    ref: RepoRef,
    params?: { state?: 'open' | 'closed' | 'all'; limit?: number },
  ) => Promise<
    Array<{
      number: number;
      title: string;
      state: 'open' | 'closed';
      labels: string[];
      url: string;
      updatedAt: string;
      createdAt: string;
    }>
  >;
  listRepositoryProjects: (
    ref: RepoRef,
    params?: { includeClosed?: boolean; limit?: number },
  ) => Promise<
    Array<{
      id: string;
      number: number;
      title: string;
      url: string;
      closed: boolean;
      updatedAt: string;
    }>
  >;
  listProjectTodoIssues: (
    ref: RepoRef,
    projectNumber: number,
    params?: { limit?: number },
  ) => Promise<
    Array<{
      itemId: string;
      issueNumber: number;
      title: string;
      url: string;
      state: 'open' | 'closed';
      labels: string[];
      statusName: string | null;
      repositoryFullName: string;
    }>
  >;
};

export type AppServices = {
  config: AppConfig;
  dbClient: {
    ready: () => Promise<boolean>;
  };
  workflowRepo: WorkflowRepoContract;
  github: GitHubContract;
  orchestrator: {
    enqueue: (item: { eventId: string; envelope: WebhookEventEnvelope }) => void;
  };
  runtimeSupervisor: RuntimeSupervisorContract;
  logger: Logger;
};

function toLane(status: string, stage: string): LaneId {
  const normalizedStatus = status.toLowerCase();
  if (normalizedStatus === 'completed') {
    return 'done';
  }
  if (normalizedStatus === 'blocked' || normalizedStatus === 'failed') {
    return 'blocked';
  }
  if (normalizedStatus === 'running') {
    return 'in_progress';
  }
  if (normalizedStatus === 'queued' && stage === 'TaskRequested') {
    return 'intake';
  }
  if (normalizedStatus === 'queued' && stage.includes('Spec')) {
    return 'spec_drafting';
  }
  if (normalizedStatus === 'retry') {
    return 'ready';
  }
  if (stage.includes('Review') || stage.includes('Merge')) {
    return 'in_review';
  }
  return 'ready';
}

function inferPriority(taskKey: string, title: string): 'P0' | 'P1' | 'P2' | 'P3' {
  const haystack = `${taskKey} ${title}`.toLowerCase();
  if (haystack.includes('p0') || haystack.includes('critical')) {
    return 'P0';
  }
  if (haystack.includes('p1') || haystack.includes('high')) {
    return 'P1';
  }
  if (haystack.includes('p3') || haystack.includes('low')) {
    return 'P3';
  }
  return 'P2';
}

function displayOwner(ownerRole: string): string {
  const normalized = ownerRole.replace(/^agent:/, '').replaceAll('-', ' ');
  return normalized
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferCiStatus(status: string, mergeDecision: string | null): 'unknown' | 'pending' | 'passing' | 'failing' {
  if (mergeDecision === 'approve' || status === 'completed') {
    return 'passing';
  }
  if (mergeDecision === 'request_changes' || mergeDecision === 'block' || status === 'failed') {
    return 'failing';
  }
  if (status === 'running' || status === 'retry') {
    return 'pending';
  }
  return 'unknown';
}

function inferLlmVerdict(mergeDecision: string | null): 'unknown' | 'approved' | 'needs_changes' | 'blocked' {
  if (mergeDecision === 'approve') {
    return 'approved';
  }
  if (mergeDecision === 'request_changes') {
    return 'needs_changes';
  }
  if (mergeDecision === 'block') {
    return 'blocked';
  }
  return 'unknown';
}

function mapBoardCard(
  row: Awaited<ReturnType<WorkflowRepository['listBoardCards']>>[number],
  config: AppConfig,
  livePr: PullRequestChecksSnapshot | null = null,
): BoardCard {
  const sourceOwner = row.sourceOwner || config.github.targetOwner;
  const sourceRepo = row.sourceRepo || config.github.targetRepo;
  const lane = toLane(row.status, row.currentStage);
  const priority = inferPriority(row.taskKey, row.title);
  const ciStatus = livePr?.overallStatus ?? inferCiStatus(row.status, row.latestMergeDecision);
  const llmVerdict = inferLlmVerdict(row.latestMergeDecision);
  return {
    card_id: row.id,
    title: row.title,
    lane,
    status: row.status,
    priority,
    owner: {
      type: 'team',
      id: row.ownerRole,
      display_name: displayOwner(row.ownerRole),
    },
    attempt: {
      current_attempt_id: row.latestAttempt?.id ?? null,
      attempt_count: row.attemptCount,
      last_attempt_status: row.latestAttempt?.status ?? null,
    },
    signals: {
      ci_status: ciStatus,
      llm_review_verdict: llmVerdict,
      human_review_state: row.prNumber ? (llmVerdict === 'approved' ? 'approved' : 'requested') : 'none',
    },
    timestamps: {
      created_at: row.createdAt.toISOString(),
      last_updated_at: row.updatedAt.toISOString(),
      lane_entered_at: row.updatedAt.toISOString(),
    },
    links: {
      github_issue_url: row.issueNumber
        ? `https://github.com/${sourceOwner}/${sourceRepo}/issues/${row.issueNumber}`
        : null,
      pull_request_url:
        livePr?.url ??
        (row.prNumber ? `https://github.com/${sourceOwner}/${sourceRepo}/pull/${row.prNumber}` : null),
    },
    source: {
      owner: sourceOwner,
      repo: sourceRepo,
      full_name: `${sourceOwner}/${sourceRepo}`,
    },
    tags: [row.ownerRole, row.taskKey, `${sourceOwner}/${sourceRepo}`],
  };
}

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    if (body.trim().length === 0) {
      return {};
    }
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new Error('invalid_json');
    }
  }
  if (body && typeof body === 'object') {
    return body as Record<string, unknown>;
  }
  return {};
}

function normalizeAction(actionRaw: string):
  | TaskAction
  | null {
  const allowed = new Set(['retry', 'retry_attempt', 'reassign', 'escalate', 'block', 'unblock']);
  if (!allowed.has(actionRaw)) {
    return null;
  }
  return actionRaw as TaskAction;
}

function normalizeRuntimeAction(actionRaw: string): RuntimeAction | null {
  const allowed = new Set(['start', 'stop', 'restart']);
  if (!allowed.has(actionRaw)) {
    return null;
  }
  return actionRaw as RuntimeAction;
}

function hasTopic(topics: Set<string>, candidate: string): boolean {
  return topics.size === 0 || topics.has(candidate);
}

function splitRepoFullName(fullName: string): RepoRef | null {
  const value = fullName.trim();
  const parts = value.split('/');
  if (parts.length !== 2) {
    return null;
  }
  const owner = parts[0]?.trim();
  const repo = parts[1]?.trim();
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return String(value[0] ?? '').trim();
  }
  return '';
}

function parseRoles(value: string): Set<UserRole> {
  const roles = new Set<UserRole>();
  const allowed = new Set<UserRole>(['viewer', 'operator', 'reviewer', 'admin']);
  for (const raw of value.split(',')) {
    const role = raw.trim().toLowerCase() as UserRole;
    if (allowed.has(role)) {
      roles.add(role);
    }
  }
  return roles;
}

function getAuthContext(headers: Record<string, string | string[] | undefined>) {
  const userId = normalizeHeaderValue(headers['x-ralph-user']) || 'anonymous';
  const roleSource =
    normalizeHeaderValue(headers['x-ralph-roles']) || normalizeHeaderValue(headers['x-ralph-role']);
  const roles = parseRoles(roleSource);
  if (roles.size === 0) {
    roles.add('viewer');
  }
  const authenticated = userId !== 'anonymous';
  return { authenticated, userId, roles };
}

const actionRoleMap: Record<TaskAction, UserRole[]> = {
  retry: ['operator', 'reviewer', 'admin'],
  retry_attempt: ['operator', 'reviewer', 'admin'],
  reassign: ['operator', 'reviewer', 'admin'],
  escalate: ['operator', 'reviewer', 'admin'],
  block: ['reviewer', 'admin'],
  unblock: ['reviewer', 'admin'],
};

const runtimeActionRoleMap: Record<RuntimeAction, UserRole[]> = {
  start: ['operator', 'reviewer', 'admin'],
  stop: ['operator', 'reviewer', 'admin'],
  restart: ['operator', 'reviewer', 'admin'],
};

function listAllowedActions(roles: Set<UserRole>): TaskAction[] {
  const actions = Object.entries(actionRoleMap)
    .filter(([, allowedRoles]) => allowedRoles.some((role) => roles.has(role)))
    .map(([action]) => action as TaskAction);
  return actions;
}

export function buildServer(services: AppServices) {
  const app = Fastify({ loggerInstance: services.logger });
  const streamClients = new Map<number, StreamClient>();
  let streamClientId = 0;
  let streamEventSeq = 0;

  const broadcast = (params: {
    event: string;
    topics: string[];
    payload: Record<string, unknown>;
  }) => {
    const eventId = `evt-${Date.now()}-${++streamEventSeq}`;
    for (const client of streamClients.values()) {
      if (!params.topics.some((topic) => hasTopic(client.topics, topic))) {
        continue;
      }
      client.send({ event: params.event, payload: params.payload, id: eventId });
    }
  };

  const publishRuntimeEvent = (event: RuntimeSupervisorEvent) => {
    if (event.type === 'status') {
      broadcast({
        event: 'runtime.process',
        topics: ['runtime', `runtime_${event.process.process_id}`],
        payload: {
          action: event.action,
          process: event.process,
          occurred_at: new Date().toISOString(),
        },
      });
      return;
    }

    broadcast({
      event: 'runtime.log',
      topics: ['runtime', `runtime_${event.process_id}`],
      payload: {
        process_id: event.process_id,
        entry: event.entry,
      },
    });
  };

  const unsubscribeRuntimeEvents = services.runtimeSupervisor.subscribe(publishRuntimeEvent);

  const fetchLivePrSnapshots = async (prEntries: Array<{ prNumber: number; sourceOwner: string; sourceRepo: string }>) => {
    const deduped = new Map<string, { prNumber: number; sourceOwner: string; sourceRepo: string }>();
    for (const entry of prEntries) {
      const key = `${entry.sourceOwner}/${entry.sourceRepo}#${entry.prNumber}`;
      if (!deduped.has(key)) {
        deduped.set(key, entry);
      }
    }
    const results = await Promise.allSettled(
      [...deduped.values()].map(async (entry) => {
        const snapshot = await services.github.getPullRequestChecksSnapshot(
          entry.prNumber,
          services.config.requiredChecks,
          {
            owner: entry.sourceOwner,
            repo: entry.sourceRepo,
          },
        );
        return { key: `${entry.sourceOwner}/${entry.sourceRepo}#${entry.prNumber}`, snapshot };
      }),
    );
    const map = new Map<string, PullRequestChecksSnapshot>();
    for (const result of results) {
      if (result.status === 'fulfilled') {
        map.set(result.value.key, result.value.snapshot);
        continue;
      }
      services.logger.warn({ err: result.reason }, 'Failed to fetch live PR checks snapshot');
    }
    return map;
  };

  app.register(sensible);

  app.register(cors, {
    origin:
      services.config.corsAllowedOrigins.length === 0
        ? false
        : services.config.corsAllowedOrigins,
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  const unifiedMimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };

  const extensionFromPath = (path: string) => {
    const index = path.lastIndexOf('.');
    if (index < 0) {
      return '';
    }
    return path.slice(index);
  };

  app.addHook('onClose', async () => {
    unsubscribeRuntimeEvents();
  });

  app.get('/', async (_, reply) => {
    return reply.redirect('/app');
  });

  app.get('/app', async (_, reply) => {
    if (services.config.uiUnifiedConsole) {
      return reply.redirect('/app/index.html');
    }

    reply.type('text/html; charset=utf-8');
    return FRONTEND_APP_HTML;
  });

  app.get('/app/app-config.js', async (_, reply) => {
    if (!services.config.uiUnifiedConsole) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const runtimeApiBase = services.config.uiRuntimeApiBase
      ? JSON.stringify(services.config.uiRuntimeApiBase)
      : 'undefined';
    const payload = `window.__RALPH_CONFIG__ = Object.assign({}, window.__RALPH_CONFIG__ || {}, { apiBase: ${runtimeApiBase} });`;
    reply.type('application/javascript; charset=utf-8');
    return payload;
  });

  app.get('/app/*', async (request, reply) => {
    if (!services.config.uiUnifiedConsole) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const assetPath = String((request.params as { '*': string })['*'] ?? '').trim();
    if (!assetPath || assetPath === 'app-config.js' || assetPath.includes('..')) {
      return reply.status(404).send({ error: 'asset_not_found' });
    }

    const asset = readUnifiedFrontendAsset(assetPath);
    if (!asset) {
      return reply.status(404).send({ error: 'asset_not_found' });
    }

    const ext = extensionFromPath(assetPath);
    const mime = unifiedMimeTypes[ext] ?? 'text/plain; charset=utf-8';
    reply.type(mime);
    return asset;
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

  app.get('/api/v1/runs/recent', async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsedLimit = Number.parseInt(limit ?? '50', 10);
    const rows = await services.workflowRepo.listRecentRuns(Number.isFinite(parsedLimit) ? parsedLimit : 50);

    return {
      generated_at: new Date().toISOString(),
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        current_stage: row.currentStage,
        issue_number: row.issueNumber,
        pr_number: row.prNumber,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      })),
    };
  });

  app.get('/api/v1/tasks/recent', async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsedLimit = Number.parseInt(limit ?? '100', 10);
    const rows = await services.workflowRepo.listRecentTasks(Number.isFinite(parsedLimit) ? parsedLimit : 100);

    return {
      generated_at: new Date().toISOString(),
      items: rows.map((row) => ({
        id: row.id,
        workflow_run_id: row.workflowRunId,
        task_key: row.taskKey,
        status: row.status,
        attempts: row.attempts,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      })),
    };
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

  app.get('/api/v1/auth/me', async (request) => {
    const auth = getAuthContext(request.headers);
    return AuthMeResponseSchema.parse({
      authenticated: auth.authenticated,
      user_id: auth.userId,
      roles: [...auth.roles],
      permissions: {
        actions: listAllowedActions(auth.roles),
      },
    });
  });

  app.get('/api/v1/runtime/processes', async () => {
    return RuntimeProcessListResponseSchema.parse({
      generated_at: new Date().toISOString(),
      items: services.runtimeSupervisor.listProcesses(),
    });
  });

  app.get('/api/v1/runtime/processes/:processId/logs', async (request, reply) => {
    const { processId } = request.params as { processId: string };
    const parsedProcessId = RuntimeProcessIdSchema.safeParse(processId);
    if (!parsedProcessId.success) {
      return reply.status(404).send({ error: 'process_not_found' });
    }
    const query = request.query as { limit?: string };
    const parsedLimit = Number.parseInt(query.limit ?? '400', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 5000)) : 400;

    return RuntimeLogsResponseSchema.parse({
      process_id: parsedProcessId.data,
      generated_at: new Date().toISOString(),
      items: services.runtimeSupervisor.listLogs(parsedProcessId.data, limit),
    });
  });

  app.post('/api/v1/runtime/processes/:processId/actions/:action', async (request, reply) => {
    const { processId: rawProcessId, action: rawAction } = request.params as {
      processId: string;
      action: string;
    };
    const parsedProcessId = RuntimeProcessIdSchema.safeParse(rawProcessId);
    if (!parsedProcessId.success) {
      return reply.status(404).send({ error: 'process_not_found' });
    }

    const action = normalizeRuntimeAction(rawAction);
    if (!action) {
      return reply.status(404).send({ error: 'action_not_supported' });
    }

    const auth = getAuthContext(request.headers);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: 'authentication_required' });
    }

    const requiredRoles = runtimeActionRoleMap[action];
    const allowed = requiredRoles.some((role) => auth.roles.has(role));
    if (!allowed) {
      return reply.status(403).send({
        error: 'forbidden',
        action,
        required_roles: requiredRoles,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = parseJsonBody(request.body);
    } catch {
      return reply.status(400).send({ error: 'invalid_json' });
    }

    const reason =
      typeof body.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim()
        : `${action} requested`;
    const maxIterations =
      typeof body.max_iterations === 'number'
        ? body.max_iterations
        : typeof body.max_iterations === 'string'
          ? Number(body.max_iterations)
          : undefined;
    const prdPath = typeof body.prd_path === 'string' ? body.prd_path.trim() : undefined;

    const result = await services.runtimeSupervisor.executeAction({
      processId: parsedProcessId.data,
      action,
      requestedBy: auth.userId,
      reason,
      maxIterations: Number.isFinite(maxIterations) ? Number(maxIterations) : undefined,
      prdPath,
    });

    if (!result.accepted) {
      return reply.status(409).send({
        error: result.error ?? 'action_rejected',
        process: result.process,
      });
    }

    return RuntimeActionResponseSchema.parse({
      accepted: true,
      action,
      process: result.process,
      occurred_at: new Date().toISOString(),
    });
  });

  app.get('/api/v1/github/repos', async (request) => {
    const query = request.query as { owner?: string; limit?: string };
    const parsedLimit = Number.parseInt(query.limit ?? '200', 10);
    const repositories = await services.github.listAccessibleRepositories({
      owner: query.owner?.trim(),
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 200,
    });

    return RepoListResponseSchema.parse({
      generated_at: new Date().toISOString(),
      items: repositories.map((repo) => ({
        owner: repo.owner,
        repo: repo.repo,
        full_name: repo.fullName,
        private: repo.private,
        default_branch: repo.defaultBranch,
        url: repo.url,
      })),
    });
  });

  app.get('/api/v1/github/epics', async (request, reply) => {
    const query = request.query as { owner?: string; repo?: string; state?: string; limit?: string };
    const owner = query.owner?.trim();
    const repo = query.repo?.trim();
    if (!owner || !repo) {
      return reply.status(400).send({ error: 'owner_and_repo_required' });
    }
    const state = query.state === 'all' || query.state === 'closed' || query.state === 'open' ? query.state : 'open';
    const parsedLimit = Number.parseInt(query.limit ?? '200', 10);
    const epics = await services.github.listEpicIssues(
      { owner, repo },
      {
        state,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 200,
      },
    );

    return EpicListResponseSchema.parse({
      generated_at: new Date().toISOString(),
      owner,
      repo,
      items: epics.map((epic) => ({
        number: epic.number,
        title: epic.title,
        state: epic.state,
        labels: epic.labels,
        url: epic.url,
        updated_at: epic.updatedAt,
        created_at: epic.createdAt,
      })),
    });
  });

  app.get('/api/v1/github/projects', async (request, reply) => {
    const query = request.query as { owner?: string; repo?: string; state?: string; limit?: string };
    const owner = query.owner?.trim();
    const repo = query.repo?.trim();
    if (!owner || !repo) {
      return reply.status(400).send({ error: 'owner_and_repo_required' });
    }
    const includeClosed = query.state === 'all';
    const parsedLimit = Number.parseInt(query.limit ?? '100', 10);
    const projects = await services.github.listRepositoryProjects(
      { owner, repo },
      {
        includeClosed,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 100,
      },
    );

    return ProjectListResponseSchema.parse({
      generated_at: new Date().toISOString(),
      owner,
      repo,
      items: projects.map((project) => ({
        id: project.id,
        number: project.number,
        title: project.title,
        url: project.url,
        closed: project.closed,
        updated_at: project.updatedAt,
      })),
    });
  });

  app.get('/api/v1/github/project-todos', async (request, reply) => {
    const query = request.query as { owner?: string; repo?: string; project_number?: string; limit?: string };
    const owner = query.owner?.trim();
    const repo = query.repo?.trim();
    const projectNumber = Number.parseInt(query.project_number ?? '', 10);
    if (!owner || !repo || !Number.isInteger(projectNumber) || projectNumber <= 0) {
      return reply.status(400).send({ error: 'owner_repo_and_project_number_required' });
    }

    const parsedLimit = Number.parseInt(query.limit ?? '100', 10);
    const todos = await services.github.listProjectTodoIssues(
      { owner, repo },
      projectNumber,
      {
        limit: Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 100,
      },
    );

    return ProjectTodoListResponseSchema.parse({
      generated_at: new Date().toISOString(),
      owner,
      repo,
      project_number: projectNumber,
      items: todos.map((todo) => ({
        item_id: todo.itemId,
        issue_number: todo.issueNumber,
        title: todo.title,
        url: todo.url,
        state: todo.state,
        labels: todo.labels,
        status_name: todo.statusName,
        repository_full_name: todo.repositoryFullName,
      })),
    });
  });

  const dispatchIssueNumbers = async (params: {
    repoRef: RepoRef;
    issueNumbers: number[];
    requestedBy: string;
    deliveryPrefix: 'epic' | 'project_todo';
  }) => {
    const accepted: Array<{ issue_number: number; event_id: string }> = [];
    const duplicates: Array<{ issue_number: number; event_id: string }> = [];

    for (const issueNumber of params.issueNumbers) {
      const deliveryId = `manual-${params.deliveryPrefix}-${params.repoRef.owner}-${params.repoRef.repo}-${issueNumber}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 9)}`;
      const payload = {
        action: 'opened',
        issue: {
          number: issueNumber,
          html_url: `https://github.com/${params.repoRef.owner}/${params.repoRef.repo}/issues/${issueNumber}`,
        },
        sender: {
          login: params.requestedBy,
        },
        repository: {
          name: params.repoRef.repo,
          owner: { login: params.repoRef.owner },
        },
      };

      const envelope = mapGithubWebhookToEnvelope({
        eventName: 'issues',
        deliveryId,
        payload,
      });

      const eventResult = await services.workflowRepo.recordEventIfNew({
        deliveryId,
        eventType: envelope.event_type,
        sourceOwner: params.repoRef.owner,
        sourceRepo: params.repoRef.repo,
        payload,
      });

      if (!eventResult.inserted) {
        duplicates.push({ issue_number: issueNumber, event_id: eventResult.eventId });
        continue;
      }

      services.orchestrator.enqueue({
        eventId: eventResult.eventId,
        envelope,
      });
      accepted.push({ issue_number: issueNumber, event_id: eventResult.eventId });
    }

    return { accepted, duplicates };
  };

  app.post('/api/v1/epics/dispatch', async (request, reply) => {
    const auth = getAuthContext(request.headers);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: 'authentication_required' });
    }
    const dispatchRoles: UserRole[] = ['operator', 'reviewer', 'admin'];
    if (!dispatchRoles.some((role) => auth.roles.has(role))) {
      return reply.status(403).send({
        error: 'forbidden',
        required_roles: dispatchRoles,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = parseJsonBody(request.body);
    } catch {
      return reply.status(400).send({ error: 'invalid_json' });
    }

    const fullName = typeof body.repo_full_name === 'string' ? body.repo_full_name : '';
    const repoRef = splitRepoFullName(fullName);
    if (!repoRef) {
      return reply.status(400).send({ error: 'repo_full_name_required' });
    }

    const epicNumbersRaw = Array.isArray(body.epic_numbers) ? body.epic_numbers : [];
    const epicNumbers = [...new Set(epicNumbersRaw.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
    if (epicNumbers.length === 0) {
      return reply.status(400).send({ error: 'epic_numbers_required' });
    }

    const dispatch = await dispatchIssueNumbers({
      repoRef,
      issueNumbers: epicNumbers,
      requestedBy: auth.userId,
      deliveryPrefix: 'epic',
    });

    return EpicDispatchResponseSchema.parse({
      repo_full_name: `${repoRef.owner}/${repoRef.repo}`,
      requested_by: auth.userId,
      accepted: dispatch.accepted.map((item) => ({
        epic_number: item.issue_number,
        event_id: item.event_id,
      })),
      duplicates: dispatch.duplicates.map((item) => ({
        epic_number: item.issue_number,
        event_id: item.event_id,
      })),
      dispatched_at: new Date().toISOString(),
    });
  });

  app.post('/api/v1/project-todos/dispatch', async (request, reply) => {
    const auth = getAuthContext(request.headers);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: 'authentication_required' });
    }
    const dispatchRoles: UserRole[] = ['operator', 'reviewer', 'admin'];
    if (!dispatchRoles.some((role) => auth.roles.has(role))) {
      return reply.status(403).send({
        error: 'forbidden',
        required_roles: dispatchRoles,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = parseJsonBody(request.body);
    } catch {
      return reply.status(400).send({ error: 'invalid_json' });
    }

    const fullName = typeof body.repo_full_name === 'string' ? body.repo_full_name : '';
    const repoRef = splitRepoFullName(fullName);
    if (!repoRef) {
      return reply.status(400).send({ error: 'repo_full_name_required' });
    }

    const issueNumbersRaw = Array.isArray(body.issue_numbers) ? body.issue_numbers : [];
    const issueNumbers = [
      ...new Set(issueNumbersRaw.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)),
    ];
    if (issueNumbers.length === 0) {
      return reply.status(400).send({ error: 'issue_numbers_required' });
    }
    const projectNumberRaw = body.project_number;
    const projectNumber =
      typeof projectNumberRaw === 'number'
        ? projectNumberRaw
        : typeof projectNumberRaw === 'string'
          ? Number.parseInt(projectNumberRaw, 10)
          : null;

    const dispatch = await dispatchIssueNumbers({
      repoRef,
      issueNumbers,
      requestedBy: auth.userId,
      deliveryPrefix: 'project_todo',
    });

    return ProjectTodoDispatchResponseSchema.parse({
      repo_full_name: `${repoRef.owner}/${repoRef.repo}`,
      project_number: Number.isInteger(projectNumber) && Number(projectNumber) > 0 ? Number(projectNumber) : null,
      requested_by: auth.userId,
      accepted: dispatch.accepted,
      duplicates: dispatch.duplicates,
      dispatched_at: new Date().toISOString(),
    });
  });

  app.get('/api/v1/boards/default', async () => {
    const rows = await services.workflowRepo.listBoardCards();
    const prSnapshots = await fetchLivePrSnapshots(
      rows
        .filter((row) => row.prNumber !== null)
        .map((row) => ({
          prNumber: row.prNumber as number,
          sourceOwner: row.sourceOwner || services.config.github.targetOwner,
          sourceRepo: row.sourceRepo || services.config.github.targetRepo,
        })),
    );

    const cards = Object.fromEntries(
      rows.map((row) => {
        const sourceOwner = row.sourceOwner || services.config.github.targetOwner;
        const sourceRepo = row.sourceRepo || services.config.github.targetRepo;
        const key = row.prNumber ? `${sourceOwner}/${sourceRepo}#${row.prNumber}` : '';
        const livePr = row.prNumber ? prSnapshots.get(key) ?? null : null;
        const card = mapBoardCard(row, services.config, livePr);
        return [card.card_id, card];
      }),
    );

    const laneCards = new Map<LaneId, string[]>();
    for (const lane of laneOrder) {
      laneCards.set(lane.lane, []);
    }
    for (const row of rows) {
      const sourceOwner = row.sourceOwner || services.config.github.targetOwner;
      const sourceRepo = row.sourceRepo || services.config.github.targetRepo;
      const key = row.prNumber ? `${sourceOwner}/${sourceRepo}#${row.prNumber}` : '';
      const livePr = row.prNumber ? prSnapshots.get(key) ?? null : null;
      const card = mapBoardCard(row, services.config, livePr);
      const laneKey = card.lane as LaneId;
      if (!laneCards.has(laneKey)) {
        continue;
      }
      laneCards.get(laneKey)?.push(card.card_id);
    }

    return BoardResponseSchema.parse({
      board_id: 'default',
      generated_at: new Date().toISOString(),
      lanes: laneOrder.map((lane) => ({
        lane: lane.lane,
        wip_limit: lane.wip_limit,
        cards: laneCards.get(lane.lane) ?? [],
      })),
      cards,
    });
  });

  app.get('/api/v1/tasks/:taskId/detail', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const detail = await services.workflowRepo.getTaskDetail(taskId);
    if (!detail) {
      return reply.status(404).send({ error: 'task_not_found' });
    }

    const latestAttempt = detail.attempts[0] ?? null;
    const livePr =
      detail.cardBase.prNumber !== null
        ? await services.github
            .getPullRequestChecksSnapshot(detail.cardBase.prNumber, services.config.requiredChecks, {
              owner: detail.cardBase.sourceOwner || services.config.github.targetOwner,
              repo: detail.cardBase.sourceRepo || services.config.github.targetRepo,
            })
            .catch((error) => {
              services.logger.warn({ err: error }, 'Failed to fetch live PR checks for task detail');
              return null;
            })
        : null;

    const card = mapBoardCard(
      {
        id: detail.cardBase.id,
        workflowRunId: detail.cardBase.workflowRunId,
        taskKey: detail.cardBase.taskKey,
        title: detail.cardBase.title,
        ownerRole: detail.cardBase.ownerRole,
        status: detail.cardBase.status,
        attemptCount: detail.cardBase.attemptCount,
        createdAt: detail.cardBase.createdAt,
        updatedAt: detail.cardBase.updatedAt,
        issueNumber: detail.cardBase.issueNumber,
        prNumber: detail.cardBase.prNumber,
        currentStage: detail.cardBase.currentStage,
        sourceOwner: detail.cardBase.sourceOwner,
        sourceRepo: detail.cardBase.sourceRepo,
        latestAttempt: latestAttempt ? { id: latestAttempt.id, status: latestAttempt.status } : null,
        latestMergeDecision: null,
      },
      services.config,
      livePr,
    );

    const timeline = TimelineEventSchema.array().parse(detail.timeline);

    return TaskDetailResponseSchema.parse({
      card,
      run: {
        id: detail.run.id,
        status: detail.run.status,
        current_stage: detail.run.currentStage,
        spec_id: detail.run.specId,
      },
      task: {
        id: detail.task.id,
        task_key: detail.task.taskKey,
        title: detail.task.title,
        owner_role: detail.task.ownerRole,
        status: detail.task.status,
        attempts: detail.task.attempts,
        definition_of_done: detail.task.definitionOfDone,
        depends_on: detail.task.dependsOn,
        last_result: detail.task.lastResult,
      },
      attempts: detail.attempts.map((attempt) => ({
        id: attempt.id,
        agent_role: attempt.agentRole,
        attempt_number: attempt.attemptNumber,
        status: attempt.status,
        error: attempt.error,
        duration_ms: attempt.durationMs,
        created_at: attempt.createdAt.toISOString(),
        output: attempt.output,
      })),
      artifacts: detail.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        content: artifact.content,
        created_at: artifact.createdAt.toISOString(),
        metadata: artifact.metadata ?? {},
      })),
      timeline,
      pull_request:
        livePr === null
          ? null
          : {
              number: livePr.prNumber,
              title: livePr.title,
              url: livePr.url,
              state: livePr.state,
              draft: livePr.draft,
              mergeable: livePr.mergeable,
              head_sha: livePr.headSha,
              overall_status: livePr.overallStatus,
              required_checks: livePr.requiredCheckNames,
              checks: livePr.checks.map((check) => ({
                name: check.name,
                status: check.status,
                conclusion: check.conclusion,
                required: check.required,
                details_url: check.detailsUrl,
                started_at: check.startedAt,
                completed_at: check.completedAt,
              })),
            },
    });
  });

  app.get('/api/v1/tasks/:taskId/timeline', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = await services.workflowRepo.getTaskView(taskId);
    if (!task) {
      return reply.status(404).send({ error: 'task_not_found' });
    }
    const events = TimelineEventSchema.array().parse(await services.workflowRepo.listTaskTimeline(taskId));
    return {
      task_id: taskId,
      events,
    };
  });

  app.post('/api/v1/tasks/:taskId/actions/:action', async (request, reply) => {
    const { taskId, action: rawAction } = request.params as { taskId: string; action: string };
    const action = normalizeAction(rawAction);
    if (!action) {
      return reply.status(404).send({ error: 'action_not_supported' });
    }

    const auth = getAuthContext(request.headers);
    if (!auth.authenticated) {
      return reply.status(401).send({
        error: 'authentication_required',
      });
    }

    const requiredRoles = actionRoleMap[action];
    const allowed = requiredRoles.some((role) => auth.roles.has(role));
    if (!allowed) {
      return reply.status(403).send({
        error: 'forbidden',
        action,
        required_roles: requiredRoles,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = parseJsonBody(request.body);
    } catch {
      return reply.status(400).send({ error: 'invalid_json' });
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return reply.status(400).send({ error: 'reason_required' });
    }

    const newOwnerRole = typeof body.new_owner_role === 'string' ? body.new_owner_role.trim() : undefined;
    if (action === 'reassign' && !newOwnerRole) {
      return reply.status(400).send({ error: 'new_owner_role_required' });
    }

    const result = await services.workflowRepo.applyTaskAction({
      taskId,
      action,
      requestedBy: auth.userId,
      reason,
      newOwnerRole,
    });

    if (!result) {
      return reply.status(404).send({ error: 'task_not_found' });
    }

    const response = TaskActionResponseSchema.parse({
      action_id: result.actionId,
      accepted: true,
      task_id: taskId,
      action,
      result: 'completed',
      created_at: result.createdAt,
    });

    broadcast({
      event: 'task.patch',
      topics: ['board', `task_${taskId}`],
      payload: {
        task_id: taskId,
        patch: {
          status: result.status,
          owner_role: result.ownerRole,
        },
        action,
        occurred_at: result.createdAt,
      },
    });

    return response;
  });

  app.get('/api/v1/stream', async (request, reply) => {
    const query = request.query as { topics?: string };
    const topics = new Set(
      String(query.topics ?? '')
        .split(',')
        .map((topic) => topic.trim())
        .filter((topic) => topic.length > 0),
    );

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const clientId = ++streamClientId;
    const send = (params: { event: string; payload: Record<string, unknown>; id?: string }) => {
      try {
        if (params.id) {
          reply.raw.write(`id: ${params.id}\n`);
        }
        reply.raw.write(`event: ${params.event}\n`);
        reply.raw.write(`data: ${JSON.stringify(params.payload)}\n\n`);
      } catch {
        streamClients.get(clientId)?.dispose();
      }
    };

    const heartbeat = setInterval(() => {
      send({ event: 'heartbeat', payload: { timestamp: new Date().toISOString() } });
    }, 15000);

    const client: StreamClient = {
      id: clientId,
      topics,
      send,
      dispose: () => {
        clearInterval(heartbeat);
        streamClients.delete(clientId);
      },
    };
    streamClients.set(clientId, client);

    send({
      event: 'connected',
      payload: {
        client_id: clientId,
        topics: [...topics],
        timestamp: new Date().toISOString(),
      },
      id: `connected-${clientId}`,
    });

    request.raw.on('close', () => {
      client.dispose();
    });
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
    const [sourceOwner, sourceRepo] = envelope.source.repo.split('/');

    const eventResult = await services.workflowRepo.recordEventIfNew({
      deliveryId,
      eventType: envelope.event_type,
      sourceOwner: sourceOwner || services.config.github.targetOwner,
      sourceRepo: sourceRepo || services.config.github.targetRepo,
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

    broadcast({
      event: 'task.patch',
      topics: ['board'],
      payload: {
        event_id: eventResult.eventId,
        event_type: envelope.event_type,
        occurred_at: new Date().toISOString(),
      },
    });

    webhookEventsTotal.inc({ event_type: eventName, result: 'accepted' });
    return reply.status(202).send({ accepted: true, eventId: eventResult.eventId });
  });

  return app;
}
