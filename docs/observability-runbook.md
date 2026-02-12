# Observability Contract and Runbook

## Scope
Baseline operational contract for the orchestration pipeline:
`webhook -> spec generation -> task execution -> merge decision`.

## Contract: Signals

### Health and readiness endpoints
1. `GET /healthz`
Expected: `200`, body contains `status=ok`.
2. `GET /readyz`
Expected: `200` when DB is reachable, otherwise `503` with `status=not_ready`.

### Metrics endpoint
1. `GET /metrics`
Expected content type: Prometheus text format.
Required metrics:
1. `ralph_workflow_runs_total{status=...}`
2. `ralph_workflow_run_duration_ms`
3. `ralph_webhook_events_total{event_type,result}`
4. `ralph_retries_total{operation}`
5. `ralph_orchestration_boundary_calls_total{boundary,result}`
6. `ralph_orchestration_boundary_duration_ms{boundary}`

### Log safety contract
1. Secrets and token-like strings must be redacted before persistence or outbound review comments.
2. Dead-letter and failure logs should include redacted reason text and correlation fields:
`event_id`, `run_id`, `task_id`.

## Operational checks
Run before and after deploy:
1. `npm run test -- test/observability-contract.test.ts`
2. `curl -sf http://localhost:3000/healthz`
3. `curl -sf http://localhost:3000/readyz`
4. `curl -sf http://localhost:3000/metrics | rg 'ralph_(workflow_runs_total|workflow_run_duration_ms|webhook_events_total|retries_total|orchestration_boundary_calls_total|orchestration_boundary_duration_ms)'`

## Incident triage

### Symptom: webhook accepted but no run progress
1. Check `ralph_webhook_events_total{result="accepted"}` growth.
2. Check `ralph_workflow_runs_total` for `dead_letter` increase.
3. Query most recent run via `GET /api/runs/:runId` and inspect `currentStage`.

### Symptom: retries spiking
1. Inspect `ralph_retries_total` by `operation`.
2. Review recent dead-letter reasons for deterministic failures (schema/contract issues).
3. Confirm required-check integrations and external provider status.

### Symptom: readiness failures
1. Validate database connectivity and credentials.
2. Confirm migration state and DB health.
3. Keep service out of rotation until `GET /readyz` returns `200`.
