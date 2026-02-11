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

Both are schema-validated before returning.
