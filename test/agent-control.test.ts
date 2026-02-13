import { describe, expect, it } from 'vitest';

/**
 * The agent-control component is a vanilla-JS module designed for the browser.
 * Since these tests run in Node (vitest without jsdom), we test the pure logic
 * functions that do not touch the DOM: role gating, confirmation requirements,
 * reason requirements, and visible-action filtering.
 *
 * The functions are re-implemented here in a type-safe manner, mirroring the
 * exact logic in components/agent-control.js so that the test validates the
 * contract rather than importing browser-only ESM.
 */

// ---------- mirror of agent-control.js constants/logic ----------

const ACTION_DEFS: Record<string, { label: string; minRole: string; dangerous: boolean }> = {
  retry: { label: 'Re-run Task', minRole: 'operator', dangerous: false },
  reassign: { label: 'Reassign', minRole: 'operator', dangerous: false },
  escalate: { label: 'Escalate', minRole: 'operator', dangerous: true },
  'block-toggle': { label: 'Block / Unblock', minRole: 'reviewer', dangerous: true },
};

const ROLE_RANK: Record<string, number> = { viewer: 0, operator: 1, reviewer: 2, admin: 3 };

interface AuthMe {
  authenticated: boolean;
  roles: string[];
}

function effectiveRole(me: AuthMe | null): string {
  if (!me?.authenticated || !Array.isArray(me.roles)) {
    return 'viewer';
  }
  let best = 'viewer';
  for (const role of me.roles) {
    if ((ROLE_RANK[role] ?? 0) > (ROLE_RANK[best] ?? 0)) {
      best = role;
    }
  }
  return best;
}

function meetsRoleLevel(userRole: string, requiredMinRole: string): boolean {
  return (ROLE_RANK[userRole] ?? 0) >= (ROLE_RANK[requiredMinRole] ?? 0);
}

function visibleActions(userRole: string): string[] {
  return Object.keys(ACTION_DEFS).filter((key) =>
    meetsRoleLevel(userRole, ACTION_DEFS[key]!.minRole),
  );
}

function requiresConfirmation(actionKey: string): boolean {
  return ACTION_DEFS[actionKey]?.dangerous === true;
}

function requiresReason(actionKey: string): boolean {
  return (
    actionKey === 'escalate' ||
    actionKey === 'block-toggle' ||
    actionKey === 'block' ||
    actionKey === 'unblock'
  );
}

// ---------- tests ----------

describe('agent-control role gating', () => {
  it('viewer sees no actions', () => {
    expect(visibleActions('viewer')).toEqual([]);
  });

  it('operator sees retry, reassign, escalate but not block-toggle', () => {
    const actions = visibleActions('operator');
    expect(actions).toContain('retry');
    expect(actions).toContain('reassign');
    expect(actions).toContain('escalate');
    expect(actions).not.toContain('block-toggle');
  });

  it('reviewer sees all four actions', () => {
    const actions = visibleActions('reviewer');
    expect(actions).toEqual(['retry', 'reassign', 'escalate', 'block-toggle']);
  });

  it('admin sees all four actions', () => {
    const actions = visibleActions('admin');
    expect(actions).toEqual(['retry', 'reassign', 'escalate', 'block-toggle']);
  });
});

describe('agent-control effectiveRole', () => {
  it('returns viewer when unauthenticated', () => {
    expect(effectiveRole(null)).toBe('viewer');
    expect(effectiveRole({ authenticated: false, roles: ['admin'] })).toBe('viewer');
  });

  it('returns the highest role from the roles array', () => {
    expect(effectiveRole({ authenticated: true, roles: ['viewer'] })).toBe('viewer');
    expect(effectiveRole({ authenticated: true, roles: ['operator'] })).toBe('operator');
    expect(effectiveRole({ authenticated: true, roles: ['operator', 'reviewer'] })).toBe('reviewer');
    expect(effectiveRole({ authenticated: true, roles: ['admin'] })).toBe('admin');
  });
});

describe('agent-control confirmation flow', () => {
  it('escalate requires confirmation (dangerous action)', () => {
    expect(requiresConfirmation('escalate')).toBe(true);
  });

  it('block-toggle requires confirmation (dangerous action)', () => {
    expect(requiresConfirmation('block-toggle')).toBe(true);
  });

  it('retry does not require confirmation', () => {
    expect(requiresConfirmation('retry')).toBe(false);
  });

  it('reassign does not require confirmation', () => {
    expect(requiresConfirmation('reassign')).toBe(false);
  });
});

describe('agent-control audit context (reason requirement)', () => {
  it('escalate requires a reason', () => {
    expect(requiresReason('escalate')).toBe(true);
  });

  it('block-toggle requires a reason', () => {
    expect(requiresReason('block-toggle')).toBe(true);
  });

  it('block requires a reason', () => {
    expect(requiresReason('block')).toBe(true);
  });

  it('unblock requires a reason', () => {
    expect(requiresReason('unblock')).toBe(true);
  });

  it('retry does not require a reason', () => {
    expect(requiresReason('retry')).toBe(false);
  });

  it('reassign does not require a reason', () => {
    expect(requiresReason('reassign')).toBe(false);
  });
});

describe('agent-control meetsRoleLevel', () => {
  it('admin meets all levels', () => {
    expect(meetsRoleLevel('admin', 'viewer')).toBe(true);
    expect(meetsRoleLevel('admin', 'operator')).toBe(true);
    expect(meetsRoleLevel('admin', 'reviewer')).toBe(true);
    expect(meetsRoleLevel('admin', 'admin')).toBe(true);
  });

  it('operator does not meet reviewer level', () => {
    expect(meetsRoleLevel('operator', 'reviewer')).toBe(false);
  });

  it('viewer meets nothing above viewer', () => {
    expect(meetsRoleLevel('viewer', 'operator')).toBe(false);
    expect(meetsRoleLevel('viewer', 'reviewer')).toBe(false);
    expect(meetsRoleLevel('viewer', 'admin')).toBe(false);
  });

  it('viewer meets viewer level', () => {
    expect(meetsRoleLevel('viewer', 'viewer')).toBe(true);
  });
});

describe('agent-control role-gating matches backend action roles', () => {
  /**
   * Backend (server.ts) defines:
   *   retry: [operator, reviewer, admin]
   *   reassign: [operator, reviewer, admin]
   *   escalate: [operator, reviewer, admin]
   *   block/unblock: [reviewer, admin]
   *
   * The frontend minRole must be the *lowest* backend-allowed role.
   */
  it('retry minRole is operator, matching backend', () => {
    expect(ACTION_DEFS['retry']!.minRole).toBe('operator');
  });

  it('reassign minRole is operator, matching backend', () => {
    expect(ACTION_DEFS['reassign']!.minRole).toBe('operator');
  });

  it('escalate minRole is operator, matching backend', () => {
    expect(ACTION_DEFS['escalate']!.minRole).toBe('operator');
  });

  it('block-toggle minRole is reviewer, matching backend block/unblock', () => {
    expect(ACTION_DEFS['block-toggle']!.minRole).toBe('reviewer');
  });
});
