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
- `GET /api/v1/boards/default`
- `GET /api/v1/auth/me`
- `GET /api/v1/tasks/:taskId/detail`
- `GET /api/v1/tasks/:taskId/timeline`
- `POST /api/v1/tasks/:taskId/actions/:action`
- `GET /api/v1/stream?topics=board,task_<id>` (SSE)

All JSON responses above are schema-validated before returning.

## Front-end routes

- `GET /app` returns the Kanban-first orchestration UI.

## Live PR/CI enrichment

- `GET /api/v1/boards/default` enriches card `signals.ci_status` from live GitHub check runs when a PR exists.
- `GET /api/v1/tasks/:taskId/detail` includes `pull_request` with live check-run status and required-check mapping.

## Action RBAC

- `POST /api/v1/tasks/:taskId/actions/:action` requires `x-ralph-user`.
- Roles come from `x-ralph-roles` (or `x-ralph-role`) and are enforced server-side.
- `GET /api/v1/auth/me` returns resolved identity plus allowed actions for UI gating.
