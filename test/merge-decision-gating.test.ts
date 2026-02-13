import { describe, expect, it, vi } from 'vitest';

import { CodexAdapter } from '../src/integrations/openai/codex.js';

describe('CodexAdapter merge decision gate', () => {
  it('hard-blocks approval when required checks are not passed', async () => {
    const adapter = new CodexAdapter({ apiKey: 'test-key', model: 'gpt-5.3-codex' }, false);
    const create = vi.fn().mockResolvedValue({
      output_text: '{"decision":"approve","rationale":"ok","blocking_findings":[]}',
    });

    (
      adapter as unknown as {
        client: { responses: { create: typeof create } };
      }
    ).client = {
      responses: { create },
    };

    const decision = await adapter.generateMergeDecision({
      reviewSummary: 'All good except required checks pending.',
      requiredChecksPassed: false,
    });

    expect(decision.decision).toBe('request_changes');
    expect(decision.blocking_findings).toContain('One or more required checks are pending or failing.');
    expect(create).not.toHaveBeenCalled();
  });

  it('delegates to model once required checks pass', async () => {
    const adapter = new CodexAdapter({ apiKey: 'test-key', model: 'gpt-5.3-codex' }, false);
    const create = vi.fn().mockResolvedValue({
      output_text: '{"decision":"approve","rationale":"All checks passed.","blocking_findings":[]}',
    });

    (
      adapter as unknown as {
        client: { responses: { create: typeof create } };
      }
    ).client = {
      responses: { create },
    };

    const decision = await adapter.generateMergeDecision({
      reviewSummary: 'Checks passed and no blockers.',
      requiredChecksPassed: true,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(decision.decision).toBe('approve');
    expect(decision.blocking_findings).toEqual([]);
  });
});
