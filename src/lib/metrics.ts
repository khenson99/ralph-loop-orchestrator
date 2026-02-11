import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const workflowRunsTotal = new Counter({
  name: 'ralph_workflow_runs_total',
  help: 'Total number of workflow runs created',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const workflowRunDurationMs = new Histogram({
  name: 'ralph_workflow_run_duration_ms',
  help: 'Workflow run duration in milliseconds',
  buckets: [100, 500, 1000, 5000, 10000, 30000, 120000],
  registers: [metricsRegistry],
});

export const webhookEventsTotal = new Counter({
  name: 'ralph_webhook_events_total',
  help: 'Webhook events received',
  labelNames: ['event_type', 'result'],
  registers: [metricsRegistry],
});

export const retriesTotal = new Counter({
  name: 'ralph_retries_total',
  help: 'Retry attempts by operation',
  labelNames: ['operation'],
  registers: [metricsRegistry],
});
