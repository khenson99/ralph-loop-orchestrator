/**
 * Client-side telemetry collector for frontend observability.
 *
 * Tracks action latency, SSE health, render performance, and errors
 * using an in-memory ring buffer with no external dependencies.
 */

const DEFAULT_BUFFER_SIZE = 200;
const DEFAULT_LATENCY_BUFFER_SIZE = 100;

/**
 * @typedef {'connected' | 'reconnecting' | 'disconnected'} SseState
 *
 * @typedef {Object} LatencyEntry
 * @property {string} action
 * @property {number} startTime
 * @property {number} endTime
 * @property {number} durationMs
 *
 * @typedef {Object} ErrorEntry
 * @property {number} timestamp
 * @property {string} source
 * @property {string} message
 * @property {string} [severity]
 *
 * @typedef {Object} SseHealthSnapshot
 * @property {SseState} state
 * @property {number} reconnectCount
 * @property {number|null} lastMessageAt
 * @property {number} messageLagMs
 *
 * @typedef {Object} TelemetrySummary
 * @property {Object} latency
 * @property {number} latency.count
 * @property {number} latency.avgMs
 * @property {number} latency.p95Ms
 * @property {number} latency.maxMs
 * @property {SseHealthSnapshot} sseHealth
 * @property {Object} render
 * @property {number} render.count
 * @property {number} render.avgMs
 * @property {number} render.maxMs
 * @property {Object} errors
 * @property {number} errors.total
 * @property {number} errors.recent
 * @property {number} collectedAt
 */

/**
 * Create a ring buffer of fixed capacity.
 * @template T
 * @param {number} capacity
 * @returns {{ push: (item: T) => void, entries: () => T[], size: () => number, clear: () => void }}
 */
function createRingBuffer(capacity) {
  /** @type {T[]} */
  const buffer = [];
  let writeIndex = 0;
  let full = false;

  return {
    push(item) {
      if (full) {
        buffer[writeIndex] = item;
      } else {
        buffer.push(item);
      }
      writeIndex = (writeIndex + 1) % capacity;
      if (writeIndex === 0 && buffer.length === capacity) {
        full = true;
      }
    },
    entries() {
      if (!full) {
        return [...buffer];
      }
      return [...buffer.slice(writeIndex), ...buffer.slice(0, writeIndex)];
    },
    size() {
      return buffer.length;
    },
    clear() {
      buffer.length = 0;
      writeIndex = 0;
      full = false;
    },
  };
}

export function createTelemetryClient(options = {}) {
  const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const latencyBufferSize = options.latencyBufferSize ?? DEFAULT_LATENCY_BUFFER_SIZE;

  const latencyBuffer = createRingBuffer(latencyBufferSize);
  const errorBuffer = createRingBuffer(bufferSize);
  const renderBuffer = createRingBuffer(latencyBufferSize);

  /** @type {Map<string, number>} */
  const pendingTimers = new Map();

  /** @type {SseHealthSnapshot} */
  const sseHealth = {
    state: 'disconnected',
    reconnectCount: 0,
    lastMessageAt: null,
    messageLagMs: 0,
  };

  let totalErrors = 0;

  /**
   * Start a latency timer for an action.
   * @param {string} action
   * @returns {string} timerId for use with endLatency
   */
  function startLatency(action) {
    const timerId = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    pendingTimers.set(timerId, performance.now());
    return timerId;
  }

  /**
   * End a latency timer and record the measurement.
   * @param {string} timerId
   * @param {string} action
   */
  function endLatency(timerId, action) {
    const startTime = pendingTimers.get(timerId);
    if (startTime === undefined) {
      return;
    }
    pendingTimers.delete(timerId);
    const endTime = performance.now();
    const durationMs = endTime - startTime;
    latencyBuffer.push({
      action,
      startTime,
      endTime,
      durationMs,
    });
  }

  /**
   * Record an error event.
   * @param {string} source
   * @param {string} message
   * @param {'info'|'warning'|'error'} [severity='error']
   */
  function recordError(source, message, severity = 'error') {
    totalErrors++;
    errorBuffer.push({
      timestamp: Date.now(),
      source,
      message,
      severity,
    });
  }

  /**
   * Record a board render duration.
   * @param {number} durationMs
   */
  function recordRender(durationMs) {
    renderBuffer.push({
      timestamp: Date.now(),
      durationMs,
    });
  }

  /**
   * Update SSE connection state.
   * @param {SseState} newState
   */
  function setSseState(newState) {
    if (newState === 'reconnecting' && sseHealth.state !== 'reconnecting') {
      sseHealth.reconnectCount++;
    }
    sseHealth.state = newState;
  }

  /**
   * Record that an SSE message was received.
   */
  function recordSseMessage() {
    sseHealth.lastMessageAt = Date.now();
    sseHealth.messageLagMs = 0;
  }

  /**
   * Compute percentile from sorted values array.
   * @param {number[]} sorted
   * @param {number} pct 0-1
   * @returns {number}
   */
  function percentile(sorted, pct) {
    if (sorted.length === 0) {
      return 0;
    }
    const index = Math.ceil(pct * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Get an aggregated telemetry summary.
   * @returns {TelemetrySummary}
   */
  function getTelemetrySummary() {
    const latencies = latencyBuffer.entries();
    const durations = latencies.map((entry) => entry.durationMs).sort((a, b) => a - b);
    const avgMs = durations.length > 0 ? durations.reduce((sum, d) => sum + d, 0) / durations.length : 0;

    const renders = renderBuffer.entries();
    const renderDurations = renders.map((entry) => entry.durationMs).sort((a, b) => a - b);
    const renderAvg =
      renderDurations.length > 0 ? renderDurations.reduce((sum, d) => sum + d, 0) / renderDurations.length : 0;

    if (sseHealth.lastMessageAt !== null) {
      sseHealth.messageLagMs = Date.now() - sseHealth.lastMessageAt;
    }

    return {
      latency: {
        count: durations.length,
        avgMs: Math.round(avgMs),
        p95Ms: Math.round(percentile(durations, 0.95)),
        maxMs: Math.round(durations.length > 0 ? durations[durations.length - 1] : 0),
      },
      sseHealth: { ...sseHealth },
      render: {
        count: renderDurations.length,
        avgMs: Math.round(renderAvg),
        maxMs: Math.round(renderDurations.length > 0 ? renderDurations[renderDurations.length - 1] : 0),
      },
      errors: {
        total: totalErrors,
        recent: errorBuffer.size(),
      },
      collectedAt: Date.now(),
    };
  }

  /**
   * Get recent error entries.
   * @param {number} [limit=20]
   * @returns {ErrorEntry[]}
   */
  function getRecentErrors(limit = 20) {
    const all = errorBuffer.entries();
    return all.slice(-limit);
  }

  return {
    startLatency,
    endLatency,
    recordError,
    recordRender,
    setSseState,
    recordSseMessage,
    getTelemetrySummary,
    getRecentErrors,
  };
}
