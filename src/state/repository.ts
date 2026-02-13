import { and, asc, count, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';

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

  async listBoardCards(limit: number = 100): Promise<
    Array<{
      runId: string;
      issueNumber: number | null;
      prNumber: number | null;
      status: string;
      currentStage: string;
      updatedAt: string;
      taskCounts: {
        queued: number;
        running: number;
        retry: number;
        completed: number;
        failed: number;
      };
    }>
  > {
    const maxLimit = Math.max(1, Math.min(200, limit));
    const runs = await this.dbClient.db
      .select({
        runId: workflowRuns.id,
        issueNumber: workflowRuns.issueNumber,
        prNumber: workflowRuns.prNumber,
        status: workflowRuns.status,
        currentStage: workflowRuns.currentStage,
        updatedAt: workflowRuns.updatedAt,
      })
      .from(workflowRuns)
      .orderBy(desc(workflowRuns.updatedAt))
      .limit(maxLimit);

    if (runs.length === 0) {
      return [];
    }

    const runIds = runs.map((run) => run.runId);
    const taskCounts = await this.dbClient.db
      .select({
        runId: tasks.workflowRunId,
        status: tasks.status,
        total: count(),
      })
      .from(tasks)
      .where(inArray(tasks.workflowRunId, runIds))
      .groupBy(tasks.workflowRunId, tasks.status);

    const countsByRun = new Map<
      string,
      { queued: number; running: number; retry: number; completed: number; failed: number }
    >();

    for (const row of taskCounts) {
      const current = countsByRun.get(row.runId) ?? {
        queued: 0,
        running: 0,
        retry: 0,
        completed: 0,
        failed: 0,
      };

      const key = row.status as keyof typeof current;
      if (key in current) {
        current[key] += Number(row.total);
      }

      countsByRun.set(row.runId, current);
    }

    return runs.map((run) => ({
      runId: run.runId,
      issueNumber: run.issueNumber,
      prNumber: run.prNumber,
      status: run.status,
      currentStage: run.currentStage,
      updatedAt: run.updatedAt.toISOString(),
      taskCounts: countsByRun.get(run.runId) ?? {
        queued: 0,
        running: 0,
        retry: 0,
        completed: 0,
        failed: 0,
      },
    }));
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

  async listTaskBoardCards() {
    const rows = await this.dbClient.db
      .select({
        taskId: tasks.id,
        workflowRunId: tasks.workflowRunId,
        taskKey: tasks.taskKey,
        title: tasks.title,
        ownerRole: tasks.ownerRole,
        status: tasks.status,
        attemptCount: tasks.attemptCount,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        issueNumber: workflowRuns.issueNumber,
        prNumber: workflowRuns.prNumber,
        currentStage: workflowRuns.currentStage,
      })
      .from(tasks)
      .innerJoin(workflowRuns, eq(tasks.workflowRunId, workflowRuns.id))
      .orderBy(desc(tasks.updatedAt));

    const attemptRows = await this.dbClient.db
      .select({
        id: agentAttempts.id,
        taskId: agentAttempts.taskId,
        status: agentAttempts.status,
      })
      .from(agentAttempts)
      .orderBy(desc(agentAttempts.createdAt));

    const latestAttemptByTask = new Map<string, { id: string; status: string }>();
    for (const attempt of attemptRows) {
      if (!latestAttemptByTask.has(attempt.taskId)) {
        latestAttemptByTask.set(attempt.taskId, { id: attempt.id, status: attempt.status });
      }
    }

    const mergeRows = await this.dbClient.db
      .select({
        workflowRunId: mergeDecisions.workflowRunId,
        decision: mergeDecisions.decision,
      })
      .from(mergeDecisions)
      .orderBy(desc(mergeDecisions.createdAt));

    const latestMergeByRun = new Map<string, string>();
    for (const row of mergeRows) {
      if (!latestMergeByRun.has(row.workflowRunId)) {
        latestMergeByRun.set(row.workflowRunId, row.decision);
      }
    }

    const sourceRows = await this.dbClient.db
      .select({
        workflowRunId: events.workflowRunId,
        sourceOwner: events.sourceOwner,
        sourceRepo: events.sourceRepo,
      })
      .from(events)
      .where(sql`${events.workflowRunId} IS NOT NULL`)
      .orderBy(desc(events.receivedAt));

    const sourceByRun = new Map<string, { sourceOwner: string; sourceRepo: string }>();
    for (const row of sourceRows) {
      if (!row.workflowRunId || sourceByRun.has(row.workflowRunId)) {
        continue;
      }
      sourceByRun.set(row.workflowRunId, {
        sourceOwner: row.sourceOwner,
        sourceRepo: row.sourceRepo,
      });
    }

    return rows.map((row) => ({
      ...(sourceByRun.get(row.workflowRunId) ?? {
        sourceOwner: '',
        sourceRepo: '',
      }),
      id: row.taskId,
      workflowRunId: row.workflowRunId,
      taskKey: row.taskKey,
      title: row.title,
      ownerRole: row.ownerRole,
      status: row.status,
      attemptCount: row.attemptCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      issueNumber: row.issueNumber,
      prNumber: row.prNumber,
      currentStage: row.currentStage,
      latestAttempt: latestAttemptByTask.get(row.taskId) ?? null,
      latestMergeDecision: latestMergeByRun.get(row.workflowRunId) ?? null,
    }));
  }

  async getLatestArtifactByKind(runId: string, kind: string): Promise<{
    id: string;
    kind: string;
    content: string;
    createdAt: Date;
  } | null> {
    const row = await this.dbClient.db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        content: artifacts.content,
        createdAt: artifacts.createdAt,
      })
      .from(artifacts)
      .where(and(eq(artifacts.workflowRunId, runId), eq(artifacts.kind, kind)))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);

    return row[0] ?? null;
  }

  async getTaskDetail(taskId: string) {
    const rows = await this.dbClient.db
      .select({
        taskId: tasks.id,
        workflowRunId: tasks.workflowRunId,
        taskKey: tasks.taskKey,
        title: tasks.title,
        ownerRole: tasks.ownerRole,
        status: tasks.status,
        attemptCount: tasks.attemptCount,
        definitionOfDone: tasks.definitionOfDone,
        dependsOn: tasks.dependsOn,
        lastResult: tasks.lastResult,
        taskCreatedAt: tasks.createdAt,
        taskUpdatedAt: tasks.updatedAt,
        runStatus: workflowRuns.status,
        runStage: workflowRuns.currentStage,
        issueNumber: workflowRuns.issueNumber,
        prNumber: workflowRuns.prNumber,
        specId: workflowRuns.specId,
      })
      .from(tasks)
      .innerJoin(workflowRuns, eq(tasks.workflowRunId, workflowRuns.id))
      .where(eq(tasks.id, taskId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    const sourceRow = await this.dbClient.db
      .select({
        sourceOwner: events.sourceOwner,
        sourceRepo: events.sourceRepo,
      })
      .from(events)
      .where(eq(events.workflowRunId, row.workflowRunId))
      .orderBy(desc(events.receivedAt))
      .limit(1);

    const attemptRows = await this.dbClient.db
      .select({
        id: agentAttempts.id,
        agentRole: agentAttempts.agentRole,
        attemptNumber: agentAttempts.attemptNumber,
        status: agentAttempts.status,
        output: agentAttempts.output,
        error: agentAttempts.error,
        durationMs: agentAttempts.durationMs,
        createdAt: agentAttempts.createdAt,
      })
      .from(agentAttempts)
      .where(eq(agentAttempts.taskId, taskId))
      .orderBy(desc(agentAttempts.createdAt));

    const artifactRows = await this.dbClient.db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        content: artifacts.content,
        metadata: artifacts.metadata,
        createdAt: artifacts.createdAt,
      })
      .from(artifacts)
      .where(or(eq(artifacts.taskId, taskId), eq(artifacts.workflowRunId, row.workflowRunId)))
      .orderBy(desc(artifacts.createdAt));

    const timeline = await this.listTaskTimeline(taskId);

    return {
      cardBase: {
        id: row.taskId,
        workflowRunId: row.workflowRunId,
        taskKey: row.taskKey,
        title: row.title,
        ownerRole: row.ownerRole,
        status: row.status,
        attemptCount: row.attemptCount,
        createdAt: row.taskCreatedAt,
        updatedAt: row.taskUpdatedAt,
        issueNumber: row.issueNumber,
        prNumber: row.prNumber,
        currentStage: row.runStage,
        sourceOwner: sourceRow[0]?.sourceOwner ?? '',
        sourceRepo: sourceRow[0]?.sourceRepo ?? '',
      },
      run: {
        id: row.workflowRunId,
        status: row.runStatus,
        currentStage: row.runStage,
        specId: row.specId,
      },
      task: {
        id: row.taskId,
        taskKey: row.taskKey,
        title: row.title,
        ownerRole: row.ownerRole,
        status: row.status,
        attempts: row.attemptCount,
        definitionOfDone: row.definitionOfDone,
        dependsOn: row.dependsOn,
        lastResult: row.lastResult,
      },
      attempts: attemptRows,
      artifacts: artifactRows,
      timeline,
    };
  }

  async listRecentRuns(limit = 50) {
    const cappedLimit = Math.max(1, Math.min(limit, 200));
    return this.dbClient.db
      .select({
        id: workflowRuns.id,
        status: workflowRuns.status,
        currentStage: workflowRuns.currentStage,
        issueNumber: workflowRuns.issueNumber,
        prNumber: workflowRuns.prNumber,
        createdAt: workflowRuns.createdAt,
        updatedAt: workflowRuns.updatedAt,
      })
      .from(workflowRuns)
      .orderBy(desc(workflowRuns.createdAt))
      .limit(cappedLimit);
  }

  async listRecentTasks(limit = 100) {
    const cappedLimit = Math.max(1, Math.min(limit, 300));
    return this.dbClient.db
      .select({
        id: tasks.id,
        workflowRunId: tasks.workflowRunId,
        taskKey: tasks.taskKey,
        status: tasks.status,
        attempts: tasks.attemptCount,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .orderBy(desc(tasks.createdAt))
      .limit(cappedLimit);
  }

  async listTaskTimeline(taskId: string) {
    const taskRows = await this.dbClient.db
      .select({
        id: tasks.id,
        workflowRunId: tasks.workflowRunId,
        taskKey: tasks.taskKey,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    const taskRow = taskRows[0];
    if (!taskRow) {
      return [];
    }

    const [attemptRows, artifactRows, eventRows, decisionRows] = await Promise.all([
      this.dbClient.db
        .select({
          id: agentAttempts.id,
          agentRole: agentAttempts.agentRole,
          attemptNumber: agentAttempts.attemptNumber,
          status: agentAttempts.status,
          error: agentAttempts.error,
          createdAt: agentAttempts.createdAt,
        })
        .from(agentAttempts)
        .where(eq(agentAttempts.taskId, taskId)),
      this.dbClient.db
        .select({
          id: artifacts.id,
          kind: artifacts.kind,
          metadata: artifacts.metadata,
          createdAt: artifacts.createdAt,
        })
        .from(artifacts)
        .where(or(eq(artifacts.taskId, taskId), eq(artifacts.workflowRunId, taskRow.workflowRunId))),
      this.dbClient.db
        .select({
          id: events.id,
          eventType: events.eventType,
          payload: events.payload,
          createdAt: events.receivedAt,
        })
        .from(events)
        .where(eq(events.workflowRunId, taskRow.workflowRunId)),
      this.dbClient.db
        .select({
          id: mergeDecisions.id,
          decision: mergeDecisions.decision,
          rationale: mergeDecisions.rationale,
          createdAt: mergeDecisions.createdAt,
        })
        .from(mergeDecisions)
        .where(eq(mergeDecisions.workflowRunId, taskRow.workflowRunId)),
    ]);

    const timeline = [
      ...eventRows.map((row) => ({
        event_id: `github:${row.id}`,
        event_type: row.eventType,
        occurred_at: row.createdAt,
        actor: { type: 'system' as const, id: 'github' },
        message: `${row.eventType} received from GitHub`,
        data: row.payload,
      })),
      ...attemptRows.map((row) => ({
        event_id: `attempt:${row.id}`,
        event_type: `attempt.${row.status}`,
        occurred_at: row.createdAt,
        actor: { type: 'system' as const, id: row.agentRole },
        message: `Attempt ${row.attemptNumber} by ${row.agentRole} is ${row.status}`,
        data: { error: row.error ?? null },
      })),
      ...artifactRows.map((row) => {
        const metadata = row.metadata ?? {};
        const actionName = typeof metadata.action === 'string' ? metadata.action : null;
        const actorName = typeof metadata.requested_by === 'string' ? metadata.requested_by : 'system';
        return {
          event_id: `artifact:${row.id}`,
          event_type: row.kind === 'ui_action' ? `action.${actionName ?? 'unknown'}` : `artifact.${row.kind}`,
          occurred_at: row.createdAt,
          actor: {
            type: row.kind === 'ui_action' ? ('user' as const) : ('system' as const),
            id: actorName,
          },
          message:
            row.kind === 'ui_action'
              ? `Action ${actionName ?? 'unknown'} was executed`
              : `Artifact ${row.kind} created`,
          data: metadata,
        };
      }),
      ...decisionRows.map((row) => ({
        event_id: `decision:${row.id}`,
        event_type: 'merge.decision',
        occurred_at: row.createdAt,
        actor: { type: 'system' as const, id: 'reviewer' },
        message: `Merge decision is ${row.decision}`,
        data: { rationale: row.rationale },
      })),
    ];

    timeline.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    return timeline.map((event) => ({
      ...event,
      occurred_at: event.occurred_at.toISOString(),
    }));
  }

  async applyTaskAction(params: {
    taskId: string;
    action: 'retry' | 'retry_attempt' | 'reassign' | 'escalate' | 'block' | 'unblock';
    requestedBy: string;
    reason: string;
    newOwnerRole?: string;
  }) {
    const rows = await this.dbClient.db
      .select({
        id: tasks.id,
        workflowRunId: tasks.workflowRunId,
        status: tasks.status,
        ownerRole: tasks.ownerRole,
      })
      .from(tasks)
      .where(eq(tasks.id, params.taskId))
      .limit(1);

    const existing = rows[0];
    if (!existing) {
      return null;
    }

    let nextStatus = existing.status;
    let nextOwnerRole = existing.ownerRole;

    switch (params.action) {
      case 'retry':
      case 'retry_attempt':
        nextStatus = 'retry';
        break;
      case 'block':
        nextStatus = 'blocked';
        break;
      case 'unblock':
        nextStatus = 'queued';
        break;
      case 'reassign':
        if (params.newOwnerRole) {
          nextOwnerRole = params.newOwnerRole;
        }
        break;
      case 'escalate':
        break;
      default: {
        const unknownAction: never = params.action;
        throw new Error(`Unsupported action: ${unknownAction}`);
      }
    }

    await this.dbClient.db
      .update(tasks)
      .set({
        status: nextStatus,
        ownerRole: nextOwnerRole,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, params.taskId));

    const [artifactRow] = await this.dbClient.db
      .insert(artifacts)
      .values({
        workflowRunId: existing.workflowRunId,
        taskId: existing.id,
        kind: 'ui_action',
        content: params.reason,
        metadata: {
          action: params.action,
          requested_by: params.requestedBy,
          status_before: existing.status,
          status_after: nextStatus,
          owner_before: existing.ownerRole,
          owner_after: nextOwnerRole,
          reason: params.reason,
        },
      })
      .returning({ id: artifacts.id, createdAt: artifacts.createdAt });

    if (!artifactRow) {
      throw new Error('Failed to record action artifact');
    }

    return {
      actionId: artifactRow.id,
      createdAt: artifactRow.createdAt.toISOString(),
      status: nextStatus,
      ownerRole: nextOwnerRole,
    };
  }

  async listRunLogEntries(
    runId: string,
    options: {
      after?: string;
      source?: string;
      taskKey?: string;
      status?: string;
      query?: string;
      limit?: number;
    } = {},
  ): Promise<
    Array<{
      id: string;
      timestamp: string;
      source: 'attempt' | 'artifact';
      taskKey: string | null;
      status: string | null;
      message: string;
      metadata: Record<string, unknown>;
    }>
  > {
    const limit = Math.max(1, Math.min(500, options.limit ?? 200));
    const afterDate = options.after ? new Date(options.after) : null;

    const artifactRows = await this.dbClient.db
      .select({
        id: artifacts.id,
        createdAt: artifacts.createdAt,
        kind: artifacts.kind,
        taskId: artifacts.taskId,
        content: artifacts.content,
        metadata: artifacts.metadata,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workflowRunId, runId),
          afterDate ? gt(artifacts.createdAt, afterDate) : undefined,
        ),
      )
      .orderBy(asc(artifacts.createdAt))
      .limit(limit);

    const attemptRows = await this.dbClient.db
      .select({
        id: agentAttempts.id,
        createdAt: agentAttempts.createdAt,
        taskKey: tasks.taskKey,
        status: agentAttempts.status,
        output: agentAttempts.output,
        error: agentAttempts.error,
        errorCategory: agentAttempts.errorCategory,
      })
      .from(agentAttempts)
      .innerJoin(tasks, eq(tasks.id, agentAttempts.taskId))
      .where(
        and(
          eq(tasks.workflowRunId, runId),
          afterDate ? gt(agentAttempts.createdAt, afterDate) : undefined,
        ),
      )
      .orderBy(asc(agentAttempts.createdAt))
      .limit(limit);

    const entries = [
      ...artifactRows.map((row) => ({
        id: row.id,
        timestamp: row.createdAt.toISOString(),
        source: 'artifact' as const,
        taskKey: row.taskId,
        status: row.kind,
        message: row.content.length > 1200 ? `${row.content.slice(0, 1200)}...` : row.content,
        metadata: row.metadata,
      })),
      ...attemptRows.map((row) => ({
        id: row.id,
        timestamp: row.createdAt.toISOString(),
        source: 'attempt' as const,
        taskKey: row.taskKey,
        status: row.status,
        message: row.error ?? JSON.stringify(row.output ?? {}),
        metadata: {
          errorCategory: row.errorCategory,
        },
      })),
    ]
      .filter((entry) => (options.source ? entry.source === options.source : true))
      .filter((entry) => (options.taskKey ? entry.taskKey === options.taskKey : true))
      .filter((entry) => (options.status ? entry.status === options.status : true))
      .filter((entry) => {
        if (!options.query) {
          return true;
        }
        const q = options.query.toLowerCase();
        const text = `${entry.message} ${entry.taskKey ?? ''} ${entry.status ?? ''}`.toLowerCase();
        return text.includes(q);
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return entries.slice(-limit);
  }
}
