import type { Logger } from 'pino';

import type { AutonomyMode } from './autonomy.js';

/**
 * Policy enforcement layer for orchestrator autonomy modes.
 *
 * Each function evaluates whether a given action is permitted under the
 * active autonomy mode. Every decision is logged via the structured logger
 * to ensure full auditability.
 */

export interface PolicyDecision {
  allowed: boolean;
  mode: AutonomyMode;
  action: string;
  reason: string;
}

/**
 * Whether the orchestrator may create a pull request.
 *
 * - dry_run: NOT allowed (logging only)
 * - pr_only / limited_auto_merge / full_merge_queue: allowed
 */
export function canCreatePR(mode: AutonomyMode, logger?: Logger): PolicyDecision {
  const allowed = mode !== 'dry_run';
  const decision: PolicyDecision = {
    allowed,
    mode,
    action: 'create_pr',
    reason: allowed ? 'PR creation permitted under current mode' : 'dry_run mode blocks PR creation',
  };
  logger?.info({ policy: decision }, 'policy decision: canCreatePR');
  return decision;
}

/**
 * Whether the orchestrator may auto-merge a pull request.
 *
 * - dry_run:              NOT allowed
 * - pr_only:              NOT allowed (PRs only, no merge)
 * - limited_auto_merge:   allowed ONLY when checksPass=true AND humanApproval=true
 * - full_merge_queue:     allowed when checksPass=true (no human gate)
 */
export function canAutoMerge(
  mode: AutonomyMode,
  checksPass: boolean,
  humanApproval?: boolean,
  logger?: Logger,
): PolicyDecision {
  let allowed = false;
  let reason: string;

  switch (mode) {
    case 'dry_run':
      reason = 'dry_run mode blocks all merges';
      break;
    case 'pr_only':
      reason = 'pr_only mode blocks auto-merge';
      break;
    case 'limited_auto_merge':
      if (!checksPass) {
        reason = 'required checks have not passed';
      } else if (!humanApproval) {
        reason = 'human approval required but not granted';
      } else {
        allowed = true;
        reason = 'all required checks passed and human approved';
      }
      break;
    case 'full_merge_queue':
      if (!checksPass) {
        reason = 'required checks have not passed';
      } else {
        allowed = true;
        reason = 'all required checks passed (no human gate)';
      }
      break;
  }

  const decision: PolicyDecision = { allowed, mode, action: 'auto_merge', reason };
  logger?.info({ policy: decision }, 'policy decision: canAutoMerge');
  return decision;
}

/**
 * Whether the orchestrator may execute a subtask via an agent.
 *
 * - dry_run: NOT allowed (no real work, logging only)
 * - all other modes: allowed
 */
export function canExecuteSubtask(mode: AutonomyMode, logger?: Logger): PolicyDecision {
  const allowed = mode !== 'dry_run';
  const decision: PolicyDecision = {
    allowed,
    mode,
    action: 'execute_subtask',
    reason: allowed
      ? 'subtask execution permitted under current mode'
      : 'dry_run mode blocks subtask execution',
  };
  logger?.info({ policy: decision }, 'policy decision: canExecuteSubtask');
  return decision;
}
