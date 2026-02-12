/**
 * Workflow stage definitions and valid transition map.
 *
 * The orchestrator progresses a workflow run through these stages
 * in a deterministic order. The VALID_TRANSITIONS map enforces that
 * only forward-moving stage changes are allowed — e.g. a run in
 * 'MergeDecision' cannot regress to 'TaskRequested'.
 *
 * 'DeadLetter' is reachable from any stage (a run can fail at any point).
 */

export const WORKFLOW_STAGES = [
  'TaskRequested',
  'SpecGenerated',
  'SubtasksDispatched',
  'PRReviewed',
  'MergeDecision',
  'DeadLetter',
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

/** Map of stage → set of stages it may transition to. */
export const VALID_TRANSITIONS: Record<WorkflowStage, ReadonlySet<WorkflowStage>> = {
  TaskRequested: new Set<WorkflowStage>(['SpecGenerated', 'DeadLetter']),
  SpecGenerated: new Set<WorkflowStage>(['SubtasksDispatched', 'DeadLetter']),
  SubtasksDispatched: new Set<WorkflowStage>(['PRReviewed', 'DeadLetter']),
  PRReviewed: new Set<WorkflowStage>(['MergeDecision', 'DeadLetter']),
  MergeDecision: new Set<WorkflowStage>(['DeadLetter']),
  DeadLetter: new Set<WorkflowStage>([]),
};

export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from as WorkflowStage];
  if (!allowed) {
    return false;
  }
  return allowed.has(to as WorkflowStage);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly fromStage: string,
    public readonly toStage: string,
  ) {
    super(`Invalid stage transition: ${fromStage} → ${toStage}`);
    this.name = 'InvalidTransitionError';
  }
}

/** Error category for retry classification */
export type ErrorCategory = 'transient' | 'deterministic' | 'unknown';

export function classifyError(error: unknown): ErrorCategory {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Network / timeout / rate-limit errors are transient
    if (
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('socket hang up')
    ) {
      return 'transient';
    }
    // Validation / auth / not-found errors are deterministic
    if (
      msg.includes('validation') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('not found') ||
      msg.includes('400') ||
      msg.includes('401') ||
      msg.includes('403') ||
      msg.includes('404')
    ) {
      return 'deterministic';
    }
  }
  return 'unknown';
}
