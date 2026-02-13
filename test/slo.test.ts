import { describe, expect, it } from 'vitest';

import {
  evaluateSlos,
  matchAlerts,
  overallCompliance,
  SLO_DEFINITIONS,
  ALERT_RULES,
  SloStatusResponseSchema,
  SloEvaluationResultSchema,
  FiredAlertSchema,
  type MetricsSnapshot,
} from '../src/lib/slo.js';

import {
  classifyIncidentSeverity,
  runbookForSeverity,
  isValidTransition,
  buildIncidentTitle,
  SEVERITY_DEFINITIONS,
  INCIDENT_TRANSITIONS,
  IncidentRecordSchema,
} from '../src/lib/incident.js';

import {
  SloIdSchema,
  SloComplianceSchema,
  AlertSeveritySchema,
  IncidentSeveritySchema,
  IncidentStateSchema,
} from '../src/schemas/contracts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    workflow_runs_success: 100,
    workflow_runs_failure: 0,
    workflow_latency_p99_ms: 5000,
    webhook_events_success: 1000,
    webhook_events_error: 0,
    retries_total: 0,
    operations_total: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SLO Definitions
// ---------------------------------------------------------------------------

describe('SLO definitions', () => {
  it('contains exactly 4 SLO definitions', () => {
    expect(SLO_DEFINITIONS).toHaveLength(4);
  });

  it('covers all expected SLO ids', () => {
    const ids = SLO_DEFINITIONS.map((d) => d.id);
    expect(ids).toContain('workflow_success_rate');
    expect(ids).toContain('workflow_latency_p99');
    expect(ids).toContain('webhook_processing_reliability');
    expect(ids).toContain('retry_budget');
  });

  it('each SLO definition passes schema validation', () => {
    for (const def of SLO_DEFINITIONS) {
      expect(() => SloIdSchema.parse(def.id)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Alert Rules
// ---------------------------------------------------------------------------

describe('alert rules', () => {
  it('contains 8 alert rules (2 per SLO)', () => {
    expect(ALERT_RULES).toHaveLength(8);
  });

  it('each rule references a valid SLO id', () => {
    for (const rule of ALERT_RULES) {
      expect(() => SloIdSchema.parse(rule.slo_id)).not.toThrow();
    }
  });

  it('each rule has a valid severity', () => {
    for (const rule of ALERT_RULES) {
      expect(() => AlertSeveritySchema.parse(rule.severity)).not.toThrow();
    }
  });

  it('each SLO has both critical and warning rules', () => {
    const sloIds = [...new Set(ALERT_RULES.map((r) => r.slo_id))];
    for (const sloId of sloIds) {
      const severities = ALERT_RULES.filter((r) => r.slo_id === sloId).map((r) => r.severity);
      expect(severities).toContain('critical');
      expect(severities).toContain('warning');
    }
  });
});

// ---------------------------------------------------------------------------
// SLO Evaluation
// ---------------------------------------------------------------------------

describe('evaluateSlos', () => {
  it('returns "met" for all SLOs when metrics are healthy', () => {
    const snapshot = makeSnapshot();
    const results = evaluateSlos(snapshot);
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.compliance).toBe('met');
    }
  });

  it('returns "no_data" when no observations exist', () => {
    const snapshot = makeSnapshot({
      workflow_runs_success: 0,
      workflow_runs_failure: 0,
      workflow_latency_p99_ms: null,
      webhook_events_success: 0,
      webhook_events_error: 0,
      retries_total: 0,
      operations_total: 0,
    });
    const results = evaluateSlos(snapshot);
    for (const result of results) {
      expect(result.compliance).toBe('no_data');
    }
  });

  it('detects workflow success rate breach', () => {
    const snapshot = makeSnapshot({
      workflow_runs_success: 90,
      workflow_runs_failure: 10,
    });
    const results = evaluateSlos(snapshot);
    const sr = results.find((r) => r.slo_id === 'workflow_success_rate');
    expect(sr?.compliance).toBe('breached');
    expect(sr?.current_value).toBe(90);
  });

  it('detects workflow success rate exactly at boundary as met', () => {
    const snapshot = makeSnapshot({
      workflow_runs_success: 95,
      workflow_runs_failure: 5,
    });
    const results = evaluateSlos(snapshot);
    const sr = results.find((r) => r.slo_id === 'workflow_success_rate');
    expect(sr?.compliance).toBe('met');
    expect(sr?.current_value).toBe(95);
  });

  it('detects workflow latency breach', () => {
    const snapshot = makeSnapshot({
      workflow_latency_p99_ms: 130_000,
    });
    const results = evaluateSlos(snapshot);
    const lat = results.find((r) => r.slo_id === 'workflow_latency_p99');
    expect(lat?.compliance).toBe('breached');
    expect(lat?.current_value).toBe(130_000);
  });

  it('detects workflow latency at boundary as met', () => {
    const snapshot = makeSnapshot({
      workflow_latency_p99_ms: 120_000,
    });
    const results = evaluateSlos(snapshot);
    const lat = results.find((r) => r.slo_id === 'workflow_latency_p99');
    expect(lat?.compliance).toBe('met');
  });

  it('detects webhook reliability breach', () => {
    const snapshot = makeSnapshot({
      webhook_events_success: 990,
      webhook_events_error: 10,
    });
    const results = evaluateSlos(snapshot);
    const wh = results.find((r) => r.slo_id === 'webhook_processing_reliability');
    expect(wh?.compliance).toBe('breached');
    expect(wh?.current_value).toBe(99);
  });

  it('detects retry budget breach', () => {
    const snapshot = makeSnapshot({
      retries_total: 15,
      operations_total: 100,
    });
    const results = evaluateSlos(snapshot);
    const rb = results.find((r) => r.slo_id === 'retry_budget');
    expect(rb?.compliance).toBe('breached');
    expect(rb?.current_value).toBe(15);
  });

  it('retry budget at boundary is met', () => {
    const snapshot = makeSnapshot({
      retries_total: 10,
      operations_total: 100,
    });
    const results = evaluateSlos(snapshot);
    const rb = results.find((r) => r.slo_id === 'retry_budget');
    expect(rb?.compliance).toBe('met');
    expect(rb?.current_value).toBe(10);
  });

  it('each evaluation result passes schema validation', () => {
    const snapshot = makeSnapshot();
    const results = evaluateSlos(snapshot);
    for (const result of results) {
      expect(() => SloEvaluationResultSchema.parse(result)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Alert Matching
// ---------------------------------------------------------------------------

describe('matchAlerts', () => {
  it('fires no alerts when all metrics are healthy', () => {
    const snapshot = makeSnapshot();
    const alerts = matchAlerts(snapshot);
    expect(alerts).toHaveLength(0);
  });

  it('fires warning alert when SLO is breached at warning level', () => {
    // Success rate at 94% breaches 95% warning but not 90% critical
    const snapshot = makeSnapshot({
      workflow_runs_success: 94,
      workflow_runs_failure: 6,
    });
    const alerts = matchAlerts(snapshot);
    const warning = alerts.find((a) => a.rule_id === 'workflow_success_rate_warning');
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('warning');

    const critical = alerts.find((a) => a.rule_id === 'workflow_success_rate_critical');
    expect(critical).toBeUndefined();
  });

  it('fires both warning and critical when below critical threshold', () => {
    // Success rate at 85% breaches both 95% warning and 90% critical
    const snapshot = makeSnapshot({
      workflow_runs_success: 85,
      workflow_runs_failure: 15,
    });
    const alerts = matchAlerts(snapshot);
    expect(alerts.some((a) => a.rule_id === 'workflow_success_rate_warning')).toBe(true);
    expect(alerts.some((a) => a.rule_id === 'workflow_success_rate_critical')).toBe(true);
  });

  it('fires latency alerts correctly', () => {
    // 150s breaches 120s warning but not 180s critical
    const snapshot = makeSnapshot({
      workflow_latency_p99_ms: 150_000,
    });
    const alerts = matchAlerts(snapshot);
    expect(alerts.some((a) => a.rule_id === 'workflow_latency_p99_warning')).toBe(true);
    expect(alerts.some((a) => a.rule_id === 'workflow_latency_p99_critical')).toBe(false);
  });

  it('fires latency critical alert at 200s', () => {
    const snapshot = makeSnapshot({
      workflow_latency_p99_ms: 200_000,
    });
    const alerts = matchAlerts(snapshot);
    expect(alerts.some((a) => a.rule_id === 'workflow_latency_p99_critical')).toBe(true);
    expect(alerts.some((a) => a.rule_id === 'workflow_latency_p99_warning')).toBe(true);
  });

  it('fires webhook reliability alerts', () => {
    // 97% reliability breaches both 99.5% warning and 98% critical
    const snapshot = makeSnapshot({
      webhook_events_success: 970,
      webhook_events_error: 30,
    });
    const alerts = matchAlerts(snapshot);
    expect(alerts.some((a) => a.rule_id === 'webhook_reliability_warning')).toBe(true);
    expect(alerts.some((a) => a.rule_id === 'webhook_reliability_critical')).toBe(true);
  });

  it('fires retry budget alerts', () => {
    // 15% retries breaches 10% warning but not 20% critical
    const snapshot = makeSnapshot({
      retries_total: 15,
      operations_total: 100,
    });
    const alerts = matchAlerts(snapshot);
    expect(alerts.some((a) => a.rule_id === 'retry_budget_warning')).toBe(true);
    expect(alerts.some((a) => a.rule_id === 'retry_budget_critical')).toBe(false);
  });

  it('does not fire alerts when there is no data', () => {
    const snapshot = makeSnapshot({
      workflow_runs_success: 0,
      workflow_runs_failure: 0,
      workflow_latency_p99_ms: null,
      webhook_events_success: 0,
      webhook_events_error: 0,
      retries_total: 0,
      operations_total: 0,
    });
    const alerts = matchAlerts(snapshot);
    expect(alerts).toHaveLength(0);
  });

  it('each fired alert passes schema validation', () => {
    const snapshot = makeSnapshot({
      workflow_runs_success: 80,
      workflow_runs_failure: 20,
    });
    const alerts = matchAlerts(snapshot);
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(() => FiredAlertSchema.parse(alert)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Overall Compliance
// ---------------------------------------------------------------------------

describe('overallCompliance', () => {
  it('returns "met" when all SLOs are met', () => {
    const results = evaluateSlos(makeSnapshot());
    expect(overallCompliance(results)).toBe('met');
  });

  it('returns "breached" when any SLO is breached', () => {
    const results = evaluateSlos(
      makeSnapshot({ workflow_runs_success: 80, workflow_runs_failure: 20 }),
    );
    expect(overallCompliance(results)).toBe('breached');
  });

  it('returns "no_data" when all SLOs have no data', () => {
    const results = evaluateSlos(
      makeSnapshot({
        workflow_runs_success: 0,
        workflow_runs_failure: 0,
        workflow_latency_p99_ms: null,
        webhook_events_success: 0,
        webhook_events_error: 0,
        retries_total: 0,
        operations_total: 0,
      }),
    );
    expect(overallCompliance(results)).toBe('no_data');
  });
});

// ---------------------------------------------------------------------------
// SLO Status Response Schema Validation
// ---------------------------------------------------------------------------

describe('SloStatusResponseSchema', () => {
  it('validates a complete SLO status response', () => {
    const snapshot = makeSnapshot({
      workflow_runs_success: 80,
      workflow_runs_failure: 20,
    });
    const slos = evaluateSlos(snapshot);
    const firedAlerts = matchAlerts(snapshot);
    const compliance = overallCompliance(slos);

    const response = {
      evaluated_at: new Date().toISOString(),
      slos,
      fired_alerts: firedAlerts,
      overall_compliance: compliance,
    };

    expect(() => SloStatusResponseSchema.parse(response)).not.toThrow();
  });

  it('rejects response missing evaluated_at', () => {
    expect(() =>
      SloStatusResponseSchema.parse({
        slos: [],
        fired_alerts: [],
        overall_compliance: 'met',
      }),
    ).toThrow();
  });

  it('rejects response with invalid compliance value', () => {
    expect(() =>
      SloStatusResponseSchema.parse({
        evaluated_at: new Date().toISOString(),
        slos: [],
        fired_alerts: [],
        overall_compliance: 'invalid',
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Incident Classification
// ---------------------------------------------------------------------------

describe('classifyIncidentSeverity', () => {
  it('returns null when no alerts are fired', () => {
    expect(classifyIncidentSeverity([])).toBeNull();
  });

  it('returns P1 when 2+ critical alerts fire', () => {
    const alerts = matchAlerts(
      makeSnapshot({
        workflow_runs_success: 80,
        workflow_runs_failure: 20,
        webhook_events_success: 970,
        webhook_events_error: 30,
      }),
    );
    const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
    expect(criticalCount).toBeGreaterThanOrEqual(2);
    expect(classifyIncidentSeverity(alerts)).toBe('P1');
  });

  it('returns P2 when exactly 1 critical alert fires', () => {
    const alerts = matchAlerts(
      makeSnapshot({
        workflow_runs_success: 85,
        workflow_runs_failure: 15,
      }),
    );
    // 85% success: breaches 90% critical (1 critical) and 95% warning (1 warning)
    const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
    expect(criticalCount).toBe(1);
    expect(classifyIncidentSeverity(alerts)).toBe('P2');
  });

  it('returns P3 when only warning alerts fire', () => {
    const alerts = matchAlerts(
      makeSnapshot({
        workflow_runs_success: 94,
        workflow_runs_failure: 6,
      }),
    );
    // 94% success: breaches 95% warning only
    const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
    const warningCount = alerts.filter((a) => a.severity === 'warning').length;
    expect(criticalCount).toBe(0);
    expect(warningCount).toBeGreaterThanOrEqual(1);
    expect(classifyIncidentSeverity(alerts)).toBe('P3');
  });

  it('returns P4 for info-only alerts', () => {
    // Construct a synthetic info alert
    const infoAlert = {
      rule_id: 'test_info',
      slo_id: 'workflow_success_rate' as const,
      severity: 'info' as const,
      description: 'Informational alert',
      runbook_url: 'runbooks/test.md',
      current_value: 99,
      threshold: 99,
    };
    expect(classifyIncidentSeverity([infoAlert])).toBe('P4');
  });
});

// ---------------------------------------------------------------------------
// Runbook Reference
// ---------------------------------------------------------------------------

describe('runbookForSeverity', () => {
  it('returns correct runbook for each severity level', () => {
    expect(runbookForSeverity('P1')).toBe('runbooks/incident-p1.md');
    expect(runbookForSeverity('P2')).toBe('runbooks/incident-p2.md');
    expect(runbookForSeverity('P3')).toBe('runbooks/incident-p3.md');
    expect(runbookForSeverity('P4')).toBe('runbooks/incident-p4.md');
  });
});

// ---------------------------------------------------------------------------
// Incident State Machine
// ---------------------------------------------------------------------------

describe('incident state transitions', () => {
  it('allows detected -> acknowledged', () => {
    expect(isValidTransition('detected', 'acknowledged')).toBe(true);
  });

  it('allows acknowledged -> mitigating', () => {
    expect(isValidTransition('acknowledged', 'mitigating')).toBe(true);
  });

  it('allows mitigating -> resolved', () => {
    expect(isValidTransition('mitigating', 'resolved')).toBe(true);
  });

  it('disallows detected -> mitigating (skip)', () => {
    expect(isValidTransition('detected', 'mitigating')).toBe(false);
  });

  it('disallows detected -> resolved (skip)', () => {
    expect(isValidTransition('detected', 'resolved')).toBe(false);
  });

  it('disallows resolved -> detected (backward)', () => {
    expect(isValidTransition('resolved', 'detected')).toBe(false);
  });

  it('disallows acknowledged -> detected (backward)', () => {
    expect(isValidTransition('acknowledged', 'detected')).toBe(false);
  });

  it('disallows resolved -> anything', () => {
    expect(isValidTransition('resolved', 'acknowledged')).toBe(false);
    expect(isValidTransition('resolved', 'mitigating')).toBe(false);
    expect(isValidTransition('resolved', 'resolved')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Incident Title Builder
// ---------------------------------------------------------------------------

describe('buildIncidentTitle', () => {
  it('includes severity prefix', () => {
    const title = buildIncidentTitle('P1', []);
    expect(title).toContain('[P1]');
  });

  it('uses single alert description when only one alert', () => {
    const alerts = matchAlerts(
      makeSnapshot({
        workflow_runs_success: 94,
        workflow_runs_failure: 6,
      }),
    );
    // filter to just one alert for the test
    const singleAlert = [alerts[0]!];
    const title = buildIncidentTitle('P3', singleAlert);
    expect(title).toContain(singleAlert[0]!.description);
  });

  it('shows count when multiple alerts', () => {
    const alerts = matchAlerts(
      makeSnapshot({
        workflow_runs_success: 80,
        workflow_runs_failure: 20,
        webhook_events_success: 970,
        webhook_events_error: 30,
      }),
    );
    expect(alerts.length).toBeGreaterThan(1);
    const title = buildIncidentTitle('P1', alerts);
    expect(title).toContain(`${alerts.length} alert rules triggered`);
  });
});

// ---------------------------------------------------------------------------
// Severity Definitions
// ---------------------------------------------------------------------------

describe('severity definitions', () => {
  it('contains all 4 severity levels', () => {
    const severities = SEVERITY_DEFINITIONS.map((s) => s.severity);
    expect(severities).toContain('P1');
    expect(severities).toContain('P2');
    expect(severities).toContain('P3');
    expect(severities).toContain('P4');
  });

  it('each severity passes schema validation', () => {
    for (const def of SEVERITY_DEFINITIONS) {
      expect(() => IncidentSeveritySchema.parse(def.severity)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Incident Record Schema Validation
// ---------------------------------------------------------------------------

describe('IncidentRecordSchema', () => {
  it('validates a well-formed incident record', () => {
    const now = new Date().toISOString();
    const record = {
      incident_id: 'inc-001',
      severity: 'P2',
      state: 'detected',
      title: '[P2] Workflow success rate dropped below 90%',
      description: 'Critical SLO breach detected',
      fired_alerts: ['workflow_success_rate_critical'],
      runbook_url: 'runbooks/incident-p2.md',
      created_at: now,
      updated_at: now,
    };
    expect(() => IncidentRecordSchema.parse(record)).not.toThrow();
  });

  it('rejects invalid severity', () => {
    const now = new Date().toISOString();
    expect(() =>
      IncidentRecordSchema.parse({
        incident_id: 'inc-001',
        severity: 'P5',
        state: 'detected',
        title: 'Test',
        description: 'Test',
        fired_alerts: [],
        runbook_url: 'runbooks/test.md',
        created_at: now,
        updated_at: now,
      }),
    ).toThrow();
  });

  it('rejects invalid state', () => {
    const now = new Date().toISOString();
    expect(() =>
      IncidentRecordSchema.parse({
        incident_id: 'inc-001',
        severity: 'P2',
        state: 'unknown',
        title: 'Test',
        description: 'Test',
        fired_alerts: [],
        runbook_url: 'runbooks/test.md',
        created_at: now,
        updated_at: now,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Incident Transition Map
// ---------------------------------------------------------------------------

describe('INCIDENT_TRANSITIONS', () => {
  it('has entries for all states', () => {
    const states: Array<'detected' | 'acknowledged' | 'mitigating' | 'resolved'> = [
      'detected',
      'acknowledged',
      'mitigating',
      'resolved',
    ];
    for (const state of states) {
      expect(INCIDENT_TRANSITIONS).toHaveProperty(state);
      expect(Array.isArray(INCIDENT_TRANSITIONS[state])).toBe(true);
    }
  });

  it('each target state is a valid IncidentState', () => {
    for (const targets of Object.values(INCIDENT_TRANSITIONS)) {
      for (const target of targets) {
        expect(() => IncidentStateSchema.parse(target)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Schema Enum Round-Trip
// ---------------------------------------------------------------------------

describe('exported Zod enums round-trip', () => {
  it('SloIdSchema accepts all valid IDs', () => {
    for (const id of ['workflow_success_rate', 'workflow_latency_p99', 'webhook_processing_reliability', 'retry_budget']) {
      expect(() => SloIdSchema.parse(id)).not.toThrow();
    }
  });

  it('SloComplianceSchema accepts all valid values', () => {
    for (const v of ['met', 'breached', 'no_data']) {
      expect(() => SloComplianceSchema.parse(v)).not.toThrow();
    }
  });

  it('AlertSeveritySchema accepts all valid values', () => {
    for (const v of ['critical', 'warning', 'info']) {
      expect(() => AlertSeveritySchema.parse(v)).not.toThrow();
    }
  });

  it('IncidentSeveritySchema accepts all valid values', () => {
    for (const v of ['P1', 'P2', 'P3', 'P4']) {
      expect(() => IncidentSeveritySchema.parse(v)).not.toThrow();
    }
  });

  it('IncidentStateSchema accepts all valid values', () => {
    for (const v of ['detected', 'acknowledged', 'mitigating', 'resolved']) {
      expect(() => IncidentStateSchema.parse(v)).not.toThrow();
    }
  });
});
