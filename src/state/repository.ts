import { and, asc, count, desc, eq, sql } from 'drizzle-orm';

import type { AgentResultV1, MergeDecisionV1 } from '../schemas/contracts.js';
import type { DatabaseClient } from './db.js';
import {
  agentAttempts,
  artifacts,
  events,
  mergeDecisions,
  tasks,
  workflowRuns,
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
          payload: params.payload,
        })
        .returning({ id: events.id });

      if (!row) {
        throw new Error('Failed to insert event row');
      }

      return { inserted: true, eventId: row.id };
    } catch (error) {
      const isUniqueViolation =
        error instanceof Error && error.message.toLowerCase().includes('duplicate key');

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
        error: error ?? null,
      })
      .where(eq(events.id, eventId));
  }

  async updateRunStage(runId: string, stage: string): Promise<void> {
    await this.dbClient.db
      .update(workflowRuns)
      .set({
        currentStage: stage,
        updatedAt: sql`now()`,
      })
      .where(eq(workflowRuns.id, runId));
  }

  async storeSpec(runId: string, specId: string, specYaml: string): Promise<void> {
    await this.dbClient.db
      .update(workflowRuns)
      .set({
        specId,
        specYaml,
        currentStage: 'SpecGenerated',
        updatedAt: sql`now()`,
      })
      .where(eq(workflowRuns.id, runId));
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
    durationMs?: number;
  }): Promise<void> {
    await this.dbClient.db.insert(agentAttempts).values({
      taskId: params.taskId,
      agentRole: params.agentRole,
      attemptNumber: params.attemptNumber,
      status: params.status,
      output: params.output ?? null,
      error: params.error ?? null,
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
      content: params.content,
      metadata: params.metadata ?? {},
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
      rationale: decision.rationale,
      blockingFindings: decision.blocking_findings,
    });
  }

  async markRunStatus(runId: string, status: 'completed' | 'failed' | 'dead_letter', reason?: string) {
    await this.dbClient.db
      .update(workflowRuns)
      .set({
        status,
        deadLetterReason: reason ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(workflowRuns.id, runId));
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

    return {
      id: run[0].id,
      status: run[0].status,
      currentStage: run[0].currentStage,
      issueNumber: run[0].issueNumber,
      prNumber: run[0].prNumber,
      specId: run[0].specId,
      createdAt: run[0].createdAt,
      updatedAt: run[0].updatedAt,
      tasks: runTasks,
      artifacts: runArtifacts,
    };
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
