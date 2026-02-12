# Public Contracts

## WebhookEventEnvelope

Versioned envelope persisted per webhook delivery.

## FormalSpecV1

Canonical planning spec used across agent iterations.

## AgentResultV1

Structured subtask output contract returned by Claude workers.

## MergeDecisionV1

Structured reviewer output used to gate approvals and auto-merge.

## API responses

- `GET /api/runs/:runId`
- `GET /api/tasks/:taskId`
- `GET /api/v1/runs/recent`
- `GET /api/v1/tasks/recent`
- `GET /api/v1/boards/default`
- `GET /api/v1/auth/me`
- `GET /api/v1/tasks/:taskId/detail`
- `GET /api/v1/tasks/:taskId/timeline`
- `POST /api/v1/tasks/:taskId/actions/:action`
- `GET /api/v1/runtime/processes`
- `GET /api/v1/runtime/processes/:processId/logs`
- `POST /api/v1/runtime/processes/:processId/actions/:action`
- `GET /api/v1/stream?topics=board,task_<id>,runtime` (SSE)

All JSON responses above are schema-validated before returning.

## Front-end routes

- `GET /app` returns the unified orchestration UI.
- `GET /app/app-config.js` injects runtime browser config:
  - `window.__RALPH_CONFIG__ = { apiBase?: string }`
- `GET /app/*` serves shared static assets from `src/api/static/unified`.

## Runtime API base resolution (frontend)

The browser console resolves API base in this order:

1. Query param override: `?apiBase=...`
2. Local override: `localStorage['ralph.ui.apiBase']`
3. Runtime injection: `window.__RALPH_CONFIG__.apiBase`
4. Same-origin fallback

## Live PR/CI enrichment

- `GET /api/v1/boards/default` enriches card `signals.ci_status` from live GitHub check runs when a PR exists.
- `GET /api/v1/tasks/:taskId/detail` includes `pull_request` with live check-run status and required-check mapping.

## Action RBAC

- `POST /api/v1/tasks/:taskId/actions/:action` requires `x-ralph-user`.
- Roles come from `x-ralph-roles` (or `x-ralph-role`) and are enforced server-side.
- `GET /api/v1/auth/me` returns resolved identity plus allowed actions for UI gating.
- Runtime process actions (`start|stop|restart`) require `operator`, `reviewer`, or `admin`.
