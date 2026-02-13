import { escapeHtml } from '../lib/format.js';

/**
 * Action metadata: labels, CSS classes, required minimum role, and whether
 * the action is considered "dangerous" (requires confirmation + reason).
 */
const ACTION_DEFS = {
  retry: {
    label: 'Re-run Task',
    minRole: 'operator',
    dangerous: false,
    btnClass: 'btn-ghost',
  },
  reassign: {
    label: 'Reassign',
    minRole: 'operator',
    dangerous: false,
    btnClass: 'btn-ghost',
  },
  escalate: {
    label: 'Escalate',
    minRole: 'operator',
    dangerous: true,
    btnClass: 'btn-danger',
  },
  'block-toggle': {
    label: 'Block / Unblock',
    minRole: 'reviewer',
    dangerous: true,
    btnClass: 'btn-danger',
  },
};

const ROLE_RANK = { viewer: 0, operator: 1, reviewer: 2, admin: 3 };

const ROLE_BADGE_CLASS = {
  operator: 'role-badge-operator',
  reviewer: 'role-badge-reviewer',
  admin: 'role-badge-admin',
};

/**
 * Determine the effective user role from the auth context (`me`).
 * Returns the highest role the user possesses.
 */
export function effectiveRole(me) {
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

/**
 * Check whether a role string meets the minimum required level.
 */
export function meetsRoleLevel(userRole, requiredMinRole) {
  return (ROLE_RANK[userRole] ?? 0) >= (ROLE_RANK[requiredMinRole] ?? 0);
}

/**
 * Return the subset of action keys that `userRole` is allowed to see.
 */
export function visibleActions(userRole) {
  return Object.keys(ACTION_DEFS).filter((key) =>
    meetsRoleLevel(userRole, ACTION_DEFS[key].minRole),
  );
}

/**
 * Check whether the given action requires a confirmation dialog.
 */
export function requiresConfirmation(actionKey) {
  return ACTION_DEFS[actionKey]?.dangerous === true;
}

/**
 * Check whether the given action requires a reason (audit context).
 * Block, unblock, and escalate always require a reason.
 */
export function requiresReason(actionKey) {
  return actionKey === 'escalate' || actionKey === 'block-toggle' || actionKey === 'block' || actionKey === 'unblock';
}

/**
 * Render the agent-control panel HTML into a container element.
 *
 * @param {HTMLElement} container - Target DOM node (replaces innerHTML).
 * @param {object} options
 * @param {object} options.me - Auth context from /api/v1/auth/me.
 * @param {object|null} options.detail - Current task detail (null if none).
 * @param {function} options.onAction - Callback: (actionKey, payload) => Promise.
 */
export function renderAgentControl(container, options) {
  const { me, detail } = options;
  const role = effectiveRole(me);
  const actions = visibleActions(role);

  if (actions.length === 0 || !detail) {
    container.innerHTML = '';
    return;
  }

  const badgeClass = ROLE_BADGE_CLASS[role] || '';
  const roleBadge = `<span class="pill role-badge ${badgeClass}">${escapeHtml(role)}</span>`;

  const buttons = actions
    .map((key) => {
      const def = ACTION_DEFS[key];
      const dangerAttr = def.dangerous ? 'data-dangerous="true"' : '';
      return `<button type="button" class="${def.btnClass} agent-action-btn" data-agent-action="${key}" ${dangerAttr}>${escapeHtml(def.label)}</button>`;
    })
    .join('');

  container.innerHTML = `
    <div class="agent-control-panel">
      <div class="agent-control-header">
        <span class="agent-control-label">Actions</span>
        ${roleBadge}
      </div>
      <div class="action-grid">${buttons}</div>
      <div class="agent-control-confirm" hidden></div>
      <div class="agent-control-status" hidden></div>
    </div>
  `;

  const confirmRegion = container.querySelector('.agent-control-confirm');
  const statusRegion = container.querySelector('.agent-control-status');

  container.querySelectorAll('[data-agent-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const actionKey = button.getAttribute('data-agent-action');
      if (!actionKey) return;
      handleActionClick(actionKey, confirmRegion, statusRegion, options);
    });
  });
}

/**
 * Handle a click on an action button. If the action is dangerous, show the
 * confirmation dialog; otherwise execute immediately (with optional reason).
 */
function handleActionClick(actionKey, confirmRegion, statusRegion, options) {
  if (requiresConfirmation(actionKey)) {
    showConfirmDialog(actionKey, confirmRegion, statusRegion, options);
  } else {
    executeAction(actionKey, null, confirmRegion, statusRegion, options);
  }
}

/**
 * Show an inline confirmation dialog for dangerous actions.
 */
function showConfirmDialog(actionKey, confirmRegion, statusRegion, options) {
  const def = ACTION_DEFS[actionKey];
  const needsReason = requiresReason(actionKey);

  confirmRegion.hidden = false;
  confirmRegion.innerHTML = `
    <div class="confirm-dialog">
      <p class="confirm-message">Confirm <strong>${escapeHtml(def?.label ?? actionKey)}</strong> on this task?</p>
      ${
        needsReason
          ? `<label class="confirm-reason-label">
               Reason <span class="confirm-required">(required)</span>
               <textarea class="confirm-reason" rows="2" placeholder="Provide audit context for this action"></textarea>
             </label>`
          : ''
      }
      <div class="confirm-actions">
        <button type="button" class="btn-danger confirm-yes">Confirm ${escapeHtml(def?.label ?? actionKey)}</button>
        <button type="button" class="btn-ghost confirm-cancel">Cancel</button>
      </div>
    </div>
  `;

  const cancelBtn = confirmRegion.querySelector('.confirm-cancel');
  const confirmBtn = confirmRegion.querySelector('.confirm-yes');
  const reasonInput = confirmRegion.querySelector('.confirm-reason');

  cancelBtn.addEventListener('click', () => {
    confirmRegion.hidden = true;
    confirmRegion.innerHTML = '';
  });

  confirmBtn.addEventListener('click', () => {
    const reason = reasonInput ? reasonInput.value.trim() : null;
    if (needsReason && !reason) {
      reasonInput.classList.add('confirm-reason-error');
      reasonInput.focus();
      return;
    }
    confirmRegion.hidden = true;
    confirmRegion.innerHTML = '';
    executeAction(actionKey, reason, confirmRegion, statusRegion, options);
  });
}

/**
 * Execute the action via the provided callback, showing status feedback.
 */
async function executeAction(actionKey, reason, confirmRegion, statusRegion, options) {
  const { onAction } = options;
  if (!onAction) return;

  statusRegion.hidden = false;
  statusRegion.innerHTML = '<span class="agent-status-pending">Processing&hellip;</span>';

  try {
    await onAction(actionKey, reason ? { reason } : undefined);
    statusRegion.innerHTML = '<span class="agent-status-ok">Action completed</span>';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statusRegion.innerHTML = `<span class="agent-status-error">Failed: ${escapeHtml(message)}</span>`;
  }

  setTimeout(() => {
    statusRegion.hidden = true;
    statusRegion.innerHTML = '';
  }, 4000);
}
