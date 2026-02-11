import OpenAI from 'openai';
import yaml from 'js-yaml';

import type { AppConfig } from '../../config.js';
import {
  FormalSpecV1Schema,
  MergeDecisionV1Schema,
  type FormalSpecV1,
  type MergeDecisionV1,
} from '../../schemas/contracts.js';

export class CodexAdapter {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: AppConfig['openai']) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
  }

  async generateFormalSpec(params: {
    repo: string;
    issueNumber: number;
    issueTitle: string;
    issueBody: string;
    baselineCommit: string;
  }): Promise<{ spec: FormalSpecV1; rawYaml: string }> {
    const prompt = `
Convert this GitHub issue into a FormalSpecV1 YAML document.
Output YAML only.

repo: ${params.repo}
issue: #${params.issueNumber}
title: ${params.issueTitle}
body:
${params.issueBody}

baseline_commit: ${params.baselineCommit}
`;

    const response = await this.client.responses.create({
      model: this.model,
      instructions:
        'You are a strict software planning assistant. Emit valid YAML that conforms to FormalSpecV1. Include at least 1 work item.',
      input: prompt,
      reasoning: { effort: 'high' },
    });

    const rawYaml = response.output_text.trim();
    const parsed = yaml.load(rawYaml);
    const spec = FormalSpecV1Schema.parse(parsed);

    return { spec, rawYaml };
  }

  async summarizeReview(params: {
    spec: FormalSpecV1;
    agentOutputs: string[];
    ciSummary: string;
  }): Promise<string> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions:
        'Summarize whether acceptance criteria appear met. Focus on concrete evidence and risks in under 12 bullets.',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `SPEC:\n${yaml.dump(params.spec)}\n\nAGENT OUTPUTS:\n${params.agentOutputs.join(
                '\n---\n',
              )}\n\nCI:\n${params.ciSummary}`,
            },
          ],
        },
      ],
      reasoning: { effort: 'high' },
    });

    return response.output_text.trim();
  }

  async generateMergeDecision(params: {
    reviewSummary: string;
    requiredChecksPassed: boolean;
  }): Promise<MergeDecisionV1> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions:
        'Return ONLY JSON object matching MergeDecisionV1 with keys decision, rationale, blocking_findings.',
      input: `requiredChecksPassed=${params.requiredChecksPassed}\nreviewSummary:\n${params.reviewSummary}`,
      reasoning: { effort: 'high' },
    });

    const text = response.output_text.trim();
    const parsed = JSON.parse(text) as unknown;
    return MergeDecisionV1Schema.parse(parsed);
  }
}
