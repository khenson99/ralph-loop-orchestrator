import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Time control — use vitest fake timers for Date.now() and save/restore
// performance.now() manually so we don't pollute other test files.
// ---------------------------------------------------------------------------

let mockPerfNow = 1000;
const _origPerformance = globalThis.performance;

beforeAll(() => {
  vi.useFakeTimers({ now: 1000 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- override read-only for test
  (globalThis as any).performance = { ..._origPerformance, now: () => mockPerfNow };
});

afterAll(() => {
  vi.useRealTimers();
  globalThis.performance = _origPerformance;
});

// @ts-expect-error -- vanilla JS module without type declarations
const mod = await import('../apps/orchestrator-ui/src/lib/telemetry-client.js');
const { createTelemetryClient } = mod;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function advance(ms: number) {
  mockPerfNow += ms;
  vi.advanceTimersByTime(ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockPerfNow = 1000;
  vi.setSystemTime(1000);
});

describe('createTelemetryClient', () => {
  it('returns an object with the expected API surface', () => {
    const client = createTelemetryClient();
    expect(typeof client.startLatency).toBe('function');
    expect(typeof client.endLatency).toBe('function');
    expect(typeof client.recordError).toBe('function');
    expect(typeof client.recordRender).toBe('function');
    expect(typeof client.setSseState).toBe('function');
    expect(typeof client.recordSseMessage).toBe('function');
    expect(typeof client.getTelemetrySummary).toBe('function');
    expect(typeof client.getRecentErrors).toBe('function');
  });
});

describe('latency tracking', () => {
  it('records a latency measurement via start/end', () => {
    const client = createTelemetryClient();

    const timerId = client.startLatency('approve');
    advance(42);
    client.endLatency(timerId, 'approve');

    const summary = client.getTelemetrySummary();
    expect(summary.latency.count).toBe(1);
    expect(summary.latency.avgMs).toBe(42);
    expect(summary.latency.maxMs).toBe(42);
    expect(summary.latency.p95Ms).toBe(42);
  });

  it('tracks multiple latency measurements', () => {
    const client = createTelemetryClient();

    const t1 = client.startLatency('approve');
    advance(10);
    client.endLatency(t1, 'approve');

    const t2 = client.startLatency('reject');
    advance(30);
    client.endLatency(t2, 'reject');

    const t3 = client.startLatency('retry');
    advance(20);
    client.endLatency(t3, 'retry');

    const summary = client.getTelemetrySummary();
    expect(summary.latency.count).toBe(3);
    expect(summary.latency.avgMs).toBe(20); // (10+30+20)/3
    expect(summary.latency.maxMs).toBe(30);
  });

  it('silently ignores endLatency for unknown timer IDs', () => {
    const client = createTelemetryClient();
    // Should not throw
    client.endLatency('nonexistent-timer', 'someAction');
    const summary = client.getTelemetrySummary();
    expect(summary.latency.count).toBe(0);
  });

  it('returns empty summary when no data recorded', () => {
    const client = createTelemetryClient();
    const summary = client.getTelemetrySummary();
    expect(summary.latency.count).toBe(0);
    expect(summary.latency.avgMs).toBe(0);
    expect(summary.latency.p95Ms).toBe(0);
    expect(summary.latency.maxMs).toBe(0);
  });

  it('respects latency buffer size limit', () => {
    const client = createTelemetryClient({ latencyBufferSize: 3 });

    for (let i = 1; i <= 5; i++) {
      const t = client.startLatency('action');
      advance(i * 10);
      client.endLatency(t, 'action');
    }

    const summary = client.getTelemetrySummary();
    // Only the most recent 3 should remain
    expect(summary.latency.count).toBe(3);
  });
});

describe('error tracking', () => {
  it('records errors and increments total', () => {
    const client = createTelemetryClient();

    client.recordError('fetch', 'Network error');
    client.recordError('fetch', 'Timeout');

    const summary = client.getTelemetrySummary();
    expect(summary.errors.total).toBe(2);
    expect(summary.errors.recent).toBe(2);
  });

  it('getRecentErrors returns recorded errors', () => {
    const client = createTelemetryClient();

    client.recordError('fetchBoard', '404 Not Found');
    advance(100);
    client.recordError('performAction', 'Server Error');

    const errors = client.getRecentErrors();
    expect(errors).toHaveLength(2);
    expect(errors[0]?.source).toBe('fetchBoard');
    expect(errors[0]?.message).toBe('404 Not Found');
    expect(errors[1]?.source).toBe('performAction');
    expect(errors[1]?.message).toBe('Server Error');
  });

  it('limits getRecentErrors to requested count', () => {
    const client = createTelemetryClient();

    for (let i = 0; i < 10; i++) {
      client.recordError('source', `Error ${i}`);
    }

    const limited = client.getRecentErrors(3);
    expect(limited).toHaveLength(3);
    // Should be the 3 most recent
    expect(limited[0]?.message).toBe('Error 7');
    expect(limited[2]?.message).toBe('Error 9');
  });

  it('records error severity', () => {
    const client = createTelemetryClient();

    client.recordError('source', 'info msg', 'info');
    client.recordError('source', 'warn msg', 'warning');
    client.recordError('source', 'err msg', 'error');

    const errors = client.getRecentErrors();
    expect(errors[0]?.severity).toBe('info');
    expect(errors[1]?.severity).toBe('warning');
    expect(errors[2]?.severity).toBe('error');
  });

  it('defaults error severity to error', () => {
    const client = createTelemetryClient();
    client.recordError('test', 'msg');
    const errors = client.getRecentErrors();
    expect(errors[0]?.severity).toBe('error');
  });

  it('respects error buffer size limit', () => {
    const client = createTelemetryClient({ bufferSize: 5 });

    for (let i = 0; i < 10; i++) {
      client.recordError('src', `Error ${i}`);
    }

    const summary = client.getTelemetrySummary();
    expect(summary.errors.total).toBe(10); // total is always accurate
    expect(summary.errors.recent).toBe(5); // ring buffer capped at 5
  });
});

describe('SSE health tracking', () => {
  it('starts in disconnected state', () => {
    const client = createTelemetryClient();
    const summary = client.getTelemetrySummary();
    expect(summary.sseHealth.state).toBe('disconnected');
    expect(summary.sseHealth.reconnectCount).toBe(0);
    expect(summary.sseHealth.lastMessageAt).toBeNull();
    expect(summary.sseHealth.messageLagMs).toBe(0);
  });

  it('transitions to connected state', () => {
    const client = createTelemetryClient();
    client.setSseState('connected');

    const summary = client.getTelemetrySummary();
    expect(summary.sseHealth.state).toBe('connected');
    expect(summary.sseHealth.reconnectCount).toBe(0);
  });

  it('increments reconnect count on transition to reconnecting', () => {
    const client = createTelemetryClient();

    client.setSseState('connected');
    client.setSseState('reconnecting');

    const summary = client.getTelemetrySummary();
    expect(summary.sseHealth.state).toBe('reconnecting');
    expect(summary.sseHealth.reconnectCount).toBe(1);
  });

  it('does not increment reconnect count for repeated reconnecting calls', () => {
    const client = createTelemetryClient();

    client.setSseState('reconnecting');
    client.setSseState('reconnecting');
    client.setSseState('reconnecting');

    const summary = client.getTelemetrySummary();
    expect(summary.sseHealth.reconnectCount).toBe(1);
  });

  it('tracks multiple reconnect cycles', () => {
    const client = createTelemetryClient();

    client.setSseState('connected');
    client.setSseState('reconnecting');
    client.setSseState('connected');
    client.setSseState('reconnecting');
    client.setSseState('connected');

    const summary = client.getTelemetrySummary();
    expect(summary.sseHealth.state).toBe('connected');
    expect(summary.sseHealth.reconnectCount).toBe(2);
  });

  it('records SSE message timestamps', () => {
    const client = createTelemetryClient();
    client.setSseState('connected');

    client.recordSseMessage();
    const summary = client.getTelemetrySummary();
    expect(summary.sseHealth.lastMessageAt).toBe(Date.now());
    expect(summary.sseHealth.messageLagMs).toBe(0);
  });

  it('computes message lag on summary', () => {
    const client = createTelemetryClient();
    client.setSseState('connected');
    client.recordSseMessage();

    advance(5000);

    const summary = client.getTelemetrySummary();
    expect(summary.sseHealth.messageLagMs).toBe(5000);
  });

  it('returns snapshot copy (mutations do not affect internal state)', () => {
    const client = createTelemetryClient();
    client.setSseState('connected');

    const summary = client.getTelemetrySummary();
    summary.sseHealth.state = 'disconnected';
    summary.sseHealth.reconnectCount = 999;

    const fresh = client.getTelemetrySummary();
    expect(fresh.sseHealth.state).toBe('connected');
    expect(fresh.sseHealth.reconnectCount).toBe(0);
  });
});

describe('render tracking', () => {
  it('records render durations', () => {
    const client = createTelemetryClient();

    client.recordRender(8);
    client.recordRender(12);
    client.recordRender(5);

    const summary = client.getTelemetrySummary();
    expect(summary.render.count).toBe(3);
    expect(summary.render.avgMs).toBeCloseTo(8.3, 0);
    expect(summary.render.maxMs).toBe(12);
  });

  it('returns zero render stats when no renders recorded', () => {
    const client = createTelemetryClient();
    const summary = client.getTelemetrySummary();
    expect(summary.render.count).toBe(0);
    expect(summary.render.avgMs).toBe(0);
    expect(summary.render.maxMs).toBe(0);
  });

  it('respects render buffer size limit', () => {
    const client = createTelemetryClient({ latencyBufferSize: 3 });

    for (let i = 0; i < 5; i++) {
      client.recordRender(i * 5);
    }

    const summary = client.getTelemetrySummary();
    expect(summary.render.count).toBe(3);
  });
});

describe('telemetry summary', () => {
  it('includes collectedAt timestamp', () => {
    const client = createTelemetryClient();
    const summary = client.getTelemetrySummary();
    expect(summary.collectedAt).toBe(Date.now());
  });

  it('aggregates all dimensions together', () => {
    const client = createTelemetryClient();

    // Latency
    const t1 = client.startLatency('approve');
    advance(25);
    client.endLatency(t1, 'approve');

    // Error
    client.recordError('test', 'oops');

    // SSE
    client.setSseState('connected');
    client.recordSseMessage();

    // Render
    client.recordRender(6);

    const summary = client.getTelemetrySummary();
    expect(summary.latency.count).toBe(1);
    expect(summary.latency.avgMs).toBe(25);
    expect(summary.errors.total).toBe(1);
    expect(summary.errors.recent).toBe(1);
    expect(summary.sseHealth.state).toBe('connected');
    expect(summary.sseHealth.lastMessageAt).not.toBeNull();
    expect(summary.render.count).toBe(1);
    expect(summary.render.avgMs).toBe(6);
    expect(summary.collectedAt).toBe(Date.now());
  });
});

describe('ring buffer overflow', () => {
  it('evicts oldest entries when buffer overflows', () => {
    const client = createTelemetryClient({ bufferSize: 3 });

    client.recordError('s', 'e1');
    client.recordError('s', 'e2');
    client.recordError('s', 'e3');
    client.recordError('s', 'e4');
    client.recordError('s', 'e5');

    const errors = client.getRecentErrors(10);
    expect(errors).toHaveLength(3);
    // Oldest (e1, e2) should be evicted, newest 3 remain
    const messages = errors.map((e: { message: string }) => e.message);
    expect(messages).toContain('e3');
    expect(messages).toContain('e4');
    expect(messages).toContain('e5');
    expect(messages).not.toContain('e1');
    expect(messages).not.toContain('e2');
  });
});
