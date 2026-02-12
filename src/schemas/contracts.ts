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

export const BoardCardSchema = z.object({
  card_id: z.string(),
  title: z.string(),
  lane: z.string(),
  status: z.string(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
  owner: z.object({
    type: z.enum(['user', 'team', 'none']),
    id: z.string(),
    display_name: z.string(),
  }),
  attempt: z.object({
    current_attempt_id: z.string().nullable(),
    attempt_count: z.number().int(),
    last_attempt_status: z.string().nullable(),
  }),
  signals: z.object({
    ci_status: z.enum(['unknown', 'pending', 'passing', 'failing']),
    llm_review_verdict: z.enum(['unknown', 'approved', 'needs_changes', 'blocked']),
    human_review_state: z.enum(['none', 'requested', 'approved']).default('none'),
  }),
  timestamps: z.object({
    created_at: z.string().datetime(),
    last_updated_at: z.string().datetime(),
    lane_entered_at: z.string().datetime(),
  }),
  links: z.object({
    github_issue_url: z.string().url().nullable(),
    pull_request_url: z.string().url().nullable(),
  }),
  source: z.object({
    owner: z.string(),
    repo: z.string(),
    full_name: z.string(),
  }),
  tags: z.array(z.string()).default([]),
});

export const BoardResponseSchema = z.object({
  board_id: z.string(),
  generated_at: z.string().datetime(),
  lanes: z.array(
    z.object({
      lane: z.string(),
      wip_limit: z.number().int(),
      cards: z.array(z.string()),
    }),
  ),
  cards: z.record(z.string(), BoardCardSchema),
});

export const TimelineEventSchema = z.object({
  event_id: z.string(),
  event_type: z.string(),
  occurred_at: z.string().datetime(),
  actor: z.object({
    type: z.enum(['system', 'user']),
    id: z.string(),
  }),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const TaskDetailResponseSchema = z.object({
  card: BoardCardSchema,
  run: z.object({
    id: z.string(),
    status: z.string(),
    current_stage: z.string(),
    spec_id: z.string().nullable(),
  }),
  task: z.object({
    id: z.string(),
    task_key: z.string(),
    title: z.string(),
    owner_role: z.string(),
    status: z.string(),
    attempts: z.number().int(),
    definition_of_done: z.array(z.string()),
    depends_on: z.array(z.string()),
    last_result: z.unknown().nullable(),
  }),
  attempts: z.array(
    z.object({
      id: z.string(),
      agent_role: z.string(),
      attempt_number: z.number().int(),
      status: z.string(),
      error: z.string().nullable(),
      duration_ms: z.number().int().nullable(),
      created_at: z.string().datetime(),
      output: z.unknown().nullable(),
    }),
  ),
  artifacts: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      content: z.string(),
      created_at: z.string().datetime(),
      metadata: z.record(z.string(), z.unknown()),
    }),
  ),
  timeline: z.array(TimelineEventSchema),
  pull_request: z
    .object({
      number: z.number().int(),
      title: z.string(),
      url: z.string().url(),
      state: z.enum(['open', 'closed']),
      draft: z.boolean(),
      mergeable: z.boolean().nullable(),
      head_sha: z.string(),
      overall_status: z.enum(['unknown', 'pending', 'passing', 'failing']),
      required_checks: z.array(z.string()),
      checks: z.array(
        z.object({
          name: z.string(),
          status: z.enum(['queued', 'in_progress', 'completed']),
          conclusion: z
            .enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required'])
            .nullable(),
          required: z.boolean(),
          details_url: z.string().url().nullable(),
          started_at: z.string().datetime().nullable(),
          completed_at: z.string().datetime().nullable(),
        }),
      ),
    })
    .nullable(),
});

export const TaskActionResponseSchema = z.object({
  action_id: z.string(),
  accepted: z.boolean(),
  task_id: z.string(),
  action: z.string(),
  result: z.enum(['completed', 'pending']),
  created_at: z.string().datetime(),
});

export const AuthMeResponseSchema = z.object({
  authenticated: z.boolean(),
  user_id: z.string(),
  roles: z.array(z.enum(['viewer', 'operator', 'reviewer', 'admin'])),
  permissions: z.object({
    actions: z.array(z.string()),
  }),
});

export const RepoListResponseSchema = z.object({
  generated_at: z.string().datetime(),
  items: z.array(
    z.object({
      owner: z.string(),
      repo: z.string(),
      full_name: z.string(),
      private: z.boolean(),
      default_branch: z.string(),
      url: z.string().url(),
    }),
  ),
});

export const EpicListResponseSchema = z.object({
  generated_at: z.string().datetime(),
  owner: z.string(),
  repo: z.string(),
  items: z.array(
    z.object({
      number: z.number().int(),
      title: z.string(),
      state: z.enum(['open', 'closed']),
      labels: z.array(z.string()),
      url: z.string().url(),
      updated_at: z.string().datetime(),
      created_at: z.string().datetime(),
    }),
  ),
});

export const EpicDispatchResponseSchema = z.object({
  repo_full_name: z.string(),
  requested_by: z.string(),
  accepted: z.array(
    z.object({
      epic_number: z.number().int(),
      event_id: z.string(),
    }),
  ),
  duplicates: z.array(
    z.object({
      epic_number: z.number().int(),
      event_id: z.string(),
    }),
  ),
  dispatched_at: z.string().datetime(),
});

export type WebhookEventEnvelope = z.infer<typeof WebhookEventEnvelopeSchema>;
export type FormalSpecV1 = z.infer<typeof FormalSpecV1Schema>;
export type AgentResultV1 = z.infer<typeof AgentResultV1Schema>;
export type MergeDecisionV1 = z.infer<typeof MergeDecisionV1Schema>;
export type RunResponse = z.infer<typeof RunResponseSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type BoardCard = z.infer<typeof BoardCardSchema>;
export type BoardResponse = z.infer<typeof BoardResponseSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type TaskDetailResponse = z.infer<typeof TaskDetailResponseSchema>;
export type TaskActionResponse = z.infer<typeof TaskActionResponseSchema>;
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;
export type RepoListResponse = z.infer<typeof RepoListResponseSchema>;
export type EpicListResponse = z.infer<typeof EpicListResponseSchema>;
export type EpicDispatchResponse = z.infer<typeof EpicDispatchResponseSchema>;
