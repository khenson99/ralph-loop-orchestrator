import { z } from 'zod';

import type { FiredAlert } from './slo.js';

// ---------------------------------------------------------------------------
// Severity Classification
// ---------------------------------------------------------------------------

export const IncidentSeveritySchema = z.enum(['P1', 'P2', 'P3', 'P4']);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

export const SeverityDefinitionSchema = z.object({
  severity: IncidentSeveritySchema,
  display_name: z.string(),
  description: z.string(),
  response_time: z.string(),
  runbook_url: z.string(),
});
export type SeverityDefinition = z.infer<typeof SeverityDefinitionSchema>;

export const SEVERITY_DEFINITIONS: readonly SeverityDefinition[] = [
  {
    severity: 'P1',
    display_name: 'Critical',
    description: 'Multiple SLOs breached with critical alerts – system-wide degradation',
    response_time: '15 minutes',
    runbook_url: 'runbooks/incident-p1.md',
  },
  {
    severity: 'P2',
    display_name: 'High',
    description: 'Single SLO breached at critical level or multiple warnings',
    response_time: '1 hour',
    runbook_url: 'runbooks/incident-p2.md',
  },
  {
    severity: 'P3',
    display_name: 'Medium',
    description: 'Single SLO warning – approaching breach threshold',
    response_time: '4 hours',
    runbook_url: 'runbooks/incident-p3.md',
  },
  {
    severity: 'P4',
    display_name: 'Low',
    description: 'Informational alert – no SLO breach but worth tracking',
    response_time: 'Next business day',
    runbook_url: 'runbooks/incident-p4.md',
  },
] as const;

// ---------------------------------------------------------------------------
// Incident State Machine
// ---------------------------------------------------------------------------

export const IncidentStateSchema = z.enum(['detected', 'acknowledged', 'mitigating', 'resolved']);
export type IncidentState = z.infer<typeof IncidentStateSchema>;

/** Valid state transitions for the incident lifecycle. */
export const INCIDENT_TRANSITIONS: Record<IncidentState, readonly IncidentState[]> = {
  detected: ['acknowledged'],
  acknowledged: ['mitigating'],
  mitigating: ['resolved'],
  resolved: [],
} as const;

// ---------------------------------------------------------------------------
// Incident Record Schema
// ---------------------------------------------------------------------------

export const IncidentRecordSchema = z.object({
  incident_id: z.string(),
  severity: IncidentSeveritySchema,
  state: IncidentStateSchema,
  title: z.string(),
  description: z.string(),
  fired_alerts: z.array(z.string()),
  runbook_url: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type IncidentRecord = z.infer<typeof IncidentRecordSchema>;

// ---------------------------------------------------------------------------
// Classification Logic
// ---------------------------------------------------------------------------

/**
 * Classify the severity of an incident based on the set of currently
 * fired alerts.  The rules are intentionally simple:
 *
 *  - 2+ critical alerts  => P1
 *  - 1 critical alert    => P2
 *  - 1+ warning alerts   => P3
 *  - info only           => P4
 *  - no alerts           => null (no incident)
 */
export function classifyIncidentSeverity(alerts: FiredAlert[]): IncidentSeverity | null {
  if (alerts.length === 0) return null;

  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
  const warningCount = alerts.filter((a) => a.severity === 'warning').length;

  if (criticalCount >= 2) return 'P1';
  if (criticalCount === 1) return 'P2';
  if (warningCount >= 1) return 'P3';
  return 'P4';
}

/**
 * Look up the canonical runbook URL for a severity level.
 */
export function runbookForSeverity(severity: IncidentSeverity): string {
  const def = SEVERITY_DEFINITIONS.find((s) => s.severity === severity);
  return def?.runbook_url ?? 'runbooks/incident-general.md';
}

/**
 * Validate whether a state transition is allowed.
 */
export function isValidTransition(from: IncidentState, to: IncidentState): boolean {
  const allowed = INCIDENT_TRANSITIONS[from];
  return (allowed as readonly string[]).includes(to);
}

/**
 * Build an incident title from fired alerts.
 */
export function buildIncidentTitle(severity: IncidentSeverity, alerts: FiredAlert[]): string {
  if (alerts.length === 0) return `[${severity}] Incident detected`;
  if (alerts.length === 1) {
    return `[${severity}] ${alerts[0]?.description ?? 'SLO breach detected'}`;
  }
  return `[${severity}] ${alerts.length} alert rules triggered`;
}
