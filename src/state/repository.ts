import { and, asc, count, desc, eq, lt, sql } from 'drizzle-orm';

import yaml from 'js-yaml';

import { redactSecrets, redactSecretsInText } from '../lib/redaction.js';
import type { AgentResultV1, MergeDecisionV1 } from '../schemas/contracts.js';
import { FormalSpecV1Schema } from '../schemas/contracts.js';
import { InvalidTransitionError, isValidTransition } from '../orchestrator/stages.js';
import type { ErrorCategory } from '../orchestrator/stages.js';
import type { DatabaseClient } from './db.js';
import {
  agentAttempts,
  artifacts,
  events,
  mergeDecisions,
  tasks,
  workflowRuns,
  workflowStageTransitions,
} from './schema.js';

export class WorkflowRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  async recordEventIfNew(params: {
    deliveryId: string;
    eventType: string;
    sourceOwner: string;
    sourceRepo: string;
    payload: Record<string, unknown>;
  }): Promise<{ inserted: boolean; eventId: string }> {
    try {
      const [row] = await this.dbClient.db
        .insert(events)
        .values({
          deliveryId: params.deliveryId,
          eventType: params.eventType,
          sourceOwner: params.sourceOwner,
          sourceRepo: params.sourceRepo,
          payload: redactSecrets(params.payload),
        })
        .returning({ id: events.id });

      if (!row) {
        throw new Error('Failed to insert event row');
      }

      return { inserted: true, eventId: row.id };
    } catch (error) {
      // Postgres unique_violation error code (23505) — more robust than string matching
      const isUniqueViolation =
        error != null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === '23505';

      if (!isUniqueViolation) {
        throw error;
      }

      const existing = await this.dbClient.db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.deliveryId, params.deliveryId))
        .limit(1);

      if (!existing[0]) {
        throw error;
      }

      return { inserted: false, eventId: existing[0].id };
    }
  }

  async createWorkflowRun(params: {
    issueNumber: number | null;
    externalTaskRef: string;
  }): Promise<string> {
    const [row] = await this.dbClient.db
      .insert(workflowRuns)
      .values({
        issueNumber: params.issueNumber,
        status: 'in_progress',
        currentStage: 'TaskRequested',
        externalTaskRef: params.externalTaskRef,
      })
      .returning({ id: workflowRuns.id });

    if (!row) {
      throw new Error('Failed to create workflow run');
    }

    return row.id;
  }

  async linkEventToRun(eventId: string, runId: string): Promise<void> {
    await this.dbClient.db
      .update(events)
      .set({ workflowRunId: runId })
      .where(eq(events.id, eventId));
  }

  async markEventProcessed(eventId: string, error?: string): Promise<void> {
    await this.dbClient.db
      .update(events)
      .set({
        processed: true,
        error: error ? redactSecretsInText(error) : null,
      })
      .where(eq(events.id, eventId));
  }

  async updateRunStage(
    runId: string,
    stage: string,
    transitionMetadata?: Record<string, unknown>,
  ): Promise<void> {
    // Read current stage, validate the transition, then update + record atomically
    const [current] = await this.dbClient.db
      .select({ currentStage: workflowRuns.currentStage })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);

    const fromStage = current?.currentStage ?? 'TaskRequested';

    if (!isValidTransition(fromStage, stage)) {
      throw new InvalidTransitionError(fromStage, stage);
    }

    await this.dbClient.db.transaction(async (tx) => {
      await tx
        .update(workflowRuns)
        .set({ currentStage: stage, updatedAt: sql`now()` })
        .where(eq(workflowRuns.id, runId));

      await tx.insert(workflowStageTransitions).values({
        workflowRunId: runId,
        fromStage,
        toStage: stage,
        metadata: transitionMetadata ?? {},
      });
    });
  }

  async storeSpec(runId: string, specId: string, specYaml: string): Promise<void> {
    // Defense-in-depth: round-trip validate the YAML against FormalSpecV1Schema
    const parsed = yaml.load(specYaml);
    FormalSpecV1Schema.parse(parsed);

    const [current] = await this.dbClient.db
      .select({ currentStage: workflowRuns.currentStage })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);

    const fromStage = current?.currentStage ?? 'TaskRequested';

    if (!isValidTransition(fromStage, 'SpecGenerated')) {
      throw new InvalidTransitionError(fromStage, 'SpecGenerated');
    }

    await this.dbClient.db.transaction(async (tx) => {
      await tx
        .update(workflowRuns)
        .set({
          specId,
          specYaml,
          currentStage: 'SpecGenerated',
          updatedAt: sql`now()`,
        })
        .where(eq(workflowRuns.id, runId));

      await tx.insert(workflowStageTransitions).values({
        workflowRunId: runId,
        fromStage,
        toStage: 'SpecGenerated',
        metadata: { specId },
      });
    });
  }

  async createTasks(
    runId: string,
    items: Array<{
      taskKey: string;
      title: string;
      ownerRole: string;
      definitionOfDone: string[];
      dependsOn: string[];
    }>,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }

    await this.dbClient.db.insert(tasks).values(
      items.map((item) => ({
        workflowRunId: runId,
        taskKey: item.taskKey,
        title: item.title,
        ownerRole: item.ownerRole,
        status: 'queued',
        definitionOfDone: item.definitionOfDone,
        dependsOn: item.dependsOn,
      })),
    );
  }

  async listRunnableTasks(runId: string): Promise<
    Array<{
      id: string;
      taskKey: string;
      title: string;
      ownerRole: string;
      dependsOn: string[];
      attemptCount: number;
    }>
  > {
    const all = await this.dbClient.db
      .select({
        id: tasks.id,
        taskKey: tasks.taskKey,
        title: tasks.title,
        ownerRole: tasks.ownerRole,
        dependsOn: tasks.dependsOn,
        status: tasks.status,
        attemptCount: tasks.attemptCount,
      })
      .from(tasks)
      .where(eq(tasks.workflowRunId, runId))
      .orderBy(asc(tasks.createdAt));

    const completed = new Set(all.filter((row) => row.status === 'completed').map((row) => row.taskKey));

    return all
      .filter((row) => row.status === 'queued' || row.status === 'retry')
      .filter((row) => row.dependsOn.every((dep) => completed.has(dep)))
      .map((row) => ({
        id: row.id,
        taskKey: row.taskKey,
        title: row.title,
        ownerRole: row.ownerRole,
        dependsOn: row.dependsOn,
        attemptCount: row.attemptCount,
      }));
  }

  async markTaskRunning(taskId: string): Promise<void> {
    await this.dbClient.db
      .update(tasks)
      .set({ status: 'running', updatedAt: sql`now()` })
      .where(eq(tasks.id, taskId));
  }

  async markTaskResult(taskId: string, result: AgentResultV1, nextStatus: string): Promise<void> {
    await this.dbClient.db
      .update(tasks)
      .set({
        status: nextStatus,
        attemptCount: sql`${tasks.attemptCount} + 1`,
        lastResult: result as unknown as Record<string, unknown>,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, taskId));
  }

  async addAgentAttempt(params: {
    taskId: string;
    agentRole: string;
    attemptNumber: number;
    status: string;
    output?: Record<string, unknown>;
    error?: string;
    errorCategory?: ErrorCategory;
    backoffDelayMs?: number;
    durationMs?: number;
  }): Promise<void> {
    await this.dbClient.db.insert(agentAttempts).values({
      taskId: params.taskId,
      agentRole: params.agentRole,
      attemptNumber: params.attemptNumber,
      status: params.status,
      output: params.output ? redactSecrets(params.output) : null,
      error: params.error ? redactSecretsInText(params.error) : null,
      errorCategory: params.errorCategory ?? null,
      backoffDelayMs: params.backoffDelayMs ?? null,
      durationMs: params.durationMs ?? null,
    });
  }

  async addArtifact(params: {
    workflowRunId: string;
    taskId?: string;
    kind: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.dbClient.db.insert(artifacts).values({
      workflowRunId: params.workflowRunId,
      taskId: params.taskId ?? null,
      kind: params.kind,
      content: redactSecretsInText(params.content),
      metadata: params.metadata ? redactSecrets(params.metadata) : {},
    });
  }

  async addMergeDecision(
    runId: string,
    prNumber: number | null,
    decision: MergeDecisionV1,
  ): Promise<void> {
    await this.dbClient.db.insert(mergeDecisions).values({
      workflowRunId: runId,
      prNumber,
      decision: decision.decision,
      rationale: redactSecretsInText(decision.rationale),
      blockingFindings: decision.blocking_findings.map((item) => redactSecretsInText(item)),
    });
  }

  async markRunStatus(runId: string, status: 'completed' | 'failed' | 'dead_letter', reason?: string) {
    if (status === 'dead_letter') {
      // Record the transition to DeadLetter stage atomically
      const [current] = await this.dbClient.db
        .select({ currentStage: workflowRuns.currentStage })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .limit(1);

      const fromStage = current?.currentStage ?? 'TaskRequested';

      // Validate transition the same way updateRunStage does
      if (!isValidTransition(fromStage, 'DeadLetter')) {
        throw new InvalidTransitionError(fromStage, 'DeadLetter');
      }

      await this.dbClient.db.transaction(async (tx) => {
        await tx
          .update(workflowRuns)
          .set({
            status,
            currentStage: 'DeadLetter',
            deadLetterReason: reason ?? null,
            updatedAt: sql`now()`,
          })
          .where(eq(workflowRuns.id, runId));

        await tx.insert(workflowStageTransitions).values({
          workflowRunId: runId,
          fromStage,
          toStage: 'DeadLetter',
          metadata: { reason: reason ?? 'unknown' },
        });
      });
    } else {
      await this.dbClient.db
        .update(workflowRuns)
        .set({
          status,
          deadLetterReason: reason ?? null,
          updatedAt: sql`now()`,
        })
        .where(eq(workflowRuns.id, runId));
    }
  }

  async countPendingTasks(runId: string): Promise<number> {
    const [row] = await this.dbClient.db
      .select({ value: count() })
      .from(tasks)
      .where(and(eq(tasks.workflowRunId, runId), sql`${tasks.status} <> 'completed'`));

    return Number(row?.value ?? 0);
  }

  async setRunPrNumber(runId: string, prNumber: number): Promise<void> {
    await this.dbClient.db
      .update(workflowRuns)
      .set({ prNumber, updatedAt: sql`now()` })
      .where(eq(workflowRuns.id, runId));
  }

  async getRunView(runId: string) {
    const run = await this.dbClient.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);

    if (!run[0]) {
      return null;
    }

    const runTasks = await this.dbClient.db
      .select({
        id: tasks.id,
        taskKey: tasks.taskKey,
        status: tasks.status,
        attempts: tasks.attemptCount,
      })
      .from(tasks)
      .where(eq(tasks.workflowRunId, runId))
      .orderBy(asc(tasks.createdAt));

    const runArtifacts = await this.dbClient.db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        createdAt: artifacts.createdAt,
      })
      .from(artifacts)
      .where(eq(artifacts.workflowRunId, runId))
      .orderBy(desc(artifacts.createdAt));

    const transitions = await this.dbClient.db
      .select({
        id: workflowStageTransitions.id,
        fromStage: workflowStageTransitions.fromStage,
        toStage: workflowStageTransitions.toStage,
        transitionedAt: workflowStageTransitions.transitionedAt,
        metadata: workflowStageTransitions.metadata,
      })
      .from(workflowStageTransitions)
      .where(eq(workflowStageTransitions.workflowRunId, runId))
      .orderBy(asc(workflowStageTransitions.transitionedAt));

    return {
      id: run[0].id,
      status: run[0].status,
      currentStage: run[0].currentStage,
      issueNumber: run[0].issueNumber,
      prNumber: run[0].prNumber,
      specId: run[0].specId,
      deadLetterReason: run[0].deadLetterReason,
      createdAt: run[0].createdAt,
      updatedAt: run[0].updatedAt,
      tasks: runTasks,
      artifacts: runArtifacts,
      transitions,
    };
  }

  /**
   * Purge processed delivery records older than the given retention period.
   * Returns the number of rows deleted.
   */
  async purgeStaleDeliveries(retentionDays: number = 30): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await this.dbClient.db
      .delete(events)
      .where(and(eq(events.processed, true), lt(events.receivedAt, cutoff)))
      .returning({ id: events.id });

    return deleted.length;
  }

  async getTaskView(taskId: string) {
    const row = await this.dbClient.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (!row[0]) {
      return null;
    }

    return {
      id: row[0].id,
      workflowRunId: row[0].workflowRunId,
      taskKey: row[0].taskKey,
      status: row[0].status,
      attempts: row[0].attemptCount,
      lastResult: row[0].lastResult,
      createdAt: row[0].createdAt,
      updatedAt: row[0].updatedAt,
    };
  }
}
