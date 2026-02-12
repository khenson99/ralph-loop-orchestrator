import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
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
  RunResponseSchema,
  TaskResponseSchema,
  type WebhookEventEnvelope,
} from '../schemas/contracts.js';
import { BOARD_LANES, groupCardsByLane, projectBoardCards } from '../ui/kanban-model.js';

const ACTION_POLICY: Record<string, ReadonlyArray<string>> = {
  approve: ['admin'],
  request_changes: ['operator', 'admin'],
  block: ['operator', 'admin'],
};

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
          deadLetterReason: string | null;
          createdAt: Date;
          updatedAt: Date;
          tasks: Array<{ id: string; taskKey: string; status: string; attempts: number }>;
          artifacts: Array<{ id: string; kind: string; createdAt: Date }>;
          transitions: Array<{
            id: string;
            fromStage: string;
            toStage: string;
            transitionedAt: Date;
            metadata: Record<string, unknown>;
          }>;
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
    recordEventIfNew: (params: {
      deliveryId: string;
      eventType: string;
      sourceOwner: string;
      sourceRepo: string;
      payload: Record<string, unknown>;
    }) => Promise<{ inserted: boolean; eventId: string }>;
    listBoardCards?: (
      limit?: number,
    ) => Promise<
      Array<{
        runId: string;
        issueNumber: number | null;
        prNumber: number | null;
        status: string;
        currentStage: string;
        updatedAt: string;
        taskCounts: {
          queued: number;
          running: number;
          retry: number;
          completed: number;
          failed: number;
        };
      }>
    >;
    getLatestArtifactByKind?: (
      runId: string,
      kind: string,
    ) => Promise<
      | {
          id: string;
          kind: string;
          content: string;
          createdAt: Date;
        }
      | null
    >;
    listRunLogEntries?: (
      runId: string,
      options?: {
        after?: string;
        source?: string;
        taskKey?: string;
        status?: string;
        query?: string;
        limit?: number;
      },
    ) => Promise<
      Array<{
        id: string;
        timestamp: string;
        source: 'attempt' | 'artifact';
        taskKey: string | null;
        status: string | null;
        message: string;
        metadata: Record<string, unknown>;
      }>
    >;
  };
  github?: {
    getPullRequestChecks: (prNumber: number) => Promise<{
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
  orchestrator: {
    enqueue: (item: { eventId: string; envelope: WebhookEventEnvelope }) => void;
  };
  logger: Logger;
};

export function buildServer(services: AppServices) {
  const app = Fastify({ loggerInstance: services.logger });

  app.register(sensible);

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

    if (!services.github) {
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
      run.prNumber && services.github
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

        const eventResult = await observeBoundary('record_event', { issueNumber }, () =>
          services.workflowRepo.recordEventIfNew({
            deliveryId,
            eventType: envelope.event_type,
            sourceOwner: services.config.github.targetOwner,
            sourceRepo: services.config.github.targetRepo,
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
