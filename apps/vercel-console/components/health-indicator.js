/**
 * Connection health indicator component.
 *
 * Renders a small status dot with tooltip showing SSE connection health:
 * - Green: SSE connected, recent data
 * - Yellow: SSE reconnecting or stale data (>30s)
 * - Red: SSE disconnected or API errors
 */

import { escapeHtml } from '../lib/format.js';

const STALE_THRESHOLD_MS = 30_000;

/**
 * @typedef {'healthy' | 'degraded' | 'unhealthy'} HealthLevel
 */

/**
 * Create a health indicator that can be inserted into the DOM.
 *
 * @param {Object} params
 * @param {HTMLElement} params.container - Element to append the indicator into
 * @param {() => import('../lib/telemetry-client.js').TelemetrySummary} params.getTelemetry
 * @returns {{ update: () => void, destroy: () => void }}
 */
export function createHealthIndicator(params) {
  const { container, getTelemetry } = params;

  const wrapper = document.createElement('span');
  wrapper.className = 'health-indicator';
  wrapper.setAttribute('aria-label', 'Connection health');

  const dot = document.createElement('span');
  dot.className = 'health-dot';
  wrapper.appendChild(dot);

  const tooltip = document.createElement('span');
  tooltip.className = 'health-tooltip';
  tooltip.setAttribute('role', 'status');
  wrapper.appendChild(tooltip);

  container.appendChild(wrapper);

  /**
   * Determine health level from telemetry.
   * @param {import('../lib/telemetry-client.js').TelemetrySummary} summary
   * @returns {HealthLevel}
   */
  function computeLevel(summary) {
    const { sseHealth } = summary;

    if (sseHealth.state === 'disconnected') {
      return 'unhealthy';
    }

    if (sseHealth.state === 'reconnecting') {
      return 'degraded';
    }

    if (sseHealth.lastMessageAt !== null && sseHealth.messageLagMs > STALE_THRESHOLD_MS) {
      return 'degraded';
    }

    if (summary.errors.total > 0 && summary.errors.recent > 5) {
      return 'degraded';
    }

    return 'healthy';
  }

  /**
   * Format the tooltip content.
   * @param {import('../lib/telemetry-client.js').TelemetrySummary} summary
   * @param {HealthLevel} level
   * @returns {string}
   */
  function formatTooltip(summary, level) {
    const { sseHealth, latency, errors } = summary;
    const labelMap = { healthy: 'Connected', degraded: 'Degraded', unhealthy: 'Disconnected' };
    const lastUpdate =
      sseHealth.lastMessageAt !== null ? new Date(sseHealth.lastMessageAt).toLocaleTimeString() : 'never';
    const lagSec = sseHealth.messageLagMs > 0 ? (sseHealth.messageLagMs / 1000).toFixed(1) : '0';

    return [
      `Status: ${escapeHtml(labelMap[level])}`,
      `SSE: ${escapeHtml(sseHealth.state)} (reconnects: ${sseHealth.reconnectCount})`,
      `Last update: ${escapeHtml(lastUpdate)} (${lagSec}s ago)`,
      `Latency avg: ${latency.avgMs}ms p95: ${latency.p95Ms}ms`,
      `Errors: ${errors.total} total, ${errors.recent} recent`,
    ].join('\n');
  }

  function update() {
    const summary = getTelemetry();
    const level = computeLevel(summary);

    dot.dataset.health = level;
    tooltip.textContent = formatTooltip(summary, level);
  }

  function destroy() {
    wrapper.remove();
  }

  update();

  return { update, destroy };
}
