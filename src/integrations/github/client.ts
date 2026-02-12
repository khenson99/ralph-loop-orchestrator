import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

import type { AppConfig } from '../../config.js';

export type IssueContext = {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  url: string;
  actor: string;
};

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(private readonly config: AppConfig['github']) {
    if (this.config.token) {
      this.octokit = new Octokit({ auth: this.config.token });
      return;
    }

    if (!this.config.appId || !this.config.appPrivateKey || !this.config.installationId) {
      throw new Error('GitHub app configuration is incomplete.');
    }

    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.appId,
        privateKey: this.config.appPrivateKey,
        installationId: this.config.installationId,
      },
    });
  }

  async getIssueContext(issueNumber: number): Promise<IssueContext> {
    const issue = await this.octokit.rest.issues.get({
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      issue_number: issueNumber,
    });

    return {
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      issueNumber,
      title: issue.data.title,
      body: issue.data.body ?? '',
      url: issue.data.html_url,
      actor: issue.data.user?.login ?? 'system',
    };
  }

  async getBranchSha(branch: string): Promise<string> {
    const ref = await this.octokit.rest.git.getRef({
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      ref: `heads/${branch}`,
    });
    return ref.data.object.sha;
  }

  async addIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      issue_number: issueNumber,
      body,
    });
  }

  async findOpenPullRequestForIssue(issueNumber: number): Promise<number | null> {
    const pulls = await this.octokit.rest.pulls.list({
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 50,
    });

    const regex = new RegExp(`(?:(?:closes|fixes|resolves)\\s+#${issueNumber}\\b|#${issueNumber}\\b)`, 'i');
    const match = pulls.data.find(
      (pr) => regex.test(pr.body ?? '') || regex.test(pr.title ?? '') || pr.head.ref.includes(`issue-${issueNumber}`),
    );

    return match?.number ?? null;
  }

  async getPullRequest(prNumber: number) {
    const pr = await this.octokit.rest.pulls.get({
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      pull_number: prNumber,
    });
    return pr.data;
  }

  async getPullRequestChecks(prNumber: number): Promise<{
    prNumber: number;
    headSha: string;
    checks: Array<{
      name: string;
      status: string | null;
      conclusion: string | null;
    }>;
  }> {
    const pr = await this.getPullRequest(prNumber);
    const checks = await this.octokit.rest.checks.listForRef({
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      ref: pr.head.sha,
      per_page: 100,
    });

    return {
      prNumber,
      headSha: pr.head.sha,
      checks: checks.data.check_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
      })),
    };
  }

  async hasRequiredChecksPassed(prNumber: number, requiredChecks: string[]): Promise<boolean> {
    const pr = await this.getPullRequest(prNumber);
    const refs = [...new Set([pr.head.sha, pr.merge_commit_sha].filter((ref): ref is string => Boolean(ref)))];

    const snapshots = await Promise.all(refs.map((ref) => this.getCheckSnapshotForRef(ref)));

    if (requiredChecks.length === 0) {
      return snapshots.some((snapshot) => {
        const checksPassed = snapshot.checkRuns.every(
          (run) => run.status === 'completed' && run.conclusion === 'success',
        );
        const statusesPassed = snapshot.statuses.every((status) => status.state === 'success');
        return checksPassed && statusesPassed;
      });
    }

    return requiredChecks.every((required) =>
      snapshots.some((snapshot) => {
        const run = snapshot.checkRuns.find((item) => item.name === required);
        const context = snapshot.statuses.find((item) => item.context === required);
        const checkRunPassed = run?.status === 'completed' && run.conclusion === 'success';
        const statusPassed = context?.state === 'success';
        return checkRunPassed || statusPassed;
      }),
    );
  }

  private async getCheckSnapshotForRef(ref: string): Promise<{
    checkRuns: Array<{ name: string; status: string | null; conclusion: string | null }>;
    statuses: Array<{ context: string; state: string }>;
  }> {
    const [checks, combinedStatus] = await Promise.all([
      this.octokit.rest.checks.listForRef({
        owner: this.config.targetOwner,
        repo: this.config.targetRepo,
        ref,
        per_page: 100,
      }),
      this.octokit.rest.repos.getCombinedStatusForRef({
        owner: this.config.targetOwner,
        repo: this.config.targetRepo,
        ref,
      }),
    ]);

    return {
      checkRuns: checks.data.check_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
      })),
      statuses: combinedStatus.data.statuses.map((status) => ({
        context: status.context,
        state: status.state,
      })),
    };
  }

  async requestChanges(prNumber: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.createReview({
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      pull_number: prNumber,
      event: 'REQUEST_CHANGES',
      body,
    });
  }

  async approvePullRequest(prNumber: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.createReview({
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      pull_number: prNumber,
      event: 'APPROVE',
      body,
    });
  }

  async enableAutoMerge(prNumber: number): Promise<void> {
    const pr = await this.getPullRequest(prNumber);

    await this.octokit.graphql(
      `mutation EnableAutoMerge($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId,
          mergeMethod: SQUASH
        }) {
          pullRequest {
            number
          }
        }
      }`,
      { pullRequestId: pr.node_id },
    );
  }

  async mergePullRequest(prNumber: number): Promise<void> {
    await this.octokit.rest.pulls.merge({
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      pull_number: prNumber,
      merge_method: 'squash',
      delete_branch: true,
    });
  }

  async ensureLabels(labels: Array<{ name: string; color: string; description: string }>): Promise<void> {
    const existing = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
      per_page: 100,
    });

    const existingMap = new Map(existing.map((label) => [label.name, label]));

    for (const label of labels) {
      const found = existingMap.get(label.name);
      if (!found) {
        await this.octokit.rest.issues.createLabel({
          owner: this.config.targetOwner,
          repo: this.config.targetRepo,
          name: label.name,
          color: label.color,
          description: label.description,
        });
        continue;
      }

      if (found.color !== label.color || found.description !== label.description) {
        await this.octokit.rest.issues.updateLabel({
          owner: this.config.targetOwner,
          repo: this.config.targetRepo,
          name: found.name,
          new_name: label.name,
          color: label.color,
          description: label.description,
        });
      }
    }
  }
}
