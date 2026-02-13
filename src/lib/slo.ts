import { z } from 'zod';

// ---------------------------------------------------------------------------
// SLO Definitions – thresholds aligned to existing Prometheus metrics
// ---------------------------------------------------------------------------

/**
 * Each SLO is identified by a stable key and references a concrete metric
 * already emitted via src/lib/metrics.ts.  The evaluator below consumes
 * raw counter / histogram snapshots and returns per-SLO compliance results.
 */

export const SloIdSchema = z.enum([
  'workflow_success_rate',
  'workflow_latency_p99',
  'webhook_processing_reliability',
  'retry_budget',
]);
export type SloId = z.infer<typeof SloIdSchema>;

export const SloDefinitionSchema = z.object({
  id: SloIdSchema,
  display_name: z.string(),
  description: z.string(),
  metric: z.string(),
  objective: z.number(),
  unit: z.enum(['percent', 'milliseconds']),
});
export type SloDefinition = z.infer<typeof SloDefinitionSchema>;

/** Canonical SLO catalogue – intentionally a plain const array. */
export const SLO_DEFINITIONS: readonly SloDefinition[] = [
  {
    id: 'workflow_success_rate',
    display_name: 'Workflow Success Rate',
    description: 'Percentage of workflow runs completing successfully',
    metric: 'ralph_workflow_runs_total',
    objective: 95,
    unit: 'percent',
  },
  {
    id: 'workflow_latency_p99',
    display_name: 'Workflow Latency (p99)',
    description: 'p99 workflow run duration must stay under threshold',
    metric: 'ralph_workflow_run_duration_ms',
    objective: 120_000,
    unit: 'milliseconds',
  },
  {
    id: 'webhook_processing_reliability',
    display_name: 'Webhook Processing Reliability',
    description: 'Percentage of webhook events processed without error',
    metric: 'ralph_webhook_events_total',
    objective: 99.5,
    unit: 'percent',
  },
  {
    id: 'retry_budget',
    display_name: 'Retry Budget',
    description: 'Retry rate must remain below threshold of total operations',
    metric: 'ralph_retries_total',
    objective: 10,
    unit: 'percent',
  },
] as const;

// ---------------------------------------------------------------------------
// Alert Rule Schema
// ---------------------------------------------------------------------------

export const AlertSeveritySchema = z.enum(['critical', 'warning', 'info']);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const AlertRuleSchema = z.object({
  id: z.string(),
  slo_id: SloIdSchema,
  severity: AlertSeveritySchema,
  condition: z.string(),
  threshold: z.number(),
  description: z.string(),
  runbook_url: z.string(),
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;

export const ALERT_RULES: readonly AlertRule[] = [
  // Workflow success rate
  {
    id: 'workflow_success_rate_critical',
    slo_id: 'workflow_success_rate',
    severity: 'critical',
    condition: 'success_rate < threshold',
    threshold: 90,
    description: 'Workflow success rate dropped below 90%',
    runbook_url: 'runbooks/workflow-success-rate.md',
  },
  {
    id: 'workflow_success_rate_warning',
    slo_id: 'workflow_success_rate',
    severity: 'warning',
    condition: 'success_rate < threshold',
    threshold: 95,
    description: 'Workflow success rate below 95% SLO target',
    runbook_url: 'runbooks/workflow-success-rate.md',
  },
  // Workflow latency p99
  {
    id: 'workflow_latency_p99_critical',
    slo_id: 'workflow_latency_p99',
    severity: 'critical',
    condition: 'p99_latency_ms > threshold',
    threshold: 180_000,
    description: 'Workflow p99 latency exceeded 180s (1.5x SLO)',
    runbook_url: 'runbooks/workflow-latency.md',
  },
  {
    id: 'workflow_latency_p99_warning',
    slo_id: 'workflow_latency_p99',
    severity: 'warning',
    condition: 'p99_latency_ms > threshold',
    threshold: 120_000,
    description: 'Workflow p99 latency exceeded 120s SLO target',
    runbook_url: 'runbooks/workflow-latency.md',
  },
  // Webhook reliability
  {
    id: 'webhook_reliability_critical',
    slo_id: 'webhook_processing_reliability',
    severity: 'critical',
    condition: 'success_rate < threshold',
    threshold: 98,
    description: 'Webhook processing reliability below 98%',
    runbook_url: 'runbooks/webhook-reliability.md',
  },
  {
    id: 'webhook_reliability_warning',
    slo_id: 'webhook_processing_reliability',
    severity: 'warning',
    condition: 'success_rate < threshold',
    threshold: 99.5,
    description: 'Webhook processing reliability below 99.5% SLO target',
    runbook_url: 'runbooks/webhook-reliability.md',
  },
  // Retry budget
  {
    id: 'retry_budget_critical',
    slo_id: 'retry_budget',
    severity: 'critical',
    condition: 'retry_rate > threshold',
    threshold: 20,
    description: 'Retry rate exceeded 20% (2x budget)',
    runbook_url: 'runbooks/retry-budget.md',
  },
  {
    id: 'retry_budget_warning',
    slo_id: 'retry_budget',
    severity: 'warning',
    condition: 'retry_rate > threshold',
    threshold: 10,
    description: 'Retry rate exceeded 10% budget',
    runbook_url: 'runbooks/retry-budget.md',
  },
] as const;

// ---------------------------------------------------------------------------
// Metrics Snapshot – the minimal shape the evaluator needs
// ---------------------------------------------------------------------------

export interface MetricsSnapshot {
  workflow_runs_success: number;
  workflow_runs_failure: number;
  /** p99 value in milliseconds; null when no observations exist. */
  workflow_latency_p99_ms: number | null;
  webhook_events_success: number;
  webhook_events_error: number;
  retries_total: number;
  /** Total base operations that retries are measured against. */
  operations_total: number;
}

// ---------------------------------------------------------------------------
// SLO Evaluation Result
// ---------------------------------------------------------------------------

export const SloComplianceSchema = z.enum(['met', 'breached', 'no_data']);
export type SloCompliance = z.infer<typeof SloComplianceSchema>;

export const SloEvaluationResultSchema = z.object({
  slo_id: SloIdSchema,
  display_name: z.string(),
  objective: z.number(),
  unit: z.enum(['percent', 'milliseconds']),
  current_value: z.number().nullable(),
  compliance: SloComplianceSchema,
});
export type SloEvaluationResult = z.infer<typeof SloEvaluationResultSchema>;

export const FiredAlertSchema = z.object({
  rule_id: z.string(),
  slo_id: SloIdSchema,
  severity: AlertSeveritySchema,
  description: z.string(),
  runbook_url: z.string(),
  current_value: z.number().nullable(),
  threshold: z.number(),
});
export type FiredAlert = z.infer<typeof FiredAlertSchema>;

export const SloStatusResponseSchema = z.object({
  evaluated_at: z.string().datetime(),
  slos: z.array(SloEvaluationResultSchema),
  fired_alerts: z.array(FiredAlertSchema),
  overall_compliance: SloComplianceSchema,
});
export type SloStatusResponse = z.infer<typeof SloStatusResponseSchema>;

// ---------------------------------------------------------------------------
// Evaluation Logic
// ---------------------------------------------------------------------------

function safeRate(success: number, total: number): number | null {
  if (total <= 0) return null;
  return (success / total) * 100;
}

export function evaluateSlos(snapshot: MetricsSnapshot): SloEvaluationResult[] {
  const results: SloEvaluationResult[] = [];

  for (const def of SLO_DEFINITIONS) {
    let currentValue: number | null = null;
    let compliance: SloCompliance = 'no_data';

    switch (def.id) {
      case 'workflow_success_rate': {
        const total = snapshot.workflow_runs_success + snapshot.workflow_runs_failure;
        currentValue = safeRate(snapshot.workflow_runs_success, total);
        if (currentValue !== null) {
          compliance = currentValue >= def.objective ? 'met' : 'breached';
        }
        break;
      }

      case 'workflow_latency_p99': {
        currentValue = snapshot.workflow_latency_p99_ms;
        if (currentValue !== null) {
          compliance = currentValue <= def.objective ? 'met' : 'breached';
        }
        break;
      }

      case 'webhook_processing_reliability': {
        const total = snapshot.webhook_events_success + snapshot.webhook_events_error;
        currentValue = safeRate(snapshot.webhook_events_success, total);
        if (currentValue !== null) {
          compliance = currentValue >= def.objective ? 'met' : 'breached';
        }
        break;
      }

      case 'retry_budget': {
        const total = snapshot.operations_total;
        if (total > 0) {
          currentValue = (snapshot.retries_total / total) * 100;
          // For retry budget the SLO is an upper bound – "below X%"
          compliance = currentValue <= def.objective ? 'met' : 'breached';
        }
        break;
      }
    }

    results.push({
      slo_id: def.id,
      display_name: def.display_name,
      objective: def.objective,
      unit: def.unit,
      current_value: currentValue,
      compliance,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Alert Matching
// ---------------------------------------------------------------------------

export function matchAlerts(snapshot: MetricsSnapshot): FiredAlert[] {
  const fired: FiredAlert[] = [];

  for (const rule of ALERT_RULES) {
    let currentValue: number | null = null;
    let shouldFire = false;

    switch (rule.slo_id) {
      case 'workflow_success_rate': {
        const total = snapshot.workflow_runs_success + snapshot.workflow_runs_failure;
        currentValue = safeRate(snapshot.workflow_runs_success, total);
        if (currentValue !== null) {
          shouldFire = currentValue < rule.threshold;
        }
        break;
      }

      case 'workflow_latency_p99': {
        currentValue = snapshot.workflow_latency_p99_ms;
        if (currentValue !== null) {
          shouldFire = currentValue > rule.threshold;
        }
        break;
      }

      case 'webhook_processing_reliability': {
        const total = snapshot.webhook_events_success + snapshot.webhook_events_error;
        currentValue = safeRate(snapshot.webhook_events_success, total);
        if (currentValue !== null) {
          shouldFire = currentValue < rule.threshold;
        }
        break;
      }

      case 'retry_budget': {
        const total = snapshot.operations_total;
        if (total > 0) {
          currentValue = (snapshot.retries_total / total) * 100;
          shouldFire = currentValue > rule.threshold;
        }
        break;
      }
    }

    if (shouldFire) {
      fired.push({
        rule_id: rule.id,
        slo_id: rule.slo_id,
        severity: rule.severity,
        description: rule.description,
        runbook_url: rule.runbook_url,
        current_value: currentValue,
        threshold: rule.threshold,
      });
    }
  }

  return fired;
}

// ---------------------------------------------------------------------------
// Overall compliance helper
// ---------------------------------------------------------------------------

export function overallCompliance(results: SloEvaluationResult[]): SloCompliance {
  const hasBreached = results.some((r) => r.compliance === 'breached');
  if (hasBreached) return 'breached';
  const allNoData = results.every((r) => r.compliance === 'no_data');
  if (allNoData) return 'no_data';
  return 'met';
}
