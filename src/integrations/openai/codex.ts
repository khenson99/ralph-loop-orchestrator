import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import OpenAI from 'openai';
import yaml from 'js-yaml';

import type { AppConfig } from '../../config.js';
import {
  FormalSpecV1Schema,
  MergeDecisionV1Schema,
  type FormalSpecV1,
  type MergeDecisionV1,
} from '../../schemas/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPromptTemplate(name: string): string {
  const templatePath = resolve(__dirname, '../../prompts', `${name}.md`);
  return readFileSync(templatePath, 'utf-8');
}

export class CodexAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly dryRun: boolean;
  private readonly hasApiKey: boolean;
  private readonly formalSpecPrompt: string;

  constructor(config: AppConfig['openai'], dryRun = false) {
    this.client = new OpenAI({ apiKey: config.apiKey ?? 'dry-run-key' });
    this.model = config.model;
    this.dryRun = dryRun;
    this.hasApiKey = Boolean(config.apiKey);
    this.formalSpecPrompt = loadPromptTemplate('formal-spec-v1');
  }

  async generateFormalSpec(params: {
    repo: string;
    issueNumber: number;
    issueTitle: string;
    issueBody: string;
    baselineCommit: string;
  }): Promise<{ spec: FormalSpecV1; rawYaml: string }> {
    if (this.dryRun || !this.hasApiKey) {
      const spec: FormalSpecV1 = FormalSpecV1Schema.parse({
        spec_version: 1,
        spec_id: `spec_${params.issueNumber}_${Date.now()}`,
        source: {
          github: {
            repo: params.repo,
            issue: params.issueNumber,
            commit_baseline: params.baselineCommit,
          },
        },
        objective: `Implement issue #${params.issueNumber}: ${params.issueTitle}`,
        non_goals: [],
        constraints: {
          languages: ['typescript'],
          allowed_paths: ['src/', 'scripts/', 'test/'],
          forbidden_paths: [],
        },
        acceptance_criteria: [
          'Workflow run created from webhook event',
          'At least one task executed with structured output',
          'Run artifacts persisted',
        ],
        design_notes: {},
        work_breakdown: [
          {
            id: `T${params.issueNumber}-1`,
            title: `Analyze and process issue #${params.issueNumber}`,
            owner_role: 'backend-engineer',
            definition_of_done: ['Task marked completed with artifact output'],
            depends_on: [],
          },
        ],
        risk_checks: ['No secrets in logs'],
        validation_plan: {
          ci_jobs: ['CI / Lint + Typecheck', 'CI / Tests'],
        },
        stop_conditions: ['All tasks complete'],
      });
      const rawYaml = yaml.dump(spec);
      return { spec, rawYaml };
    }

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
      instructions: this.formalSpecPrompt,
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
    if (this.dryRun || !this.hasApiKey) {
      return [
        'DRY_RUN summary:',
        `- Spec ${params.spec.spec_id} contains ${params.spec.work_breakdown.length} work item(s).`,
        `- Agent outputs observed: ${params.agentOutputs.length}.`,
        `- CI summary: ${params.ciSummary}`,
      ].join('\n');
    }

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
    if (!params.requiredChecksPassed) {
      return MergeDecisionV1Schema.parse({
        decision: 'request_changes',
        rationale:
          'Required checks gate failed: merge approval is blocked until all required checks pass.',
        blocking_findings: ['One or more required checks are pending or failing.'],
      });
    }

    if (this.dryRun || !this.hasApiKey) {
      return MergeDecisionV1Schema.parse({
        decision: 'approve',
        rationale: 'Required checks passed in dry-run mode.',
        blocking_findings: [],
      });
    }

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
