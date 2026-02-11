import { z } from 'zod';

export const WebhookEventEnvelopeSchema = z.object({
  schema_version: z.literal('1.0'),
  event_type: z.string().min(1),
  event_id: z.string().min(1),
  timestamp: z.string().datetime(),
  source: z.object({
    system: z.literal('github'),
    repo: z.string().min(1),
    delivery_id: z.string().min(1),
  }),
  actor: z.object({
    type: z.enum(['user', 'bot', 'system']),
    login: z.string().min(1),
  }),
  task_ref: z.object({
    kind: z.enum(['issue', 'project_item', 'workflow_dispatch', 'pull_request']),
    id: z.number().int().nonnegative(),
    url: z.string().url(),
  }),
  payload: z.record(z.string(), z.unknown()),
});

export const FormalSpecV1Schema = z.object({
  spec_version: z.literal(1),
  spec_id: z.string().min(1),
  source: z.object({
    github: z.object({
      repo: z.string().min(1),
      issue: z.number().int().nonnegative(),
      commit_baseline: z.string().min(1),
    }),
  }),
  objective: z.string().min(1),
  non_goals: z.array(z.string()).default([]),
  constraints: z.object({
    languages: z.array(z.string()).default([]),
    allowed_paths: z.array(z.string()).default([]),
    forbidden_paths: z.array(z.string()).default([]),
  }),
  acceptance_criteria: z.array(z.string()).min(1),
  design_notes: z
    .object({
      api_contract: z
        .object({
          endpoint: z.string(),
          response_on_limit: z
            .object({
              status: z.number().int(),
              body_json: z.record(z.string(), z.unknown()),
            })
            .optional(),
        })
        .optional(),
    })
    .default({}),
  work_breakdown: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        owner_role: z.string().min(1),
        definition_of_done: z.array(z.string()).default([]),
        depends_on: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  risk_checks: z.array(z.string()).default([]),
  validation_plan: z.object({
    ci_jobs: z.array(z.string()).default([]),
  }),
  stop_conditions: z.array(z.string()).default([]),
});

export const AgentResultV1Schema = z.object({
  task_id: z.string().min(1),
  status: z.enum(['completed', 'blocked', 'needs_review']),
  summary: z.string().min(1),
  files_changed: z.array(z.string()).default([]),
  commands_ran: z
    .array(
      z.object({
        cmd: z.string(),
        exit_code: z.number().int(),
      }),
    )
    .default([]),
  open_questions: z.array(z.string()).default([]),
  handoff_notes: z.string().default(''),
});

export const MergeDecisionV1Schema = z.object({
  decision: z.enum(['approve', 'request_changes', 'block']),
  rationale: z.string().min(1),
  blocking_findings: z.array(z.string()).default([]),
});

export const RunResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  currentStage: z.string(),
  issueNumber: z.number().int().nullable(),
  prNumber: z.number().int().nullable(),
  specId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  tasks: z.array(
    z.object({
      id: z.string(),
      taskKey: z.string(),
      status: z.string(),
      attempts: z.number().int(),
    }),
  ),
  artifacts: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      createdAt: z.string().datetime(),
    }),
  ),
});

export const TaskResponseSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  taskKey: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  lastResult: z.unknown().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type WebhookEventEnvelope = z.infer<typeof WebhookEventEnvelopeSchema>;
export type FormalSpecV1 = z.infer<typeof FormalSpecV1Schema>;
export type AgentResultV1 = z.infer<typeof AgentResultV1Schema>;
export type MergeDecisionV1 = z.infer<typeof MergeDecisionV1Schema>;
export type RunResponse = z.infer<typeof RunResponseSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
