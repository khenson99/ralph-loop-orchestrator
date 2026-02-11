import { Webhooks } from '@octokit/webhooks';

import { WebhookEventEnvelopeSchema, type WebhookEventEnvelope } from '../../schemas/contracts.js';

export async function verifyGitHubSignature(params: {
  secret: string;
  payload: string;
  signature: string;
}): Promise<boolean> {
  const webhooks = new Webhooks({ secret: params.secret });
  return webhooks.verify(params.payload, params.signature);
}

export function mapGithubWebhookToEnvelope(params: {
  eventName: string;
  deliveryId: string;
  payload: Record<string, unknown>;
}): WebhookEventEnvelope {
  const issue = (params.payload.issue ?? null) as Record<string, unknown> | null;
  const pullRequest = (params.payload.pull_request ?? null) as Record<string, unknown> | null;

  const isPullRequest = Boolean(pullRequest);
  const pullRequestUrl =
    pullRequest && typeof pullRequest.html_url === 'string' ? pullRequest.html_url : '';
  const issueUrl = issue && typeof issue.html_url === 'string' ? issue.html_url : '';
  const taskRef = isPullRequest
    ? {
        kind: 'pull_request' as const,
        id: Number(pullRequest?.number ?? 0),
        url: pullRequestUrl,
      }
    : {
        kind: 'issue' as const,
        id: Number(issue?.number ?? 0),
        url: issueUrl,
      };

  const actorLogin =
    String(
      ((params.payload.sender as Record<string, unknown> | undefined)?.login as string | undefined) ??
        'system',
    ) || 'system';

  const repo = params.payload.repository as Record<string, unknown> | undefined;
  const ownerLogin =
    ((repo?.owner as Record<string, unknown> | undefined)?.login as string | undefined) ?? 'unknown';
  const repoName = (repo?.name as string | undefined) ?? 'unknown';

  const envelope: WebhookEventEnvelope = {
    schema_version: '1.0',
    event_type: `github.${params.eventName}`,
    event_id: `gh_${params.deliveryId}`,
    timestamp: new Date().toISOString(),
    source: {
      system: 'github',
      repo: `${ownerLogin}/${repoName}`,
      delivery_id: params.deliveryId,
    },
    actor: {
      type: actorLogin.endsWith('[bot]') ? 'bot' : 'user',
      login: actorLogin,
    },
    task_ref: taskRef,
    payload: params.payload,
  };

  return WebhookEventEnvelopeSchema.parse(envelope);
}

export function isActionableEvent(eventName: string, payload: Record<string, unknown>): boolean {
  const action = typeof payload.action === 'string' ? payload.action : '';

  if (eventName === 'issues') {
    return ['opened', 'reopened', 'labeled'].includes(action);
  }

  if (eventName === 'pull_request') {
    return ['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action);
  }

  if (eventName === 'workflow_dispatch') {
    return true;
  }

  return false;
}

export function extractIssueNumber(payload: Record<string, unknown>): number | null {
  const issue = payload.issue as Record<string, unknown> | undefined;
  if (issue && typeof issue.number === 'number') {
    return issue.number;
  }

  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (pr && typeof pr.number === 'number') {
    return pr.number;
  }

  return null;
}
