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

## SLO Definitions

### Webhook acceptance rate
- **Metric:** `rate(ralph_webhook_events_total{result="accepted"}) / rate(ralph_webhook_events_total)`
- **Target:** >= 95% over 5m window (excludes ignored events by design)
- **Alert signals:** `missing_signature`, `invalid_signature`, `bad_request` result labels

### Boundary error rate
- **Metric:** `rate(ralph_orchestration_boundary_calls_total{result="error"}) / rate(ralph_orchestration_boundary_calls_total)` per boundary
- **Target:** < 5% per boundary over 5m window
- **Alert signals:** `result="error"` on any boundary label

### Boundary latency (p99)
- **Metric:** `histogram_quantile(0.99, rate(ralph_orchestration_boundary_duration_ms_bucket[5m]))`
- **Target:** < 5000ms for external boundaries (github.*, codex.*, claude.*), < 100ms for repo.*
- **Histogram buckets:** [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 15000]

### Run success rate
- **Metric:** `rate(ralph_workflow_runs_total{status="completed"}) / rate(ralph_workflow_runs_total)`
- **Target:** >= 90% over 1h window
- **Alert signals:** `status="dead_letter"` growth

### Run duration (p95)
- **Metric:** `histogram_quantile(0.95, rate(ralph_workflow_run_duration_ms_bucket[5m]))`
- **Target:** < 120000ms (2 minutes)
- **Histogram buckets:** [100, 500, 1000, 5000, 10000, 30000, 120000]

## Operational checks
Run before and after deploy:
1. `npm run test -- test/observability-contract.test.ts`
2. `npm run test -- test/slo-alerting-incident-response.test.ts`
3. `curl -sf http://localhost:3000/healthz`
4. `curl -sf http://localhost:3000/readyz`
5. `curl -sf http://localhost:3000/metrics | rg 'ralph_(workflow_runs_total|workflow_run_duration_ms|webhook_events_total|retries_total|orchestration_boundary_calls_total|orchestration_boundary_duration_ms)'`

## Incident triage

### Symptom: webhook accepted but no run progress
1. Check `ralph_webhook_events_total{result="accepted"}` growth.
2. Check `ralph_workflow_runs_total` for `dead_letter` increase.
3. Query most recent run via `GET /api/runs/:runId` and inspect `currentStage`.

### Symptom: retries spiking
1. Inspect `ralph_retries_total` by `operation`.
2. Review recent dead-letter reasons for deterministic failures (schema/contract issues).
3. Confirm required-check integrations and external provider status.

### Symptom: boundary error rate exceeds SLO
1. Identify the failing boundary from `ralph_orchestration_boundary_calls_total{result="error"}`.
2. Check boundary latency: `ralph_orchestration_boundary_duration_ms` for timeout patterns.
3. For `github.*` boundaries: check GitHub status and rate limits.
4. For `codex.*` / `claude.*` boundaries: check provider status and API key validity.
5. For `repo.*` boundaries: check database connectivity via `GET /readyz`.

### Symptom: readiness failures
1. Validate database connectivity and credentials.
2. Confirm migration state and DB health.
3. Keep service out of rotation until `GET /readyz` returns `200`.
4. Note: `GET /healthz` and `GET /metrics` remain available during readiness failures.
