import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const workflowRuns = pgTable('workflow_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  externalTaskRef: varchar('external_task_ref', { length: 255 }),
  issueNumber: integer('issue_number'),
  prNumber: integer('pr_number'),
  status: varchar('status', { length: 64 }).notNull().default('pending'),
  currentStage: varchar('current_stage', { length: 128 }).notNull().default('TaskRequested'),
  specId: varchar('spec_id', { length: 255 }),
  specYaml: text('spec_yaml'),
  deadLetterReason: text('dead_letter_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable('events', {
  id: uuid('id').defaultRandom().primaryKey(),
  deliveryId: varchar('delivery_id', { length: 255 }).notNull().unique(),
  eventType: varchar('event_type', { length: 128 }).notNull(),
  sourceOwner: varchar('source_owner', { length: 255 }).notNull(),
  sourceRepo: varchar('source_repo', { length: 255 }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  workflowRunId: uuid('workflow_run_id').references(() => workflowRuns.id),
  processed: boolean('processed').notNull().default(false),
  error: text('error'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  workflowRunId: uuid('workflow_run_id')
    .notNull()
    .references(() => workflowRuns.id),
  taskKey: varchar('task_key', { length: 255 }).notNull(),
  title: text('title').notNull(),
  ownerRole: varchar('owner_role', { length: 128 }).notNull(),
  status: varchar('status', { length: 64 }).notNull().default('queued'),
  attemptCount: integer('attempt_count').notNull().default(0),
  definitionOfDone: jsonb('definition_of_done').$type<string[]>().notNull().default([]),
  dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
  lastResult: jsonb('last_result').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentAttempts = pgTable('agent_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id),
  agentRole: varchar('agent_role', { length: 128 }).notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  status: varchar('status', { length: 64 }).notNull(),
  output: jsonb('output').$type<Record<string, unknown> | null>(),
  error: text('error'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const artifacts = pgTable('artifacts', {
  id: uuid('id').defaultRandom().primaryKey(),
  workflowRunId: uuid('workflow_run_id')
    .notNull()
    .references(() => workflowRuns.id),
  taskId: uuid('task_id').references(() => tasks.id),
  kind: varchar('kind', { length: 64 }).notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mergeDecisions = pgTable('merge_decisions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workflowRunId: uuid('workflow_run_id')
    .notNull()
    .references(() => workflowRuns.id),
  prNumber: integer('pr_number'),
  decision: varchar('decision', { length: 64 }).notNull(),
  rationale: text('rationale').notNull(),
  blockingFindings: jsonb('blocking_findings').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflowRunRelations = relations(workflowRuns, ({ many }) => ({
  events: many(events),
  tasks: many(tasks),
  artifacts: many(artifacts),
  mergeDecisions: many(mergeDecisions),
}));

export const taskRelations = relations(tasks, ({ many, one }) => ({
  workflowRun: one(workflowRuns, {
    fields: [tasks.workflowRunId],
    references: [workflowRuns.id],
  }),
  attempts: many(agentAttempts),
  artifacts: many(artifacts),
}));

export const eventRelations = relations(events, ({ one }) => ({
  workflowRun: one(workflowRuns, {
    fields: [events.workflowRunId],
    references: [workflowRuns.id],
  }),
}));

export const mergeDecisionRelations = relations(mergeDecisions, ({ one }) => ({
  workflowRun: one(workflowRuns, {
    fields: [mergeDecisions.workflowRunId],
    references: [workflowRuns.id],
  }),
}));

export const artifactRelations = relations(artifacts, ({ one }) => ({
  workflowRun: one(workflowRuns, {
    fields: [artifacts.workflowRunId],
    references: [workflowRuns.id],
  }),
  task: one(tasks, {
    fields: [artifacts.taskId],
    references: [tasks.id],
  }),
}));
