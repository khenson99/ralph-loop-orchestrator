import { describe, expect, it } from 'vitest';

import { AgentResultV1Schema, FormalSpecV1Schema } from '../src/schemas/contracts.js';

describe('schema validation', () => {
  it('rejects invalid formal spec', () => {
    expect(() =>
      FormalSpecV1Schema.parse({
        spec_version: 1,
        spec_id: 'spec-1',
        source: {
          github: {
            repo: 'khenson99/ralph-loop-orchestrator',
            issue: 1,
            commit_baseline: 'abc',
          },
        },
        objective: 'Build thing',
        constraints: { languages: [], allowed_paths: [], forbidden_paths: [] },
        acceptance_criteria: [],
        work_breakdown: [],
        validation_plan: { ci_jobs: [] },
      }),
    ).toThrow();
  });

  it('rejects malformed agent result payload', () => {
    expect(() =>
      AgentResultV1Schema.parse({
        task_id: 'T1',
        status: 'done',
        summary: 'complete',
      }),
    ).toThrow();
  });
});
