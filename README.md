# ralph-loop-orchestrator

Standalone orchestration service for a Ralph Team Loop workflow:

`GitHub webhook -> Codex planning/review -> Claude task execution -> PR gate -> auto-merge`

## What this repo provides

- Fastify service with endpoints:
  - `POST /webhooks/github`
  - `GET /healthz`
  - `GET /readyz`
  - `GET /metrics`
  - `GET /api/v1/runs/recent`
  - `GET /api/v1/tasks/recent`
  - `GET /api/runs/:runId`
  - `GET /api/tasks/:taskId`
  - `GET /api/v1/boards/default`
  - `GET /api/v1/auth/me`
  - `GET /api/v1/tasks/:taskId/detail`
  - `GET /api/v1/tasks/:taskId/timeline`
  - `POST /api/v1/tasks/:taskId/actions/:action`
  - `GET /api/v1/runtime/processes`
  - `GET /api/v1/runtime/processes/:processId/logs`
  - `POST /api/v1/runtime/processes/:processId/actions/:action`
  - `GET /api/v1/stream?topics=board,task_<id>,runtime` (SSE)
- Unified ops console frontend served from the orchestrator:
  - `GET /app`
  - `GET /app/app-config.js` runtime-injects `window.__RALPH_CONFIG__.apiBase`
  - Board/detail views use live GitHub PR check-run status when PR links exist
- Shared frontend source of truth:
  - `apps/orchestrator-ui/src`
  - `npm run ui:sync` mirrors to `src/api/static/unified` and `apps/vercel-console`
- Static web console target for Vercel hosting:
  - `apps/vercel-console`
- PostgreSQL persistence with Drizzle tables:
  - `workflow_runs`, `events`, `tasks`, `agent_attempts`, `artifacts`, `merge_decisions`
- Codex adapter (Responses API) for:
  - formal spec generation
  - review summary
  - merge decision rationale
- Claude adapter (Messages API) for structured subtask execution results
- Ralph runtime scripts:
  - `scripts/init.sh`, `scripts/run-planner.sh`, `scripts/run-team.sh`, `scripts/run-reviewer.sh`, `scripts/run-all.sh`
- Observability baseline:
  - structured logs
  - Prometheus metrics
  - OpenTelemetry bootstrap

## Quick start

1. Copy `.env.example` to `.env` and fill all secrets.
   - For local smoke tests without model keys, set `DRY_RUN=true` and provide `GITHUB_TOKEN`.
   - Set `CORS_ALLOWED_ORIGINS` if a browser app (for example Vercel) calls this API.
2. Install dependencies:
   - `npm install`
3. Push schema:
   - `npm run db:push`
4. Initialize Ralph state:
   - `npm run ralph:init -- --repo-type monorepo --project-url "https://github.com/users/<you>/projects/<id>"`
5. Start service:
   - `npm run dev`
6. Open the UI:
   - `http://localhost:3000/app`
7. To execute task actions from the UI, set an identity:
   - open `Settings` tab
   - choose user + role in `Operator Identity`
   - action routes require `x-ralph-user` and enforce role permissions
8. To route the UI to another API host:
   - open `Settings > API Endpoint`
   - set/test/save API base
   - resolution order is `?apiBase=...` -> localStorage -> `window.__RALPH_CONFIG__.apiBase` -> same-origin
9. To start planner/team/reviewer from the UI:
   - set `RALPH_PLANNER_PRD_PATH` (or enter `prd_path` when starting planner)
   - use the Loop Supervisor panel for start/stop/restart and log tailing

## Unified UI sync

Run this before commits/deployments when the frontend changes:

```bash
npm run ui:sync
```

This keeps these targets in parity:
- `apps/orchestrator-ui/src` (authoritative source)
- `src/api/static/unified` (`/app` assets)
- `apps/vercel-console` (Vercel-hosted console)

## Configure GitHub repo policies

Use:

```bash
scripts/configure-github-policies.sh \
  --owner khenson99 \
  --repo ralph-loop-orchestrator \
  --branch main \
  --checks "CI / Lint + Typecheck,CI / Tests"
```

Then install labels:

```bash
npm run labels:sync
```

## Run CI checks locally

```bash
npm run lint
npm run typecheck
npm run test
```

## Ralph loop commands

```bash
npm run ralph:init -- --repo-type monorepo --project-url "https://github.com/users/khenson99/projects/1"
npm run ralph:planner -- --prd ./PRD.md
npm run ralph:team -- --max-iterations 20
npm run ralph:reviewer -- --max-iterations 10
npm run ralph:all -- --prd ./PRD.md --cycles 3
```

## Security defaults

- GitHub App auth with installation token flow (not PAT-first)
- Webhook HMAC verification (`X-Hub-Signature-256`)
- Event dedupe keyed by `X-GitHub-Delivery`
- Secret redaction in logs
- Optional auto-merge only when required checks pass

## Architecture docs

- `docs/architecture.md`
- `docs/api-contracts.md`
- `docs/operations.md`
- `docs/deep-research-report.md`
