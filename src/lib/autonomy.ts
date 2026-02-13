import { z } from 'zod';

/**
 * Autonomy mode definitions for progressive orchestrator autonomy.
 *
 * Modes (ordered from least to most autonomous):
 *   dry_run              - logging only, no PR creation, no merges, no subtask execution
 *   pr_only              - create PRs but never auto-merge
 *   limited_auto_merge   - auto-merge when all required checks pass AND human approved
 *   full_merge_queue     - auto-merge when required checks pass (no human gate)
 */

export const AutonomyModeSchema = z.enum([
  'dry_run',
  'pr_only',
  'limited_auto_merge',
  'full_merge_queue',
]);

export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

/**
 * Allowed mode transitions. Transitions must move at most one step at a time
 * along the autonomy ladder (either direction), with the exception that any
 * mode may transition to dry_run (emergency stop).
 */
const ALLOWED_TRANSITIONS: Record<AutonomyMode, readonly AutonomyMode[]> = {
  dry_run: ['pr_only'],
  pr_only: ['dry_run', 'limited_auto_merge'],
  limited_auto_merge: ['dry_run', 'pr_only', 'full_merge_queue'],
  full_merge_queue: ['dry_run', 'limited_auto_merge'],
} as const;

export function isValidTransition(from: AutonomyMode, to: AutonomyMode): boolean {
  if (from === to) {
    return false;
  }
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function listAllowedTransitions(from: AutonomyMode): readonly AutonomyMode[] {
  return ALLOWED_TRANSITIONS[from];
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AutonomyTransitionRecord {
  from: AutonomyMode;
  to: AutonomyMode;
  changedBy: string;
  changedAt: string; // ISO-8601
  reason: string;
}

const AutonomyTransitionRecordSchema = z.object({
  from: AutonomyModeSchema,
  to: AutonomyModeSchema,
  changedBy: z.string().min(1),
  changedAt: z.string().datetime(),
  reason: z.string().min(1),
});

export { AutonomyTransitionRecordSchema };

/**
 * In-memory autonomy state holder.
 *
 * The orchestrator creates one instance at startup. The current mode is
 * sourced from config and can be changed at runtime via the admin API.
 * All transitions are recorded in an append-only audit log.
 */
export class AutonomyManager {
  private _mode: AutonomyMode;
  private readonly _history: AutonomyTransitionRecord[] = [];

  constructor(initialMode: AutonomyMode) {
    this._mode = AutonomyModeSchema.parse(initialMode);
  }

  get mode(): AutonomyMode {
    return this._mode;
  }

  get history(): readonly AutonomyTransitionRecord[] {
    return this._history;
  }

  /**
   * Attempt a mode transition. Returns the transition record on success
   * or throws on invalid transition.
   */
  transition(params: { to: AutonomyMode; changedBy: string; reason: string }): AutonomyTransitionRecord {
    const to = AutonomyModeSchema.parse(params.to);
    if (!isValidTransition(this._mode, to)) {
      throw new AutonomyTransitionError(this._mode, to);
    }

    const record: AutonomyTransitionRecord = {
      from: this._mode,
      to,
      changedBy: params.changedBy,
      changedAt: new Date().toISOString(),
      reason: params.reason,
    };

    this._mode = to;
    this._history.push(record);
    return record;
  }
}

export class AutonomyTransitionError extends Error {
  readonly from: AutonomyMode;
  readonly to: AutonomyMode;

  constructor(from: AutonomyMode, to: AutonomyMode) {
    super(
      `Invalid autonomy mode transition from '${from}' to '${to}'. ` +
        `Allowed transitions from '${from}': ${ALLOWED_TRANSITIONS[from].join(', ') || 'none'}`,
    );
    this.name = 'AutonomyTransitionError';
    this.from = from;
    this.to = to;
  }
}
