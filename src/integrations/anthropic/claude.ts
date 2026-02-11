import Anthropic from '@anthropic-ai/sdk';

import type { AppConfig } from '../../config.js';
import { AgentResultV1Schema, type AgentResultV1, type FormalSpecV1 } from '../../schemas/contracts.js';

export class ClaudeAdapter {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: AppConfig['anthropic']) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
  }

  async executeSubtask(params: {
    taskId: string;
    taskTitle: string;
    ownerRole: string;
    spec: FormalSpecV1;
  }): Promise<AgentResultV1> {
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

    const parsed = JSON.parse(extractJson(text));
    return AgentResultV1Schema.parse(parsed);
  }
}

function extractJson(text: string): string {
  if (text.startsWith('{') && text.endsWith('}')) {
    return text;
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Claude output did not contain JSON object');
  }

  return match[0];
}
