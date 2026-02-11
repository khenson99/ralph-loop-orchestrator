# Architecture

## Workflow

1. GitHub webhook lands on `POST /webhooks/github`.
2. Signature verification and delivery-id dedupe happen before any run is queued.
3. Orchestrator creates a `workflow_runs` record and links the `events` row.
4. Codex creates a formal spec (`FormalSpecV1`) and work breakdown.
5. Claude executes subtasks and returns `AgentResultV1` payloads.
6. Codex synthesizes review summary and merge decision (`MergeDecisionV1`).
7. GitHub client approves/requests changes and enables auto-merge when allowed.
8. Run/task/artifact state is queryable via `GET /api/runs/:runId` and `GET /api/tasks/:taskId`.

## Failure handling

- Transient LLM operations use bounded retry with jittered backoff.
- Unrecoverable failures are marked `dead_letter` on `workflow_runs`.
- Event rows are always marked `processed` with optional error details.

## Data model

- `workflow_runs`: run lifecycle + stage tracking
- `events`: webhook payloads + idempotency key
- `tasks`: subtask queue + status/attempts
- `agent_attempts`: per-attempt execution records
- `artifacts`: persisted spec/review/agent output payloads
- `merge_decisions`: codified merge gates
