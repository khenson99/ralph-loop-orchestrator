# Operations

## Environment

Set required variables from `.env.example`.

## Bootstrapping

1. `npm install`
2. `npm run db:push`
3. `npm run ralph:init -- --repo-type monorepo --project-url "..."`
4. `npm run dev`

## Observability

- Logs: structured JSON with secret redaction.
- Metrics: Prometheus endpoint at `GET /metrics`.
- Health:
  - `GET /healthz`
  - `GET /readyz`
- Runbook: see `docs/observability-runbook.md` for signal contract and incident checks.

## Security checks

- Validate state schema: `npm run ralph:validate-state`
- Ensure labels: `npm run tsx scripts/install-labels.ts`
- Configure branch protection: `scripts/configure-github-policies.sh ...`
