import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import type { PullRequestChecksSnapshot, RepoRef } from '../integrations/github/client.js';
import {
  AutonomyModeSchema,
  AutonomyTransitionError,
  type AutonomyManager,
} from '../lib/autonomy.js';
import {
  extractIssueNumber,
  isActionableEvent,
  mapGithubWebhookToEnvelope,
  verifyGitHubSignature,
} from '../integrations/github/webhook.js';
import {
  metricsRegistry,
  orchestrationBoundaryCallsTotal,
  orchestrationBoundaryDurationMs,
  webhookEventsTotal,
} from '../lib/metrics.js';
import { withSpan } from '../lib/telemetry.js';
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
import { BOARD_LANES, groupCardsByLane, projectBoardCards } from '../ui/kanban-model.js';

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

const ACTION_POLICY: Record<string, ReadonlyArray<string>> = {
  approve: ['admin'],
  request_changes: ['operator', 'admin'],
  block: ['operator', 'admin'],
};

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
> & {
  getLatestArtifactByKind?: WorkflowRepository['getLatestArtifactByKind'];
  listRunLogEntries?: WorkflowRepository['listRunLogEntries'];
};

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
  getPullRequestChecks?: (prNumber: number) => Promise<{
    prNumber: number;
    headSha: string;
    checks: Array<{
      name: string;
      status: string | null;
      conclusion: string | null;
    }>;
  }>;
  approvePullRequest?: (prNumber: number, body: string) => Promise<void>;
  requestChanges?: (prNumber: number, body: string) => Promise<void>;
  addIssueComment?: (issueNumber: number, body: string) => Promise<void>;
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
  autonomyManager: AutonomyManager;
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

type BoardCardRow = {
  id: string;
  workflowRunId?: string;
  sourceOwner?: string | null;
  sourceRepo?: string | null;
  status: string;
  currentStage: string;
  taskKey: string;
  title: string;
  ownerRole: string;
  latestMergeDecision?: string | null;
  latestAttempt?: { id: string; status: string } | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
  issueNumber: number | null;
  prNumber: number | null;
};

function mapBoardCard(
  row: BoardCardRow,
  config: AppConfig,
  livePr: PullRequestChecksSnapshot | null = null,
): BoardCard {
  const sourceOwner = row.sourceOwner || config.github.targetOwner;
  const sourceRepo = row.sourceRepo || config.github.targetRepo;
  const lane = toLane(row.status, row.currentStage);
  const priority = inferPriority(row.taskKey, row.title);
  const ciStatus = livePr?.overallStatus ?? inferCiStatus(row.status, row.latestMergeDecision ?? null);
  const llmVerdict = inferLlmVerdict(row.latestMergeDecision ?? null);
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

  app.get('/api/board/cards', async (request) => {
    const query = request.query as {
      q?: string;
      lane?: string;
      status?: string;
      limit?: string;
    };

    const parsedLimit = query.limit ? Number.parseInt(query.limit, 10) : 100;
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 100;
    const cards = services.workflowRepo.listBoardCards
      ? await services.workflowRepo.listBoardCards(limit)
      : [];
    const projected = projectBoardCards(cards, {
      query: query.q,
      lane: query.lane,
      status: query.status,
    });

    return {
      lanes: BOARD_LANES,
      cards: projected,
      grouped: groupCardsByLane(projected),
    };
  });

  app.get('/api/board/stream', async (request, reply) => {
    if (!services.workflowRepo.listBoardCards) {
      return reply.status(501).send({ error: 'board_stream_not_supported' });
    }

    const query = request.query as { lastEventId?: string; once?: string };
    const once = String(query.once ?? '').toLowerCase() === 'true';
    const incomingLastEventId =
      String(request.headers['last-event-id'] ?? query.lastEventId ?? '').trim() || null;

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let closed = false;
    const writeSnapshot = async () => {
      if (closed) {
        return;
      }
      const cards = await services.workflowRepo.listBoardCards?.(200);
      const projected = projectBoardCards(cards ?? [], {});
      const eventId = Date.now().toString();
      const payload = JSON.stringify({
        lanes: BOARD_LANES,
        cards: projected,
        grouped: groupCardsByLane(projected),
        generatedAt: new Date().toISOString(),
        fromLastEventId: incomingLastEventId,
      });

      reply.raw.write(`id: ${eventId}\n`);
      reply.raw.write('event: board.snapshot\n');
      reply.raw.write(`data: ${payload}\n\n`);
    };

    await writeSnapshot();
    if (once) {
      reply.raw.end();
      return reply;
    }

    reply.raw.write('retry: 3000\n\n');
    const timer = setInterval(() => {
      void writeSnapshot();
    }, 5000);

    request.raw.on('close', () => {
      closed = true;
      clearInterval(timer);
    });

    return reply;
  });

  app.get('/api/runs/:runId/spec', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (!services.workflowRepo.getLatestArtifactByKind) {
      return reply.status(501).send({ error: 'artifact_lookup_not_supported' });
    }

    const artifact = await services.workflowRepo.getLatestArtifactByKind(runId, 'formal_spec');
    if (!artifact) {
      return reply.status(404).send({ error: 'spec_not_found' });
    }

    return {
      runId,
      kind: artifact.kind,
      content: artifact.content,
      createdAt: artifact.createdAt.toISOString(),
    };
  });

  app.get('/api/runs/:runId/pr-status', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await services.workflowRepo.getRunView(runId);
    if (!run) {
      return reply.status(404).send({ error: 'run_not_found' });
    }

    if (!run.prNumber) {
      return {
        runId,
        prNumber: null,
        checks: [],
      };
    }

    if (!services.github?.getPullRequestChecks) {
      return reply.status(501).send({ error: 'github_checks_not_supported' });
    }

    const status = await services.github.getPullRequestChecks(run.prNumber);
    return {
      runId,
      prNumber: status.prNumber,
      headSha: status.headSha,
      checks: status.checks,
    };
  });

  app.get('/api/runs/:runId/logs', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (!services.workflowRepo.listRunLogEntries) {
      return reply.status(501).send({ error: 'logs_not_supported' });
    }

    const query = request.query as {
      after?: string;
      source?: string;
      taskKey?: string;
      status?: string;
      q?: string;
      limit?: string;
    };
    const parsedLimit = query.limit ? Number.parseInt(query.limit, 10) : 200;
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 200;

    const entries = await services.workflowRepo.listRunLogEntries(runId, {
      after: query.after,
      source: query.source,
      taskKey: query.taskKey,
      status: query.status,
      query: query.q,
      limit,
    });

    return {
      runId,
      entries,
      nextCursor: entries.length > 0 ? entries[entries.length - 1]?.timestamp : null,
    };
  });

  app.post('/api/runs/:runId/actions', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await services.workflowRepo.getRunView(runId);
    if (!run) {
      return reply.status(404).send({ error: 'run_not_found' });
    }

    const bodyRaw = request.body;
    const parsedBody =
      typeof bodyRaw === 'string'
        ? (JSON.parse(bodyRaw) as { action?: string; reason?: string })
        : ((bodyRaw as { action?: string; reason?: string }) ?? {});
    const action = String(parsedBody.action ?? '').trim();
    const reason = String(parsedBody.reason ?? '').trim();
    const role = String(request.headers['x-supervisor-role'] ?? 'viewer').trim().toLowerCase();

    if (!['approve', 'request_changes', 'block'].includes(action)) {
      return reply.status(400).send({ error: 'invalid_action' });
    }

    if (!reason) {
      return reply.status(400).send({ error: 'reason_required' });
    }

    const allowedRoles = ACTION_POLICY[action] ?? [];
    if (!allowedRoles.includes(role)) {
      return reply.status(403).send({ error: 'forbidden_action', action, role });
    }

    if (!services.github) {
      return reply.status(501).send({ error: 'github_actions_not_supported' });
    }

    if (!run.prNumber) {
      if (!run.issueNumber || !services.github.addIssueComment) {
        return reply.status(409).send({ error: 'no_pr_linked' });
      }

      await services.github.addIssueComment(
        run.issueNumber,
        `Manual supervisor action recorded for run ${runId}: ${action}\n\nReason:\n${reason}`,
      );
      return {
        runId,
        action,
        recordedOnIssue: run.issueNumber,
      };
    }

    if (action === 'approve') {
      if (!services.github.approvePullRequest) {
        return reply.status(501).send({ error: 'approve_not_supported' });
      }
      await services.github.approvePullRequest(
        run.prNumber,
        `Manual supervisor approval for run ${runId}.\n\nReason:\n${reason}`,
      );
    } else {
      if (!services.github.requestChanges) {
        return reply.status(501).send({ error: 'request_changes_not_supported' });
      }
      await services.github.requestChanges(
        run.prNumber,
        `Manual supervisor action (${action}) for run ${runId}.\n\nReason:\n${reason}`,
      );
    }

    return {
      runId,
      action,
      prNumber: run.prNumber,
    };
  });

  app.get('/api/runs/:runId/audit-export', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await services.workflowRepo.getRunView(runId);
    if (!run) {
      return reply.status(404).send({ error: 'run_not_found' });
    }

    const spec = services.workflowRepo.getLatestArtifactByKind
      ? await services.workflowRepo.getLatestArtifactByKind(runId, 'formal_spec')
      : null;
    const logs = services.workflowRepo.listRunLogEntries
      ? await services.workflowRepo.listRunLogEntries(runId, { limit: 500 })
      : [];

    const prStatus =
      run.prNumber && services.github?.getPullRequestChecks
        ? await services.github.getPullRequestChecks(run.prNumber)
        : null;

    const payload = {
      exportedAt: new Date().toISOString(),
      run: {
        ...run,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
        artifacts: run.artifacts.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
        })),
        transitions: run.transitions.map((item) => ({
          ...item,
          transitionedAt: item.transitionedAt.toISOString(),
        })),
      },
      spec: spec
        ? {
            ...spec,
            createdAt: spec.createdAt.toISOString(),
          }
        : null,
      prStatus,
      transcript: logs.filter((entry) => entry.source === 'attempt'),
      logs,
    };

    reply.header('content-type', 'application/json');
    reply.header('content-disposition', `attachment; filename="run-${runId}-audit.json"`);
    return payload;
  });

  app.get('/supervisor', async (_, reply) => {
    reply.type('text/html');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ralph Supervisor Board</title>
  <style>
    :root {
      --bg: #0b1220;
      --panel: #111a2e;
      --muted: #8fa3c8;
      --text: #dbe7ff;
      --accent: #4db3ff;
      --ok: #14b85a;
      --warn: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: radial-gradient(circle at top left, #162649 0%, var(--bg) 45%); color: var(--text); }
    .container { padding: 20px; max-width: 1600px; margin: 0 auto; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
    .toolbar input, .toolbar select, .toolbar button { background: #0d1730; color: var(--text); border: 1px solid #233456; border-radius: 10px; padding: 10px 12px; }
    .board { display: grid; grid-template-columns: repeat(5, minmax(220px, 1fr)); gap: 12px; align-items: start; }
    .lane { background: rgba(17, 26, 46, 0.92); border: 1px solid #27395f; border-radius: 14px; min-height: 320px; }
    .lane-head { padding: 12px; border-bottom: 1px solid #243758; }
    .lane-title { margin: 0; font-size: 15px; }
    .lane-sub { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
    .lane-count { float: right; color: var(--accent); font-weight: 700; }
    .cards { padding: 10px; display: grid; gap: 10px; }
    .card { border: 1px solid #2b3f67; border-radius: 12px; background: #0e1a35; padding: 10px; color: inherit; text-decoration: none; display: block; }
    .card h4 { margin: 0 0 6px; font-size: 14px; }
    .meta { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; }
    .badge { font-size: 11px; padding: 3px 7px; border-radius: 999px; background: #1d2f4e; border: 1px solid #324c78; }
    .badge.ok { color: #bcffd6; border-color: #1f8f4a; background: rgba(20,184,90,0.12); }
    .badge.warn { color: #ffe7b0; border-color: #9a6a11; background: rgba(245,158,11,0.12); }
    .badge.danger { color: #ffd2d2; border-color: #a02323; background: rgba(239,68,68,0.12); }
    a:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible {
      outline: 2px solid #77c4ff;
      outline-offset: 2px;
    }
    @media (max-width: 1200px) { .board { grid-template-columns: repeat(3, minmax(220px, 1fr)); } }
    @media (max-width: 860px) { .board { grid-template-columns: repeat(1, minmax(220px, 1fr)); } }
  </style>
</head>
<body>
  <div class="container">
    <h1>Ralph Supervisor Board</h1>
    <div class="toolbar">
      <input id="q" aria-label="Search runs" placeholder="Search run/issue/PR/stage" />
      <select id="lane" aria-label="Filter by lane">
        <option value="">All lanes</option>
        <option value="ingest">Ingest</option>
        <option value="execute">Execute</option>
        <option value="review">Review</option>
        <option value="blocked">Blocked</option>
        <option value="done">Done</option>
      </select>
      <select id="status" aria-label="Filter by status">
        <option value="">All statuses</option>
        <option value="in_progress">in_progress</option>
        <option value="completed">completed</option>
        <option value="dead_letter">dead_letter</option>
        <option value="failed">failed</option>
      </select>
      <button id="refresh" aria-label="Refresh board">Refresh</button>
    </div>
    <div id="board" class="board" role="region" aria-label="Supervisor kanban board"></div>
  </div>
  <script>
    const boardEl = document.getElementById('board');
    const qEl = document.getElementById('q');
    const laneEl = document.getElementById('lane');
    const statusEl = document.getElementById('status');
    const refreshEl = document.getElementById('refresh');
    let streamLastEventId = '';
    let streamRef = null;
    async function load() {
      const params = new URLSearchParams();
      if (qEl.value) params.set('q', qEl.value);
      if (laneEl.value) params.set('lane', laneEl.value);
      if (statusEl.value) params.set('status', statusEl.value);
      const response = await fetch('/api/board/cards?' + params.toString());
      const data = await response.json();
      render(data);
    }
    function badgeClass(value) {
      if (value.includes('dead') || value.includes('failed')) return 'danger';
      if (value.includes('completed')) return 'ok';
      return 'warn';
    }
    function render(data) {
      boardEl.innerHTML = '';
      for (const lane of data.lanes) {
        const cards = data.grouped[lane.id] || [];
        const laneEl = document.createElement('section');
        laneEl.className = 'lane';
        laneEl.tabIndex = 0;
        laneEl.setAttribute('role', 'region');
        laneEl.setAttribute('aria-label', lane.title + ' lane');
        laneEl.innerHTML = '<div class="lane-head"><p class="lane-count">' + cards.length + '</p><h3 class="lane-title">' + lane.title + '</h3><p class="lane-sub">' + lane.description + '</p></div>';
        const cardsEl = document.createElement('div');
        cardsEl.className = 'cards';
        for (const card of cards) {
          const issueLabel = card.issueNumber ? '#' + card.issueNumber : 'No issue';
          const prLabel = card.prNumber ? 'PR #' + card.prNumber : 'No PR';
          const taskStats = card.taskCounts ? 'done:' + card.taskCounts.completed + ' retry:' + card.taskCounts.retry + ' running:' + card.taskCounts.running : '';
          const el = document.createElement('a');
          el.className = 'card';
          el.href = '/supervisor/runs/' + encodeURIComponent(card.runId);
          el.innerHTML = '<h4>' + issueLabel + ' · ' + card.runId.slice(0, 8) + '</h4>'
            + '<div class="meta">' + prLabel + ' · ' + new Date(card.updatedAt).toLocaleString() + '</div>'
            + '<div class="badges"><span class="badge ' + badgeClass(card.status) + '">' + card.status + '</span>'
            + '<span class="badge">' + card.currentStage + '</span><span class="badge">' + taskStats + '</span></div>';
          cardsEl.appendChild(el);
        }
        laneEl.appendChild(cardsEl);
        boardEl.appendChild(laneEl);
      }
    }
    qEl.addEventListener('input', () => load());
    laneEl.addEventListener('change', () => load());
    statusEl.addEventListener('change', () => load());
    refreshEl.addEventListener('click', () => load());
    window.addEventListener('keydown', (event) => {
      if (event.key === '/' && document.activeElement !== qEl) {
        event.preventDefault();
        qEl.focus();
      }
      if (event.altKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        load();
      }
    });
    function connectStream() {
      const params = new URLSearchParams();
      if (streamLastEventId) {
        params.set('lastEventId', streamLastEventId);
      }
      const url = '/api/board/stream' + (params.toString() ? '?' + params.toString() : '');
      streamRef = new EventSource(url);
      streamRef.addEventListener('board.snapshot', (event) => {
        if (event.lastEventId) {
          streamLastEventId = event.lastEventId;
        }
        load();
      });
      streamRef.onerror = () => {
        if (streamRef) {
          streamRef.close();
        }
        setTimeout(connectStream, 2000);
      };
    }
    connectStream();
    load();
  </script>
</body>
</html>`;
  });

  app.get('/supervisor/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    reply.type('text/html');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Run Detail ${runId}</title>
  <style>
    :root {
      --bg: #0a1120;
      --panel: #121d33;
      --text: #deebff;
      --muted: #91a5c9;
      --line: #2f446d;
      --accent: #52b4ff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: linear-gradient(160deg, #101d3b 0%, var(--bg) 55%); color: var(--text); }
    .wrap { max-width: 1500px; margin: 0 auto; padding: 20px; }
    .top { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
    .top a { color: var(--accent); text-decoration: none; }
    .layout { display: grid; grid-template-columns: minmax(260px, 0.9fr) minmax(380px, 1.3fr); gap: 14px; }
    .panel { background: rgba(18, 29, 51, 0.92); border: 1px solid #2c4069; border-radius: 14px; padding: 14px; }
    .panel h3 { margin: 0 0 10px; font-size: 15px; }
    .timeline { position: relative; padding-left: 20px; display: grid; gap: 10px; }
    .timeline:before { content: ''; position: absolute; left: 7px; top: 4px; bottom: 4px; width: 2px; background: var(--line); }
    .event { position: relative; background: #0f1a2f; border: 1px solid #2a3f67; border-radius: 10px; padding: 8px 10px; }
    .event:before { content: ''; position: absolute; left: -17px; top: 12px; width: 10px; height: 10px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 2px #0a1120; }
    .event .meta { font-size: 12px; color: var(--muted); }
    .grid { display: grid; gap: 10px; }
    .row { border: 1px solid #2a3f67; border-radius: 10px; padding: 8px 10px; background: #0f1a2f; }
    .row.selected { border-color: #59b9ff; box-shadow: inset 0 0 0 1px rgba(89, 185, 255, 0.35); }
    .row .meta { font-size: 12px; color: var(--muted); }
    .logs-toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .logs-toolbar input, .logs-toolbar select, .logs-toolbar button {
      background: #0e1830;
      color: var(--text);
      border: 1px solid #2e446f;
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 12px;
    }
    #logs { max-height: 320px; overflow: auto; }
    pre.log-message { white-space: pre-wrap; margin: 6px 0 0; font-size: 12px; color: #d7e7ff; }
    .error { color: #ffd1d1; background: #381d26; border: 1px solid #7f2338; padding: 10px; border-radius: 10px; }
    a:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible {
      outline: 2px solid #77c4ff;
      outline-offset: 2px;
    }
    @media (max-width: 980px) { .layout { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <a href="/supervisor">Back to Board</a>
      <strong id="title">Run ${runId}</strong>
    </div>
    <div class="layout">
      <section class="panel">
        <h3>Timeline Spine</h3>
        <div id="timeline" class="timeline"></div>
      </section>
      <section class="grid">
        <div class="panel">
          <h3>Run Summary</h3>
          <div id="summary" role="status" aria-live="polite"></div>
        </div>
        <div class="panel">
          <h3>Tasks</h3>
          <div id="tasks" class="grid" role="region" aria-label="Task panel"></div>
        </div>
        <div class="panel">
          <h3>Artifacts</h3>
          <div id="artifacts" class="grid" role="region" aria-label="Artifact panel"></div>
        </div>
        <div class="panel">
          <h3>Spec Viewer</h3>
          <div id="spec" class="row"></div>
        </div>
        <div class="panel">
          <h3>PR and CI Status</h3>
          <div id="prStatus" class="grid"></div>
        </div>
        <div class="panel">
          <h3>Logs Viewer</h3>
          <div class="logs-toolbar">
            <input id="logQuery" placeholder="Filter text" />
            <select id="logSource">
              <option value="">All sources</option>
              <option value="attempt">Attempts</option>
              <option value="artifact">Artifacts</option>
            </select>
            <button id="logRefresh">Refresh</button>
            <button id="logTail">Tail</button>
          </div>
          <div id="logs" class="grid"></div>
        </div>
        <div class="panel">
          <h3>Agent Transcript (Read-only)</h3>
          <button id="auditExport" aria-label="Export audit bundle">Export Audit JSON</button>
          <div id="transcript" class="grid" style="margin-top: 8px;"></div>
        </div>
        <div class="panel">
          <h3>Agent Console v1</h3>
          <div class="logs-toolbar">
            <label for="agentTaskFilter" class="meta">Task</label>
            <select id="agentTaskFilter" aria-label="Filter agent console by task"></select>
            <button id="agentPrevAttempt" aria-label="Show previous attempt">Prev Attempt</button>
            <button id="agentNextAttempt" aria-label="Show next attempt">Next Attempt</button>
          </div>
          <div id="agentAttemptLabel" class="meta"></div>
          <div id="agentTimeline" class="grid" role="region" aria-label="Agent attempt timeline"></div>
          <div id="agentToolSummary" class="grid" style="margin-top: 10px;"></div>
          <pre id="agentTranscript" class="log-message"></pre>
        </div>
        <div class="panel">
          <h3>Action Controls</h3>
          <div class="grid">
            <div class="logs-toolbar">
              <label for="roleSelect" class="meta">Role</label>
              <select id="roleSelect">
                <option value="viewer">viewer</option>
                <option value="operator">operator</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <textarea id="actionReason" aria-label="Action reason" rows="4" style="width: 100%; background: #0e1830; color: var(--text); border: 1px solid #2e446f; border-radius: 8px; padding: 8px;" placeholder="Enter required reason..."></textarea>
            <div class="logs-toolbar">
              <button id="actionApprove">Approve PR</button>
              <button id="actionChanges">Request Changes</button>
              <button id="actionBlock">Block</button>
            </div>
            <div id="actionResult" class="meta" role="status" aria-live="polite"></div>
          </div>
        </div>
      </section>
    </div>
  </div>
  <script>
    const runId = ${JSON.stringify(runId)};
    let logCursor = null;
    let allLogEntries = [];
    const consoleState = {
      taskKey: '',
      attemptIndex: 0,
    };
    const uiActionPolicy = {
      approve: ['admin'],
      request_changes: ['operator', 'admin'],
      block: ['operator', 'admin'],
    };
    async function load() {
      const runResponse = await fetch('/api/runs/' + encodeURIComponent(runId));
      if (!runResponse.ok) {
        document.getElementById('summary').innerHTML = '<div class="error">Run not found or unavailable.</div>';
        return;
      }
      const run = await runResponse.json();
      const specResponse = await fetch('/api/runs/' + encodeURIComponent(runId) + '/spec');
      const prResponse = await fetch('/api/runs/' + encodeURIComponent(runId) + '/pr-status');
      const spec = specResponse.ok ? await specResponse.json() : null;
      const pr = prResponse.ok ? await prResponse.json() : null;
      render(run);
      renderSpec(spec);
      renderPrStatus(pr);
      await loadLogs(false);
    }
    function render(run) {
      document.getElementById('title').textContent = 'Run ' + run.id;
      document.getElementById('summary').innerHTML =
        '<div class="row"><strong>Status:</strong> ' + run.status + '</div>' +
        '<div class="row"><strong>Stage:</strong> ' + run.currentStage + '</div>' +
        '<div class="row"><strong>Issue:</strong> ' + (run.issueNumber ? '#' + run.issueNumber : 'N/A') + '</div>' +
        '<div class="row"><strong>PR:</strong> ' + (run.prNumber ? '#' + run.prNumber : 'N/A') + '</div>';

      const timeline = document.getElementById('timeline');
      timeline.innerHTML = '';
      const transitions = run.transitions && run.transitions.length ? run.transitions : [{ fromStage: 'N/A', toStage: run.currentStage, transitionedAt: run.updatedAt, metadata: {} }];
      for (const t of transitions) {
        const event = document.createElement('div');
        event.className = 'event';
        event.innerHTML = '<div><strong>' + t.fromStage + ' → ' + t.toStage + '</strong></div>' +
          '<div class="meta">' + new Date(t.transitionedAt).toLocaleString() + '</div>';
        timeline.appendChild(event);
      }

      const tasks = document.getElementById('tasks');
      tasks.innerHTML = '';
      for (const task of run.tasks || []) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = '<div><strong>' + task.taskKey + '</strong></div><div class="meta">status=' + task.status + ' · attempts=' + task.attempts + '</div>';
        tasks.appendChild(row);
      }

      const artifacts = document.getElementById('artifacts');
      artifacts.innerHTML = '';
      for (const artifact of run.artifacts || []) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = '<div><strong>' + artifact.kind + '</strong></div><div class="meta">' + new Date(artifact.createdAt).toLocaleString() + '</div>';
        artifacts.appendChild(row);
      }
    }
    function renderSpec(spec) {
      const container = document.getElementById('spec');
      if (!spec || !spec.content) {
        container.innerHTML = '<div class="meta">No spec artifact available for this run.</div>';
        return;
      }
      const safe = String(spec.content)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
      container.innerHTML = '<div class="meta">Captured at ' + new Date(spec.createdAt).toLocaleString() + '</div><pre style="white-space: pre-wrap; margin: 8px 0 0; color: #cde2ff;">' + safe + '</pre>';
    }
    function renderPrStatus(pr) {
      const container = document.getElementById('prStatus');
      if (!pr) {
        container.innerHTML = '<div class="row">PR/CI status unavailable.</div>';
        return;
      }
      if (!pr.prNumber) {
        container.innerHTML = '<div class="row">No PR linked to this run.</div>';
        return;
      }
      const checks = Array.isArray(pr.checks) ? pr.checks : [];
      const rows = ['<div class="row"><strong>PR #' + pr.prNumber + '</strong><div class="meta">head=' + (pr.headSha || 'n/a') + '</div></div>'];
      for (const check of checks) {
        rows.push('<div class="row"><strong>' + check.name + '</strong><div class="meta">status=' + check.status + ' · conclusion=' + (check.conclusion || 'pending') + '</div></div>');
      }
      container.innerHTML = rows.join('');
    }
    async function loadLogs(incremental) {
      const queryEl = document.getElementById('logQuery');
      const sourceEl = document.getElementById('logSource');
      const params = new URLSearchParams();
      if (queryEl.value) params.set('q', queryEl.value);
      if (sourceEl.value) params.set('source', sourceEl.value);
      if (incremental && logCursor) params.set('after', logCursor);
      const response = await fetch('/api/runs/' + encodeURIComponent(runId) + '/logs?' + params.toString());
      if (!response.ok) {
        return;
      }
      const payload = await response.json();
      const incoming = payload.entries || [];
      if (!incremental) {
        allLogEntries = incoming;
      } else {
        const merged = new Map();
        for (const entry of allLogEntries) {
          merged.set(entry.id, entry);
        }
        for (const entry of incoming) {
          merged.set(entry.id, entry);
        }
        allLogEntries = Array.from(merged.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      }
      renderLogs(incoming, incremental);
      renderTranscript(allLogEntries);
      renderAgentConsole(allLogEntries);
      logCursor = payload.nextCursor || logCursor;
    }
    function renderLogs(entries, append) {
      const container = document.getElementById('logs');
      if (!append) {
        container.innerHTML = '';
      }
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'row';
        const safe = String(entry.message || '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
        row.innerHTML =
          '<div><strong>' + entry.source + '</strong></div>' +
          '<div class="meta">' + new Date(entry.timestamp).toLocaleString() + ' · task=' + (entry.taskKey || 'n/a') + ' · status=' + (entry.status || 'n/a') + '</div>' +
          '<pre class="log-message">' + safe + '</pre>';
        container.appendChild(row);
      }
    }
    function renderTranscript(entries) {
      const container = document.getElementById('transcript');
      container.innerHTML = '';
      const attempts = (entries || []).filter((entry) => entry.source === 'attempt');
      if (!attempts.length) {
        container.innerHTML = '<div class="row"><div class="meta">No transcript entries yet.</div></div>';
        return;
      }
      for (const entry of attempts) {
        const row = document.createElement('div');
        row.className = 'row';
        const safe = String(entry.message || '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
        row.innerHTML =
          '<div><strong>' + (entry.taskKey || 'task') + '</strong></div>' +
          '<div class="meta">' + new Date(entry.timestamp).toLocaleString() + ' · status=' + (entry.status || 'n/a') + '</div>' +
          '<pre class="log-message">' + safe + '</pre>';
        container.appendChild(row);
      }
    }
    function parseAttemptPayload(message) {
      try {
        const parsed = JSON.parse(message || '{}');
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch {}
      return null;
    }
    function extractAttemptEntries(entries) {
      const attemptCounters = new Map();
      return (entries || [])
        .filter((entry) => entry.source === 'attempt')
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .map((entry) => {
          const taskKey = entry.taskKey || 'unknown';
          const nextAttempt = (attemptCounters.get(taskKey) || 0) + 1;
          attemptCounters.set(taskKey, nextAttempt);
          const payload = parseAttemptPayload(entry.message);
          const commands = payload && Array.isArray(payload.commands_ran) ? payload.commands_ran : [];
          const files = payload && Array.isArray(payload.files_changed) ? payload.files_changed : [];
          const summary = payload && typeof payload.summary === 'string' ? payload.summary : (entry.message || '').slice(0, 280);
          return {
            id: entry.id,
            taskKey,
            attemptNumber: nextAttempt,
            timestamp: entry.timestamp,
            status: entry.status || 'unknown',
            summary,
            commands,
            files,
            transcript: entry.message || '',
          };
        });
    }
    function renderAgentConsole(entries) {
      const taskFilter = document.getElementById('agentTaskFilter');
      const timeline = document.getElementById('agentTimeline');
      const label = document.getElementById('agentAttemptLabel');
      const toolSummary = document.getElementById('agentToolSummary');
      const transcript = document.getElementById('agentTranscript');
      const prevBtn = document.getElementById('agentPrevAttempt');
      const nextBtn = document.getElementById('agentNextAttempt');
      const attempts = extractAttemptEntries(entries);

      timeline.innerHTML = '';
      toolSummary.innerHTML = '';
      transcript.textContent = '';

      if (!attempts.length) {
        taskFilter.innerHTML = '<option value="">No task attempts yet</option>';
        label.textContent = 'No attempts available.';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
      }

      const taskKeys = [...new Set(attempts.map((item) => item.taskKey))];
      if (!consoleState.taskKey || !taskKeys.includes(consoleState.taskKey)) {
        consoleState.taskKey = taskKeys[0];
        consoleState.attemptIndex = 0;
      }

      taskFilter.innerHTML = taskKeys.map((taskKey) => '<option value="' + taskKey + '">' + taskKey + '</option>').join('');
      taskFilter.value = consoleState.taskKey;

      const selectedAttempts = attempts.filter((item) => item.taskKey === consoleState.taskKey);
      if (selectedAttempts.length === 0) {
        label.textContent = 'No attempts available for selected task.';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
      }

      consoleState.attemptIndex = Math.max(0, Math.min(consoleState.attemptIndex, selectedAttempts.length - 1));
      const selected = selectedAttempts[consoleState.attemptIndex];

      label.textContent =
        selected.taskKey +
        ' · attempt ' +
        selected.attemptNumber +
        ' of ' +
        selectedAttempts.length +
        ' · status=' +
        selected.status;

      selectedAttempts.forEach((item, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'row' + (index === consoleState.attemptIndex ? ' selected' : '');
        row.style.textAlign = 'left';
        row.innerHTML =
          '<div><strong>Attempt ' + item.attemptNumber + '</strong></div>' +
          '<div class="meta">' + new Date(item.timestamp).toLocaleString() + ' · status=' + item.status + '</div>' +
          '<div class="meta">' + String(item.summary || '').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</div>';
        row.addEventListener('click', () => {
          consoleState.attemptIndex = index;
          renderAgentConsole(allLogEntries);
        });
        timeline.appendChild(row);
      });

      const commandRows = selected.commands.map((command) => {
        const cmd = command && typeof command.cmd === 'string' ? command.cmd : 'command';
        const exitCode = command && Object.prototype.hasOwnProperty.call(command, 'exit_code')
          ? String(command.exit_code)
          : 'n/a';
        return '<div class="row"><strong>' + cmd + '</strong><div class="meta">exit=' + exitCode + '</div></div>';
      });
      const fileRows = selected.files.map((filePath) => '<span class="badge">' + String(filePath) + '</span>');
      if (commandRows.length === 0 && fileRows.length === 0) {
        toolSummary.innerHTML = '<div class="row"><div class="meta">No tool call summary available for this attempt.</div></div>';
      } else {
        const filesHtml = fileRows.length > 0
          ? '<div class="row"><div class="meta">Files changed</div><div class="badges">' + fileRows.join('') + '</div></div>'
          : '';
        toolSummary.innerHTML =
          '<div class="meta">Tool Call Summary</div>' +
          commandRows.join('') +
          filesHtml;
      }

      transcript.textContent = selected.transcript || '';
      prevBtn.disabled = consoleState.attemptIndex <= 0;
      nextBtn.disabled = consoleState.attemptIndex >= selectedAttempts.length - 1;
    }
    document.getElementById('logRefresh').addEventListener('click', async () => {
      logCursor = null;
      await loadLogs(false);
    });
    document.getElementById('logTail').addEventListener('click', async () => {
      await loadLogs(true);
    });
    document.getElementById('agentTaskFilter').addEventListener('change', (event) => {
      consoleState.taskKey = event.target.value;
      consoleState.attemptIndex = 0;
      renderAgentConsole(allLogEntries);
    });
    document.getElementById('agentPrevAttempt').addEventListener('click', () => {
      consoleState.attemptIndex = Math.max(0, consoleState.attemptIndex - 1);
      renderAgentConsole(allLogEntries);
    });
    document.getElementById('agentNextAttempt').addEventListener('click', () => {
      consoleState.attemptIndex += 1;
      renderAgentConsole(allLogEntries);
    });
    async function sendAction(action) {
      const role = document.getElementById('roleSelect').value || 'viewer';
      const reason = (document.getElementById('actionReason').value || '').trim();
      const resultEl = document.getElementById('actionResult');
      const allowed = (uiActionPolicy[action] || []).includes(role);
      if (!allowed) {
        resultEl.textContent = 'Forbidden: role ' + role + ' cannot perform ' + action + '.';
        return;
      }
      if (!reason) {
        resultEl.textContent = 'Reason is required.';
        return;
      }
      if (!window.confirm('Confirm action: ' + action + '?')) {
        return;
      }
      const response = await fetch('/api/runs/' + encodeURIComponent(runId) + '/actions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-supervisor-role': role,
        },
        body: JSON.stringify({ action, reason }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        resultEl.textContent = 'Action failed: ' + (payload.error || response.status);
        return;
      }
      resultEl.textContent = 'Action submitted: ' + action;
    }
    document.getElementById('actionApprove').addEventListener('click', () => sendAction('approve'));
    document.getElementById('actionChanges').addEventListener('click', () => sendAction('request_changes'));
    document.getElementById('actionBlock').addEventListener('click', () => sendAction('block'));
    document.getElementById('auditExport').addEventListener('click', async () => {
      const response = await fetch('/api/runs/' + encodeURIComponent(runId) + '/audit-export');
      if (!response.ok) {
        document.getElementById('actionResult').textContent = 'Audit export failed.';
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'run-' + runId + '-audit.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });
    function syncActionAvailability() {
      const role = document.getElementById('roleSelect').value || 'viewer';
      const approveBtn = document.getElementById('actionApprove');
      const changesBtn = document.getElementById('actionChanges');
      const blockBtn = document.getElementById('actionBlock');
      approveBtn.disabled = !uiActionPolicy.approve.includes(role);
      changesBtn.disabled = !uiActionPolicy.request_changes.includes(role);
      blockBtn.disabled = !uiActionPolicy.block.includes(role);
    }
    document.getElementById('roleSelect').addEventListener('change', syncActionAvailability);
    syncActionAvailability();
    window.addEventListener('keydown', (event) => {
      const logQuery = document.getElementById('logQuery');
      if (event.key === '/' && document.activeElement !== logQuery) {
        event.preventDefault();
        logQuery.focus();
      }
      if (event.key === 'Escape') {
        document.getElementById('actionResult').textContent = '';
      }
    });
    load();
  </script>
</body>
</html>`;
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
      transitions: run.transitions.map((t) => ({
        ...t,
        transitionedAt: t.transitionedAt.toISOString(),
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
    const projected = projectBoardCards(rows, {});
    const grouped = groupCardsByLane(projected);

    const laneCards = new Map<LaneId, string[]>();
    for (const lane of laneOrder) {
      laneCards.set(lane.lane, []);
    }
    for (const card of projected) {
      const laneKey = card.lane as LaneId;
      if (laneCards.has(laneKey)) {
        laneCards.get(laneKey)?.push(card.runId);
      }
    }

    const cards: Record<string, BoardCard> = {};
    for (const card of projected) {
      const owner = services.config.github.targetOwner;
      const repo = services.config.github.targetRepo;
      cards[card.runId] = {
        card_id: card.runId,
        title: `Run ${card.runId.slice(0, 8)}${card.issueNumber ? ` (#${card.issueNumber})` : ''}`,
        lane: card.lane,
        status: card.status,
        priority: 'P2',
        owner: { type: 'team', id: 'orchestrator', display_name: 'Orchestrator' },
        attempt: {
          current_attempt_id: null,
          attempt_count: Object.values(card.taskCounts).reduce((sum, val) => sum + val, 0),
          last_attempt_status: null,
        },
        signals: {
          ci_status: inferCiStatus(card.status, null),
          llm_review_verdict: 'unknown',
          human_review_state: card.prNumber ? 'requested' : 'none',
        },
        timestamps: {
          created_at: card.updatedAt,
          last_updated_at: card.updatedAt,
          lane_entered_at: card.updatedAt,
        },
        links: {
          github_issue_url: card.issueNumber
            ? `https://github.com/${owner}/${repo}/issues/${card.issueNumber}`
            : null,
          pull_request_url: card.prNumber
            ? `https://github.com/${owner}/${repo}/pull/${card.prNumber}`
            : null,
        },
        source: { owner, repo, full_name: `${owner}/${repo}` },
        tags: [card.status, card.currentStage],
      };
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

  // ---------------------------------------------------------------------------
  // Autonomy mode routes
  // ---------------------------------------------------------------------------

  app.get('/api/v1/autonomy/status', async () => {
    return {
      mode: services.autonomyManager.mode,
      history: services.autonomyManager.history,
      generated_at: new Date().toISOString(),
    };
  });

  app.post('/api/v1/autonomy/mode', async (request, reply) => {
    const auth = getAuthContext(request.headers);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: 'authentication_required' });
    }
    if (!auth.roles.has('admin')) {
      return reply.status(403).send({
        error: 'forbidden',
        required_roles: ['admin'],
      });
    }

    let body: Record<string, unknown>;
    try {
      body = parseJsonBody(request.body);
    } catch {
      return reply.status(400).send({ error: 'invalid_json' });
    }

    const modeResult = AutonomyModeSchema.safeParse(body.mode);
    if (!modeResult.success) {
      return reply.status(400).send({
        error: 'invalid_mode',
        valid_modes: AutonomyModeSchema.options,
      });
    }

    const reason = typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim()
      : undefined;
    if (!reason) {
      return reply.status(400).send({ error: 'reason_required' });
    }

    try {
      const record = services.autonomyManager.transition({
        to: modeResult.data,
        changedBy: auth.userId,
        reason,
      });

      services.logger.info(
        { autonomy_transition: record },
        'autonomy mode changed',
      );

      return {
        mode: services.autonomyManager.mode,
        transition: record,
        occurred_at: record.changedAt,
      };
    } catch (err) {
      if (err instanceof AutonomyTransitionError) {
        return reply.status(409).send({
          error: 'invalid_transition',
          from: err.from,
          to: err.to,
          message: err.message,
        });
      }
      throw err;
    }
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

    const observeBoundary = async <T>(
      boundary: string,
      context: { issueNumber?: number },
      fn: () => Promise<T>,
    ): Promise<T> => {
      const startedAt = Date.now();
      return withSpan(
        `webhook.${boundary}`,
        {
          tracerName: 'ralph-loop-orchestrator.api',
          attributes: {
            boundary,
            event_type: eventName || 'unknown',
            delivery_id: deliveryId || 'unknown',
            issue_number: context.issueNumber ?? '',
          },
        },
        async () => {
          try {
            const result = await fn();
            orchestrationBoundaryCallsTotal.inc({ boundary: `webhook.${boundary}`, result: 'success' });
            return result;
          } catch (error) {
            orchestrationBoundaryCallsTotal.inc({ boundary: `webhook.${boundary}`, result: 'error' });
            app.log.warn(
              {
                boundary: `webhook.${boundary}`,
                delivery_id: deliveryId,
                event_type: eventName,
                issue_number: context.issueNumber,
                err: error,
              },
              'Webhook boundary failed',
            );
            throw error;
          } finally {
            orchestrationBoundaryDurationMs.observe(
              { boundary: `webhook.${boundary}` },
              Date.now() - startedAt,
            );
          }
        },
      );
    };

    return withSpan(
      'webhook.ingest',
      {
        tracerName: 'ralph-loop-orchestrator.api',
        attributes: {
          event_type: eventName || 'unknown',
          delivery_id: deliveryId || 'unknown',
        },
      },
      async () => {
        // Reject requests with missing signature explicitly as 401
        if (!signature) {
          webhookEventsTotal.inc({ event_type: eventName || 'unknown', result: 'missing_signature' });
          return reply.status(401).send({ error: 'missing_signature' });
        }

        if (!eventName || !deliveryId || typeof rawBody !== 'string') {
          webhookEventsTotal.inc({ event_type: eventName || 'unknown', result: 'bad_request' });
          return reply.status(400).send({ error: 'missing_required_headers_or_body' });
        }

        const valid = await observeBoundary('verify_signature', {}, () =>
          verifyGitHubSignature({
            secret: services.config.github.webhookSecret,
            payload: rawBody,
            signature,
          }),
        );

        if (!valid) {
          webhookEventsTotal.inc({ event_type: eventName, result: 'invalid_signature' });
          return reply.status(401).send({ error: 'invalid_signature' });
        }

        let payload: Record<string, unknown>;
        try {
          payload = await observeBoundary('parse_payload', {}, async () =>
            JSON.parse(rawBody) as Record<string, unknown>,
          );
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

        const eventResult = await observeBoundary('record_event', { issueNumber }, () =>
          services.workflowRepo.recordEventIfNew({
            deliveryId,
            eventType: envelope.event_type,
            sourceOwner: sourceOwner || services.config.github.targetOwner,
            sourceRepo: sourceRepo || services.config.github.targetRepo,
            payload,
          }),
        );

        if (!eventResult.inserted) {
          webhookEventsTotal.inc({ event_type: eventName, result: 'duplicate' });
          app.log.info(
            {
              event_type: eventName,
              delivery_id: deliveryId,
              issue_number: issueNumber,
              result: 'duplicate',
            },
            'Webhook event deduplicated',
          );
          return reply.status(200).send({ accepted: false, duplicate: true });
        }

        await observeBoundary('enqueue', { issueNumber }, async () => {
          services.orchestrator.enqueue({
            eventId: eventResult.eventId,
            envelope,
          });
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
        app.log.info(
          {
            event_type: eventName,
            delivery_id: deliveryId,
            issue_number: issueNumber,
            event_id: eventResult.eventId,
            result: 'accepted',
          },
          'Webhook event accepted and enqueued',
        );
        return reply.status(202).send({ accepted: true, eventId: eventResult.eventId });
      },
    );
  });

  return app;
}
