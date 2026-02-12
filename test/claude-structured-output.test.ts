import { describe, expect, it, vi } from 'vitest';

import { ClaudeAdapter, ClaudeStructuredOutputError } from '../src/integrations/anthropic/claude.js';
import { classifyError } from '../src/orchestrator/stages.js';
import type { FormalSpecV1 } from '../src/schemas/contracts.js';

const spec: FormalSpecV1 = {
  spec_version: 1,
  spec_id: 'spec-123',
  source: {
    github: {
      repo: 'khenson99/ralph-loop-orchestrator',
      issue: 13,
      commit_baseline: 'abc123',
    },
  },
  objective: 'Implement ticket #13',
  non_goals: [],
  constraints: {
    languages: ['typescript'],
    allowed_paths: ['src/'],
    forbidden_paths: [],
  },
  acceptance_criteria: ['Contracts validated'],
  design_notes: {},
  work_breakdown: [
    {
      id: 'T13-1',
      title: 'Structured output',
      owner_role: 'backend-engineer',
      definition_of_done: [],
      depends_on: [],
    },
  ],
  risk_checks: [],
  validation_plan: { ci_jobs: [] },
  stop_conditions: [],
};

function makeAdapterWithTextResponse(text: string): ClaudeAdapter {
  const adapter = new ClaudeAdapter({ apiKey: 'test-key', model: 'claude-opus-4-6' }, false);
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text }],
  });

  (adapter as unknown as { client: { messages: { create: typeof create } } }).client = {
    messages: { create },
  };

  return adapter;
}

describe('ClaudeAdapter structured output contract', () => {
  it('accepts valid JSON enclosed in code fences', async () => {
    const adapter = makeAdapterWithTextResponse(`\`\`\`json
{"task_id":"T13-1","status":"completed","summary":"done","files_changed":[],"commands_ran":[],"open_questions":[],"handoff_notes":""}
\`\`\``);

    const result = await adapter.executeSubtask({
      taskId: 'T13-1',
      taskTitle: 'Structured output',
      ownerRole: 'backend-engineer',
      spec,
    });

    expect(result.task_id).toBe('T13-1');
    expect(result.status).toBe('completed');
  });

  it('rejects responses that do not contain JSON', async () => {
    const adapter = makeAdapterWithTextResponse('done.');

    await expect(
      adapter.executeSubtask({
        taskId: 'T13-1',
        taskTitle: 'Structured output',
        ownerRole: 'backend-engineer',
        spec,
      }),
    ).rejects.toBeInstanceOf(ClaudeStructuredOutputError);
  });

  it('rejects schema-invalid payloads as deterministic contract failures', async () => {
    const adapter = makeAdapterWithTextResponse(
      '{"task_id":"T13-1","status":"done","summary":"done","files_changed":[],"commands_ran":[],"open_questions":[],"handoff_notes":""}',
    );

    await expect(
      adapter.executeSubtask({
        taskId: 'T13-1',
        taskTitle: 'Structured output',
        ownerRole: 'backend-engineer',
        spec,
      }),
    ).rejects.toBeInstanceOf(ClaudeStructuredOutputError);

    expect(classifyError(new ClaudeStructuredOutputError('bad payload'))).toBe('deterministic');
  });

  it('rejects task_id mismatch as deterministic contract failure', async () => {
    const adapter = makeAdapterWithTextResponse(
      '{"task_id":"OTHER","status":"completed","summary":"done","files_changed":[],"commands_ran":[],"open_questions":[],"handoff_notes":""}',
    );

    await expect(
      adapter.executeSubtask({
        taskId: 'T13-1',
        taskTitle: 'Structured output',
        ownerRole: 'backend-engineer',
        spec,
      }),
    ).rejects.toThrow('task_id mismatch');
  });
});
