/**
 * Centralized keyboard shortcut manager with conflict detection,
 * context-aware shortcuts, input field suppression, and a help overlay.
 *
 * Shortcuts are registered with a key combo string (e.g. "j", "Shift+?",
 * "g b") and a context ("global", "board", "detail"). Multi-key sequences
 * like "g b" use a prefix buffer with a 600ms timeout.
 */

import { escapeHtml } from './format.js';

/** @typedef {'global' | 'board' | 'detail'} ShortcutContext */

/**
 * @typedef {Object} ShortcutDef
 * @property {string} key - Display key combo (e.g. "j", "Shift+?", "g b")
 * @property {string} description - Human-readable description
 * @property {ShortcutContext} context - When this shortcut is active
 * @property {(event: KeyboardEvent) => void} handler - Callback
 */

/**
 * Normalize a KeyboardEvent into a canonical combo string.
 * Modifier order: Ctrl+Alt+Shift+Meta then the key.
 * @param {KeyboardEvent} event
 * @returns {string}
 */
function eventToCombo(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey && event.key !== 'Shift') parts.push('Shift');
  if (event.metaKey) parts.push('Meta');

  let key = event.key;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

/**
 * Parse a registration string into the canonical form.
 * Handles things like "Shift+?" -> "Shift+?" and "j" -> "j".
 * Multi-key sequences like "g b" are split on space.
 * @param {string} raw
 * @returns {string[]} Array of canonical combos forming the sequence
 */
function parseCombo(raw) {
  return raw
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Check whether the current focus target is an editable input.
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
function isTypingTarget(target) {
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return false;
}

/**
 * Create a keyboard shortcut manager.
 *
 * @param {Object} options
 * @param {() => string} options.getActiveView - Returns current view name
 * @returns {Object}
 */
export function createKeyboardManager(options) {
  const { getActiveView } = options;

  /** @type {ShortcutDef[]} */
  const registry = [];

  /** @type {string[]} */
  let prefixBuffer = [];

  /** @type {number | null} */
  let prefixTimer = null;

  /** @type {boolean} */
  let helpVisible = false;

  /** @type {HTMLElement | null} */
  let helpOverlay = null;

  /**
   * Determine the active context based on the current view.
   * @returns {ShortcutContext}
   */
  function activeContext() {
    const view = getActiveView();
    if (view === 'board') return 'board';
    if (view === 'detail') return 'detail';
    return 'global';
  }

  /**
   * Register a keyboard shortcut.
   * @param {string} key - Key combo string
   * @param {string} description - Human-readable description
   * @param {(event: KeyboardEvent) => void} handler
   * @param {Object} [opts]
   * @param {ShortcutContext} [opts.context='global']
   * @returns {void}
   */
  function register(key, description, handler, opts = {}) {
    const context = opts.context || 'global';
    registry.push({ key, description, context, handler });
  }

  /**
   * Detect conflicts: two shortcuts with the same key in the same or
   * overlapping context. Returns an array of conflict descriptions.
   * @returns {string[]}
   */
  function detectConflicts() {
    const seen = new Map();
    const conflicts = [];
    for (const def of registry) {
      const mapKey = `${def.key}|${def.context}`;
      if (seen.has(mapKey)) {
        conflicts.push(
          `Conflict: "${def.key}" in context "${def.context}" — "${seen.get(mapKey)}" vs "${def.description}"`,
        );
      } else {
        seen.set(mapKey, def.description);
      }
    }
    return conflicts;
  }

  /**
   * Clear the prefix buffer used for multi-key sequences.
   */
  function clearPrefix() {
    prefixBuffer = [];
    if (prefixTimer !== null) {
      window.clearTimeout(prefixTimer);
      prefixTimer = null;
    }
  }

  /**
   * Handle a keydown event: resolve against registered shortcuts.
   * @param {KeyboardEvent} event
   */
  function handleKeyDown(event) {
    // Always allow Escape to close help overlay
    if (event.key === 'Escape' && helpVisible) {
      event.preventDefault();
      hideHelp();
      return;
    }

    // Suppress shortcuts when typing in inputs (except Escape)
    if (isTypingTarget(event.target)) {
      return;
    }

    const combo = eventToCombo(event);
    const ctx = activeContext();

    // Build candidate sequence
    prefixBuffer.push(combo);
    const candidateStr = prefixBuffer.join(' ');

    // Find matching shortcut in the current context or global
    const match = registry.find((def) => {
      if (def.context !== 'global' && def.context !== ctx) return false;
      const parsedCombo = parseCombo(def.key).join(' ');
      return parsedCombo === candidateStr;
    });

    if (match) {
      event.preventDefault();
      clearPrefix();
      match.handler(event);
      return;
    }

    // Check if any shortcut starts with the current prefix
    const hasPartial = registry.some((def) => {
      if (def.context !== 'global' && def.context !== ctx) return false;
      const parsedCombo = parseCombo(def.key).join(' ');
      return parsedCombo.startsWith(candidateStr + ' ');
    });

    if (hasPartial) {
      // Wait for next key
      event.preventDefault();
      if (prefixTimer !== null) {
        window.clearTimeout(prefixTimer);
      }
      prefixTimer = window.setTimeout(() => {
        clearPrefix();
      }, 600);
      return;
    }

    // No match and no partial: reset
    clearPrefix();
  }

  /**
   * Build and show the keyboard shortcut help overlay.
   */
  function showHelp() {
    if (helpVisible) {
      hideHelp();
      return;
    }

    helpVisible = true;
    helpOverlay = document.createElement('div');
    helpOverlay.id = 'keyboardHelpOverlay';
    helpOverlay.className = 'keyboard-help-overlay';
    helpOverlay.setAttribute('role', 'dialog');
    helpOverlay.setAttribute('aria-modal', 'true');
    helpOverlay.setAttribute('aria-label', 'Keyboard shortcuts');

    const grouped = { global: [], board: [], detail: [] };
    for (const def of registry) {
      if (grouped[def.context]) {
        grouped[def.context].push(def);
      }
    }

    const sectionHtml = (title, shortcuts) => {
      if (shortcuts.length === 0) return '';
      const rows = shortcuts
        .map(
          (s) =>
            `<tr><td><kbd>${escapeHtml(s.key)}</kbd></td><td>${escapeHtml(s.description)}</td></tr>`,
        )
        .join('');
      return `<div class="keyboard-help-section">
        <h4>${escapeHtml(title)}</h4>
        <table class="keyboard-help-table">${rows}</table>
      </div>`;
    };

    helpOverlay.innerHTML = `
      <div class="keyboard-help-dialog">
        <div class="keyboard-help-header">
          <h3>Keyboard Shortcuts</h3>
          <button class="btn-ghost keyboard-help-close" type="button" aria-label="Close keyboard shortcuts">
            &times;
          </button>
        </div>
        <div class="keyboard-help-body">
          ${sectionHtml('Global', grouped.global)}
          ${sectionHtml('Board View', grouped.board)}
          ${sectionHtml('Detail View', grouped.detail)}
        </div>
      </div>
    `;

    helpOverlay.querySelector('.keyboard-help-close')?.addEventListener('click', () => {
      hideHelp();
    });

    helpOverlay.addEventListener('click', (event) => {
      if (event.target === helpOverlay) {
        hideHelp();
      }
    });

    document.body.appendChild(helpOverlay);

    // Focus trap: focus the close button
    const closeBtn = helpOverlay.querySelector('.keyboard-help-close');
    if (closeBtn instanceof HTMLElement) {
      closeBtn.focus();
    }
  }

  /**
   * Hide the keyboard shortcut help overlay.
   */
  function hideHelp() {
    if (helpOverlay) {
      helpOverlay.remove();
      helpOverlay = null;
    }
    helpVisible = false;
  }

  /**
   * Attach the keydown listener to the document.
   */
  function attach() {
    document.addEventListener('keydown', handleKeyDown);
  }

  /**
   * Detach the keydown listener.
   */
  function detach() {
    document.removeEventListener('keydown', handleKeyDown);
    clearPrefix();
  }

  /**
   * Get all registered shortcuts (for testing or external rendering).
   * @returns {ShortcutDef[]}
   */
  function getRegistry() {
    return [...registry];
  }

  /**
   * Check if help overlay is currently visible.
   * @returns {boolean}
   */
  function isHelpVisible() {
    return helpVisible;
  }

  return {
    register,
    detectConflicts,
    showHelp,
    hideHelp,
    isHelpVisible,
    attach,
    detach,
    getRegistry,
  };
}
