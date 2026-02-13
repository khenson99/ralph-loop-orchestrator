/**
 * Lightweight toast notification system for UX-visible errors.
 *
 * Auto-dismiss after configurable timeout, stack multiple toasts,
 * and support severity levels (info, warning, error).
 * Uses role="alert" for screen reader accessibility.
 */

import { escapeHtml } from '../lib/format.js';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_VISIBLE_TOASTS = 5;

/**
 * @typedef {'info' | 'warning' | 'error'} ToastSeverity
 *
 * @typedef {Object} ToastOptions
 * @property {ToastSeverity} [severity='error']
 * @property {number} [timeoutMs]
 */

/**
 * Create a toast notification manager.
 * Appends a container to the document body if needed.
 *
 * @param {Object} [options]
 * @param {number} [options.defaultTimeout=5000]
 * @returns {{ show: (message: string, options?: ToastOptions) => void, dismiss: (id: string) => void }}
 */
export function createErrorToast(options = {}) {
  const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT_MS;

  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'assertive');
    container.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(container);
  }

  /** @type {Map<string, { element: HTMLElement, timer: number|null }>} */
  const activeToasts = new Map();
  let toastCounter = 0;

  /**
   * Remove a toast by id.
   * @param {string} id
   */
  function dismiss(id) {
    const entry = activeToasts.get(id);
    if (!entry) {
      return;
    }
    if (entry.timer !== null) {
      window.clearTimeout(entry.timer);
    }
    entry.element.classList.add('toast-exit');
    window.setTimeout(() => {
      entry.element.remove();
      activeToasts.delete(id);
    }, 250);
  }

  /**
   * Enforce max visible limit by removing oldest.
   */
  function trimOldest() {
    while (activeToasts.size >= MAX_VISIBLE_TOASTS) {
      const oldestId = activeToasts.keys().next().value;
      if (oldestId) {
        dismiss(oldestId);
      }
    }
  }

  /**
   * Show a toast notification.
   * @param {string} message
   * @param {ToastOptions} [toastOptions]
   */
  function show(message, toastOptions = {}) {
    trimOldest();

    const severity = toastOptions.severity ?? 'error';
    const timeoutMs = toastOptions.timeoutMs ?? defaultTimeout;
    const id = `toast-${++toastCounter}`;

    const element = document.createElement('div');
    element.className = `toast toast-${severity}`;
    element.setAttribute('role', 'alert');
    element.setAttribute('data-toast-id', id);
    element.innerHTML = `
      <span class="toast-message">${escapeHtml(message)}</span>
      <button class="toast-close" type="button" aria-label="Dismiss">&times;</button>
    `;

    const closeButton = element.querySelector('.toast-close');
    closeButton?.addEventListener('click', () => dismiss(id));

    container.appendChild(element);

    const timer = timeoutMs > 0 ? window.setTimeout(() => dismiss(id), timeoutMs) : null;
    activeToasts.set(id, { element, timer });
  }

  /**
   * Dismiss all visible toasts.
   */
  function dismissAll() {
    for (const id of [...activeToasts.keys()]) {
      dismiss(id);
    }
  }

  /**
   * Get count of active (non-exiting) toasts.
   * @returns {number}
   */
  function count() {
    return activeToasts.size;
  }

  return {
    show,
    dismiss,
    dismissAll,
    count,
  };
}
