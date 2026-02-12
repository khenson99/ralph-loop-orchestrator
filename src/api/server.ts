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
import { metricsRegistry, webhookEventsTotal } from '../lib/metrics.js';
import {
  RunResponseSchema,
  TaskResponseSchema,
  type WebhookEventEnvelope,
} from '../schemas/contracts.js';
import { BOARD_LANES, groupCardsByLane, projectBoardCards } from '../ui/kanban-model.js';

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
    @media (max-width: 1200px) { .board { grid-template-columns: repeat(3, minmax(220px, 1fr)); } }
    @media (max-width: 860px) { .board { grid-template-columns: repeat(1, minmax(220px, 1fr)); } }
  </style>
</head>
<body>
  <div class="container">
    <h1>Ralph Supervisor Board</h1>
    <div class="toolbar">
      <input id="q" placeholder="Search run/issue/PR/stage" />
      <select id="lane">
        <option value="">All lanes</option>
        <option value="ingest">Ingest</option>
        <option value="execute">Execute</option>
        <option value="review">Review</option>
        <option value="blocked">Blocked</option>
        <option value="done">Done</option>
      </select>
      <select id="status">
        <option value="">All statuses</option>
        <option value="in_progress">in_progress</option>
        <option value="completed">completed</option>
        <option value="dead_letter">dead_letter</option>
        <option value="failed">failed</option>
      </select>
      <button id="refresh">Refresh</button>
    </div>
    <div id="board" class="board"></div>
  </div>
  <script>
    const boardEl = document.getElementById('board');
    const qEl = document.getElementById('q');
    const laneEl = document.getElementById('lane');
    const statusEl = document.getElementById('status');
    const refreshEl = document.getElementById('refresh');
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
    .row .meta { font-size: 12px; color: var(--muted); }
    .error { color: #ffd1d1; background: #381d26; border: 1px solid #7f2338; padding: 10px; border-radius: 10px; }
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
          <div id="summary"></div>
        </div>
        <div class="panel">
          <h3>Tasks</h3>
          <div id="tasks" class="grid"></div>
        </div>
        <div class="panel">
          <h3>Artifacts</h3>
          <div id="artifacts" class="grid"></div>
        </div>
      </section>
    </div>
  </div>
  <script>
    const runId = ${JSON.stringify(runId)};
    async function load() {
      const response = await fetch('/api/runs/' + encodeURIComponent(runId));
      if (!response.ok) {
        document.getElementById('summary').innerHTML = '<div class="error">Run not found or unavailable.</div>';
        return;
      }
      const run = await response.json();
      render(run);
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

    // Reject requests with missing signature explicitly as 401
    if (!signature) {
      webhookEventsTotal.inc({ event_type: eventName || 'unknown', result: 'missing_signature' });
      return reply.status(401).send({ error: 'missing_signature' });
    }

    if (!eventName || !deliveryId || typeof rawBody !== 'string') {
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
      return reply.status(200).send({ accepted: false, duplicate: true });
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
