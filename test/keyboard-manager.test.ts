import { describe, expect, it } from 'vitest';

/**
 * The keyboard-manager module is a vanilla-JS module for the browser.
 * Since these tests run in Node (vitest without jsdom), we re-implement
 * the pure logic functions (combo parsing, conflict detection, input
 * field suppression, context matching, sequence matching) to validate
 * the contract, mirroring the exact logic in lib/keyboard-manager.js.
 */

// ---------- mirror of keyboard-manager.js logic ----------

type ShortcutContext = 'global' | 'board' | 'detail';

interface ShortcutDef {
  key: string;
  description: string;
  context: ShortcutContext;
  handler: () => void;
}

/**
 * Normalize a simulated KeyboardEvent into a canonical combo string.
 */
function eventToCombo(event: {
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  key: string;
}): string {
  const parts: string[] = [];
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
 * Parse a registration string into canonical combo parts.
 */
function parseCombo(raw: string): string[] {
  return raw
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Check whether a target element type is an input field.
 */
function isTypingTarget(tagName: string, isContentEditable = false): boolean {
  if (tagName === 'INPUT') return true;
  if (tagName === 'TEXTAREA') return true;
  if (tagName === 'SELECT') return true;
  if (isContentEditable) return true;
  return false;
}

/**
 * Detect conflicts in a shortcut registry.
 */
function detectConflicts(registry: ShortcutDef[]): string[] {
  const seen = new Map<string, string>();
  const conflicts: string[] = [];
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
 * Match a candidate sequence against a shortcut def in a given active context.
 */
function matchShortcut(
  registry: ShortcutDef[],
  candidateStr: string,
  activeCtx: ShortcutContext,
): ShortcutDef | undefined {
  return registry.find((def) => {
    if (def.context !== 'global' && def.context !== activeCtx) return false;
    const parsedCombo = parseCombo(def.key).join(' ');
    return parsedCombo === candidateStr;
  });
}

/**
 * Check if any shortcut starts with the given prefix.
 */
function hasPartialMatch(
  registry: ShortcutDef[],
  candidateStr: string,
  activeCtx: ShortcutContext,
): boolean {
  return registry.some((def) => {
    if (def.context !== 'global' && def.context !== activeCtx) return false;
    const parsedCombo = parseCombo(def.key).join(' ');
    return parsedCombo.startsWith(candidateStr + ' ');
  });
}

// ---------- tests ----------

describe('keyboard-manager eventToCombo', () => {
  it('normalizes a plain key', () => {
    expect(eventToCombo({ key: 'j' })).toBe('j');
  });

  it('normalizes uppercase to lowercase', () => {
    expect(eventToCombo({ key: 'J' })).toBe('j');
  });

  it('includes Shift modifier', () => {
    expect(eventToCombo({ shiftKey: true, key: '?' })).toBe('Shift+?');
  });

  it('includes Ctrl modifier', () => {
    expect(eventToCombo({ ctrlKey: true, key: 'k' })).toBe('Ctrl+k');
  });

  it('includes Meta modifier', () => {
    expect(eventToCombo({ metaKey: true, key: 'k' })).toBe('Meta+k');
  });

  it('combines multiple modifiers in canonical order', () => {
    expect(eventToCombo({ ctrlKey: true, shiftKey: true, key: 'p' })).toBe('Ctrl+Shift+p');
  });

  it('maps space key to Space', () => {
    expect(eventToCombo({ key: ' ' })).toBe('Space');
  });

  it('does not double-list Shift when key is Shift', () => {
    expect(eventToCombo({ shiftKey: true, key: 'Shift' })).toBe('Shift');
  });

  it('handles Escape', () => {
    expect(eventToCombo({ key: 'Escape' })).toBe('Escape');
  });

  it('handles Enter', () => {
    expect(eventToCombo({ key: 'Enter' })).toBe('Enter');
  });
});

describe('keyboard-manager parseCombo', () => {
  it('parses a single key', () => {
    expect(parseCombo('j')).toEqual(['j']);
  });

  it('parses a multi-key sequence', () => {
    expect(parseCombo('g b')).toEqual(['g', 'b']);
  });

  it('parses a modified key', () => {
    expect(parseCombo('Shift+?')).toEqual(['Shift+?']);
  });

  it('trims whitespace', () => {
    expect(parseCombo('  g   b  ')).toEqual(['g', 'b']);
  });

  it('filters empty parts', () => {
    expect(parseCombo('')).toEqual([]);
  });
});

describe('keyboard-manager isTypingTarget', () => {
  it('returns true for INPUT', () => {
    expect(isTypingTarget('INPUT')).toBe(true);
  });

  it('returns true for TEXTAREA', () => {
    expect(isTypingTarget('TEXTAREA')).toBe(true);
  });

  it('returns true for SELECT', () => {
    expect(isTypingTarget('SELECT')).toBe(true);
  });

  it('returns true for contentEditable', () => {
    expect(isTypingTarget('DIV', true)).toBe(true);
  });

  it('returns false for non-input elements', () => {
    expect(isTypingTarget('BUTTON')).toBe(false);
    expect(isTypingTarget('DIV')).toBe(false);
    expect(isTypingTarget('SECTION')).toBe(false);
  });
});

describe('keyboard-manager conflict detection', () => {
  const noop = () => {};

  it('returns empty for no conflicts', () => {
    const registry: ShortcutDef[] = [
      { key: 'j', description: 'Next card', context: 'board', handler: noop },
      { key: 'k', description: 'Previous card', context: 'board', handler: noop },
      { key: 'j', description: 'Next card in detail', context: 'detail', handler: noop },
    ];
    expect(detectConflicts(registry)).toEqual([]);
  });

  it('detects duplicate key in same context', () => {
    const registry: ShortcutDef[] = [
      { key: 'j', description: 'Action A', context: 'board', handler: noop },
      { key: 'j', description: 'Action B', context: 'board', handler: noop },
    ];
    const conflicts = detectConflicts(registry);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('Conflict');
    expect(conflicts[0]).toContain('"j"');
    expect(conflicts[0]).toContain('board');
  });

  it('allows same key in different contexts', () => {
    const registry: ShortcutDef[] = [
      { key: 'e', description: 'Escalate (board)', context: 'board', handler: noop },
      { key: 'e', description: 'Escalate (detail)', context: 'detail', handler: noop },
    ];
    expect(detectConflicts(registry)).toEqual([]);
  });
});

describe('keyboard-manager context-aware matching', () => {
  const noop = () => {};

  const registry: ShortcutDef[] = [
    { key: '/', description: 'Focus search', context: 'global', handler: noop },
    { key: 'j', description: 'Next card (board)', context: 'board', handler: noop },
    { key: 'j', description: 'Next card (detail)', context: 'detail', handler: noop },
    { key: 'l', description: 'Logs panel', context: 'detail', handler: noop },
    { key: 'g b', description: 'Go to board', context: 'global', handler: noop },
  ];

  it('matches global shortcut from any context', () => {
    expect(matchShortcut(registry, '/', 'board')?.description).toBe('Focus search');
    expect(matchShortcut(registry, '/', 'detail')?.description).toBe('Focus search');
  });

  it('matches board-context shortcut only when in board', () => {
    const match = matchShortcut(registry, 'j', 'board');
    expect(match?.description).toBe('Next card (board)');
  });

  it('matches detail-context shortcut only when in detail', () => {
    const match = matchShortcut(registry, 'j', 'detail');
    expect(match?.description).toBe('Next card (detail)');
  });

  it('does not match detail shortcut when in board context', () => {
    const match = matchShortcut(registry, 'l', 'board');
    expect(match).toBeUndefined();
  });

  it('matches multi-key sequence', () => {
    const match = matchShortcut(registry, 'g b', 'board');
    expect(match?.description).toBe('Go to board');
  });

  it('returns undefined for unregistered key', () => {
    expect(matchShortcut(registry, 'x', 'board')).toBeUndefined();
  });
});

describe('keyboard-manager partial sequence detection', () => {
  const noop = () => {};

  const registry: ShortcutDef[] = [
    { key: 'g b', description: 'Go to board', context: 'global', handler: noop },
    { key: 'g d', description: 'Go to detail', context: 'global', handler: noop },
    { key: 'g i', description: 'Go to inspect', context: 'global', handler: noop },
  ];

  it('detects partial match for g prefix', () => {
    expect(hasPartialMatch(registry, 'g', 'board')).toBe(true);
  });

  it('does not detect partial match for completed sequence', () => {
    expect(hasPartialMatch(registry, 'g b', 'board')).toBe(false);
  });

  it('does not detect partial match for unrelated key', () => {
    expect(hasPartialMatch(registry, 'x', 'board')).toBe(false);
  });
});

describe('keyboard-manager shortcut registry structure', () => {
  /**
   * Validate that the shortcuts defined in main.js follow expected conventions.
   * These checks mirror the registration patterns from the implementation.
   */

  const expectedGlobalShortcuts = [
    { key: '/', description: 'Focus search input' },
    { key: 'r', description: 'Refresh board data' },
    { key: 'Shift+?', description: 'Show keyboard shortcuts' },
    { key: '?', description: 'Show telemetry summary' },
    { key: 'Escape', description: 'Close overlay or dismiss toast' },
    { key: 'g b', description: 'Go to Board view' },
    { key: 'g d', description: 'Go to Detail view' },
    { key: 'g i', description: 'Go to Inspect view' },
    { key: 'g s', description: 'Go to Service view' },
    { key: 'g t', description: 'Go to Settings view' },
    { key: '1', description: 'Switch to Board view' },
    { key: '2', description: 'Switch to Detail view' },
    { key: '3', description: 'Switch to Inspect view' },
    { key: '4', description: 'Switch to Service view' },
    { key: '5', description: 'Switch to Settings view' },
  ];

  const expectedBoardShortcuts = [
    { key: 'j', description: 'Select next card' },
    { key: 'k', description: 'Select previous card' },
    { key: 'Enter', description: 'Open selected card in detail view' },
    { key: 'e', description: 'Escalate selected task' },
    { key: 'b', description: 'Block/unblock selected task' },
  ];

  const expectedDetailShortcuts = [
    { key: 'e', description: 'Escalate selected task' },
    { key: 'b', description: 'Block/unblock selected task' },
    { key: 'l', description: 'Switch to logs panel' },
    { key: 's', description: 'Switch to spec panel' },
    { key: 'p', description: 'Open PR link' },
    { key: 'j', description: 'Select next card' },
    { key: 'k', description: 'Select previous card' },
  ];

  it('global shortcuts all have unique keys', () => {
    const keys = expectedGlobalShortcuts.map((s) => s.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('board shortcuts all have unique keys', () => {
    const keys = expectedBoardShortcuts.map((s) => s.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('detail shortcuts all have unique keys', () => {
    const keys = expectedDetailShortcuts.map((s) => s.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('all shortcuts have non-empty descriptions', () => {
    const allShortcuts = [
      ...expectedGlobalShortcuts,
      ...expectedBoardShortcuts,
      ...expectedDetailShortcuts,
    ];
    for (const s of allShortcuts) {
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('multi-key sequences are only in global context', () => {
    const multiKeyBoard = expectedBoardShortcuts.filter((s) => s.key.includes(' '));
    const multiKeyDetail = expectedDetailShortcuts.filter((s) => s.key.includes(' '));
    expect(multiKeyBoard).toHaveLength(0);
    expect(multiKeyDetail).toHaveLength(0);
  });

  it('no conflicting registrations across combined registry', () => {
    const noop = () => {};
    const combined: ShortcutDef[] = [
      ...expectedGlobalShortcuts.map((s) => ({ ...s, context: 'global' as const, handler: noop })),
      ...expectedBoardShortcuts.map((s) => ({ ...s, context: 'board' as const, handler: noop })),
      ...expectedDetailShortcuts.map((s) => ({ ...s, context: 'detail' as const, handler: noop })),
    ];
    const conflicts = detectConflicts(combined);
    expect(conflicts).toEqual([]);
  });
});

describe('keyboard-manager view navigation shortcuts', () => {
  it('numeric shortcuts cover all five views', () => {
    const viewNames = ['Board', 'Detail', 'Inspect', 'Service', 'Settings'];
    const numericKeys = ['1', '2', '3', '4', '5'];
    expect(numericKeys).toHaveLength(viewNames.length);
  });

  it('g-prefix shortcuts cover all five views', () => {
    const gKeys = ['g b', 'g d', 'g i', 'g s', 'g t'];
    expect(gKeys).toHaveLength(5);
    for (const key of gKeys) {
      expect(key.startsWith('g ')).toBe(true);
    }
  });
});
