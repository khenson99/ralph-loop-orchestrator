import Anthropic from '@anthropic-ai/sdk';

import type { AppConfig } from '../../config.js';
import { AgentResultV1Schema, type AgentResultV1, type FormalSpecV1 } from '../../schemas/contracts.js';

export class ClaudeStructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeStructuredOutputError';
  }
}

export class ClaudeAdapter {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly dryRun: boolean;
  private readonly hasApiKey: boolean;

  constructor(config: AppConfig['anthropic'], dryRun = false) {
    this.client = new Anthropic({ apiKey: config.apiKey ?? 'dry-run-key' });
    this.model = config.model;
    this.dryRun = dryRun;
    this.hasApiKey = Boolean(config.apiKey);
  }

  async executeSubtask(params: {
    taskId: string;
    taskTitle: string;
    ownerRole: string;
    spec: FormalSpecV1;
  }): Promise<AgentResultV1> {
    if (this.dryRun || !this.hasApiKey) {
      return AgentResultV1Schema.parse({
        task_id: params.taskId,
        status: 'completed',
        summary: `DRY_RUN completed task "${params.taskTitle}"`,
        files_changed: [],
        commands_ran: [{ cmd: 'echo dry-run', exit_code: 0 }],
        open_questions: [],
        handoff_notes: 'No code changes produced in dry-run mode.',
      });
    }

    const prompt = `
You are ${params.ownerRole} in a Ralph Loop execution worker.
Return ONLY JSON that matches AgentResultV1.

task_id=${params.taskId}
task_title=${params.taskTitle}

spec_yaml:
${JSON.stringify(params.spec, null, 2)}

Constraints:
- keep files_changed focused
- include commands_ran with plausible validation commands
- status must be one of completed|blocked|needs_review
`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(text));
    } catch (error) {
      if (error instanceof ClaudeStructuredOutputError) {
        throw error;
      }
      throw new ClaudeStructuredOutputError(
        `Claude output for task ${params.taskId} was not valid JSON: ${
          error instanceof Error ? error.message : 'unknown parse error'
        }`,
      );
    }

    const result = AgentResultV1Schema.safeParse(parsed);
    if (!result.success) {
      throw new ClaudeStructuredOutputError(
        `Claude output for task ${params.taskId} violated AgentResultV1 schema: ${result.error.message}`,
      );
    }

    if (result.data.task_id !== params.taskId) {
      throw new ClaudeStructuredOutputError(
        `Claude output task_id mismatch: expected ${params.taskId}, received ${result.data.task_id}`,
      );
    }

    return result.data;
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ClaudeStructuredOutputError('Claude output was empty');
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith('{') && inner.endsWith('}')) {
      return inner;
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new ClaudeStructuredOutputError('Claude output did not contain a JSON object');
  }

  return trimmed.slice(start, end + 1);
}
