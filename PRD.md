# PRD: Ralph Loop Orchestrator v1

## Objective
Build a standalone service that orchestrates autonomous software delivery loops across GitHub Issues/PRs using Codex for planning/review and Claude for subtask execution, with durable state, policy-gated merge decisions, and observability.

## Source of truth
- `docs/deep-research-report.md`

## Scope (v1)
1. GitHub webhook ingestion with signature verification and idempotent delivery handling.
2. Durable workflow storage in PostgreSQL via Drizzle.
3. Formal spec generation from issue context (Codex).
4. Subtask execution loop returning structured outputs (Claude).
5. Automated review summary + merge decision (Codex).
6. Approval/request-changes actions and optional auto-merge when required checks pass.
7. Query APIs for runs/tasks and metrics endpoint.
8. Ralph runtime scripts (`init`, `planner`, `team`, `reviewer`, `all`).

## Non-goals (v1)
- Full code-writing sandbox and commit authoring inside orchestrator workers.
- Multi-tenant auth/UI dashboard.

## Acceptance criteria
- `POST /webhooks/github` verifies `X-Hub-Signature-256` and dedupes by `X-GitHub-Delivery`.
- `workflow_runs`, `events`, `tasks`, `agent_attempts`, `artifacts`, `merge_decisions` tables exist and are used.
- Formal spec/agent result/merge decision payloads are schema-validated.
- Required checks gate merge decisions and auto-merge eligibility.
- `GET /healthz`, `GET /readyz`, `GET /metrics`, `GET /api/runs/:runId`, `GET /api/tasks/:taskId` are functional.
- CI runs on `pull_request`, `push`, and `merge_group`.
- Loop scripts initialize and run in this repo without manual edits.

## Risks
- Merge queue support may vary by GitHub plan/settings.
- Autonomous merge safety depends on strict branch protections and check fidelity.

## Milestones
- A: bootstrap + webhooks + persistence
- B: spec/agent adapters + artifact capture
- C: review/auto-merge gates + policies
- D: observability and hardening
