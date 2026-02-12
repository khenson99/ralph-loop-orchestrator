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

export type RepoRef = {
  owner: string;
  repo: string;
};

export type PullRequestChecksSnapshot = {
  prNumber: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  draft: boolean;
  mergeable: boolean | null;
  headSha: string;
  checks: Array<{
    name: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
    detailsUrl: string | null;
    startedAt: string | null;
    completedAt: string | null;
    required: boolean;
  }>;
  requiredCheckNames: string[];
  overallStatus: 'unknown' | 'pending' | 'passing' | 'failing';
};

export type RepositoryProjectSummary = {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  updatedAt: string;
};

export type ProjectTodoIssue = {
  itemId: string;
  issueNumber: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  labels: string[];
  statusName: string | null;
  repositoryFullName: string;
};

export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly defaultRepo: RepoRef;

  constructor(private readonly config: AppConfig['github']) {
    this.defaultRepo = {
      owner: this.config.targetOwner,
      repo: this.config.targetRepo,
    };

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

  private resolveRepo(ref?: RepoRef): RepoRef {
    if (!ref) {
      return this.defaultRepo;
    }
    return {
      owner: ref.owner,
      repo: ref.repo,
    };
  }

  async getIssueContext(issueNumber: number, ref?: RepoRef): Promise<IssueContext> {
    const repo = this.resolveRepo(ref);
    const issue = await this.octokit.rest.issues.get({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
    });

    return {
      owner: repo.owner,
      repo: repo.repo,
      issueNumber,
      title: issue.data.title,
      body: issue.data.body ?? '',
      url: issue.data.html_url,
      actor: issue.data.user?.login ?? 'system',
    };
  }

  async getBranchSha(branch: string, ref?: RepoRef): Promise<string> {
    const repo = this.resolveRepo(ref);
    const response = await this.octokit.rest.git.getRef({
      owner: repo.owner,
      repo: repo.repo,
      ref: `heads/${branch}`,
    });
    return response.data.object.sha;
  }

  async addIssueComment(issueNumber: number, body: string, ref?: RepoRef): Promise<void> {
    const repo = this.resolveRepo(ref);
    await this.octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async findOpenPullRequestForIssue(issueNumber: number, ref?: RepoRef): Promise<number | null> {
    const repo = this.resolveRepo(ref);
    const pulls = await this.octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.repo,
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

  async getPullRequest(prNumber: number, ref?: RepoRef) {
    const repo = this.resolveRepo(ref);
    const pr = await this.octokit.rest.pulls.get({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
    });
    return pr.data;
  }

  async hasRequiredChecksPassed(prNumber: number, requiredChecks: string[], ref?: RepoRef): Promise<boolean> {
    const repo = this.resolveRepo(ref);
    const pr = await this.getPullRequest(prNumber, repo);

    const checks = await this.octokit.rest.checks.listForRef({
      owner: repo.owner,
      repo: repo.repo,
      ref: pr.head.sha,
      per_page: 100,
    });

    const map = new Map(checks.data.check_runs.map((run) => [run.name, run]));

    if (requiredChecks.length === 0) {
      return checks.data.check_runs.every(
        (run) => run.status === 'completed' && run.conclusion === 'success',
      );
    }

    return requiredChecks.every((required) => {
      const run = map.get(required);
      return run?.status === 'completed' && run.conclusion === 'success';
    });
  }

  async getPullRequestChecksSnapshot(
    prNumber: number,
    requiredChecks: string[],
    ref?: RepoRef,
  ): Promise<PullRequestChecksSnapshot> {
    const repo = this.resolveRepo(ref);
    const pr = await this.getPullRequest(prNumber, repo);
    const checks = await this.octokit.rest.checks.listForRef({
      owner: repo.owner,
      repo: repo.repo,
      ref: pr.head.sha,
      per_page: 100,
    });

    const requiredSet = new Set(requiredChecks);
    const checkRuns = checks.data.check_runs.map((run) => ({
      name: run.name,
      status: run.status as 'queued' | 'in_progress' | 'completed',
      conclusion: run.conclusion as
        | 'success'
        | 'failure'
        | 'neutral'
        | 'cancelled'
        | 'skipped'
        | 'timed_out'
        | 'action_required'
        | null,
      detailsUrl: run.details_url ?? null,
      startedAt: run.started_at ?? null,
      completedAt: run.completed_at ?? null,
      required: requiredSet.has(run.name),
    }));

    let overallStatus: PullRequestChecksSnapshot['overallStatus'] = 'unknown';
    if (checkRuns.length > 0) {
      const allCompleted = checkRuns.every((run) => run.status === 'completed');
      const anyFailing = checkRuns.some(
        (run) =>
          run.conclusion === 'failure' ||
          run.conclusion === 'timed_out' ||
          run.conclusion === 'cancelled' ||
          run.conclusion === 'action_required',
      );
      const allPassing = checkRuns.every((run) => run.status === 'completed' && run.conclusion === 'success');

      if (allPassing) {
        overallStatus = 'passing';
      } else if (anyFailing) {
        overallStatus = 'failing';
      } else if (!allCompleted) {
        overallStatus = 'pending';
      } else {
        overallStatus = 'unknown';
      }
    }

    return {
      prNumber,
      title: pr.title,
      url: pr.html_url,
      state: pr.state as 'open' | 'closed',
      draft: pr.draft ?? false,
      mergeable: pr.mergeable,
      headSha: pr.head.sha,
      checks: checkRuns,
      requiredCheckNames: requiredChecks,
      overallStatus,
    };
  }

  async requestChanges(prNumber: number, body: string, ref?: RepoRef): Promise<void> {
    const repo = this.resolveRepo(ref);
    await this.octokit.rest.pulls.createReview({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      event: 'REQUEST_CHANGES',
      body,
    });
  }

  async approvePullRequest(prNumber: number, body: string, ref?: RepoRef): Promise<void> {
    const repo = this.resolveRepo(ref);
    await this.octokit.rest.pulls.createReview({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      event: 'APPROVE',
      body,
    });
  }

  async enableAutoMerge(prNumber: number, ref?: RepoRef): Promise<void> {
    const pr = await this.getPullRequest(prNumber, ref);

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

  async mergePullRequest(prNumber: number, ref?: RepoRef): Promise<void> {
    const repo = this.resolveRepo(ref);
    await this.octokit.rest.pulls.merge({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      merge_method: 'squash',
      delete_branch: true,
    });
  }

  async ensureLabels(labels: Array<{ name: string; color: string; description: string }>, ref?: RepoRef): Promise<void> {
    const repo = this.resolveRepo(ref);
    const existing = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
      owner: repo.owner,
      repo: repo.repo,
      per_page: 100,
    });

    const existingMap = new Map(existing.map((label) => [label.name, label]));

    for (const label of labels) {
      const found = existingMap.get(label.name);
      if (!found) {
        await this.octokit.rest.issues.createLabel({
          owner: repo.owner,
          repo: repo.repo,
          name: label.name,
          color: label.color,
          description: label.description,
        });
        continue;
      }

      if (found.color !== label.color || found.description !== label.description) {
        await this.octokit.rest.issues.updateLabel({
          owner: repo.owner,
          repo: repo.repo,
          name: found.name,
          new_name: label.name,
          color: label.color,
          description: label.description,
        });
      }
    }
  }

  async listAccessibleRepositories(params?: {
    owner?: string;
    limit?: number;
  }): Promise<
    Array<{
      owner: string;
      repo: string;
      fullName: string;
      private: boolean;
      defaultBranch: string;
      url: string;
    }>
  > {
    const ownerFilter = params?.owner?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(params?.limit ?? 200, 500));

    let repos: Array<{
      owner: string;
      repo: string;
      fullName: string;
      private: boolean;
      defaultBranch: string;
      url: string;
    }> = [];

    if (this.config.token) {
      const pages = await this.octokit.paginate(this.octokit.rest.repos.listForAuthenticatedUser, {
        per_page: 100,
      });
      repos = pages.map((repo) => ({
        owner: repo.owner.login,
        repo: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        url: repo.html_url,
      }));
    } else {
      const response = await this.octokit.request('GET /installation/repositories', {
        per_page: 100,
      });
      repos = (response.data.repositories ?? [])
        .map((repo) => ({
          owner: repo.owner.login,
          repo: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          url: repo.html_url,
        }));
    }

    const filtered = repos
      .filter((repo) => !ownerFilter || repo.owner.toLowerCase() === ownerFilter)
      .sort((a, b) => a.fullName.localeCompare(b.fullName));

    return filtered.slice(0, limit);
  }

  async listEpicIssues(
    ref: RepoRef,
    params?: { state?: 'open' | 'closed' | 'all'; limit?: number },
  ): Promise<
    Array<{
      number: number;
      title: string;
      state: 'open' | 'closed';
      labels: string[];
      url: string;
      updatedAt: string;
      createdAt: string;
    }>
  > {
    const repo = this.resolveRepo(ref);
    const state = params?.state ?? 'open';
    const limit = Math.max(1, Math.min(params?.limit ?? 200, 500));

    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: repo.owner,
      repo: repo.repo,
      state,
      per_page: 100,
    });

    const epicIssues = issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => {
        const labels = issue.labels
          .map((label) => (typeof label === 'string' ? label : label.name ?? ''))
          .filter((label) => label.length > 0);
        return { issue, labels };
      })
      .filter(({ issue, labels }) => {
        const title = issue.title.toLowerCase();
        const labelEpic = labels.some((label) => label.toLowerCase().includes('epic'));
        const titleEpic = title.startsWith('epic:') || title.startsWith('[epic]') || title.includes(' epic ');
        return labelEpic || titleEpic;
      })
      .map(({ issue, labels }) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state as 'open' | 'closed',
        labels,
        url: issue.html_url,
        updatedAt: issue.updated_at,
        createdAt: issue.created_at,
      }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    return epicIssues.slice(0, limit);
  }

  async listRepositoryProjects(
    ref: RepoRef,
    params?: { includeClosed?: boolean; limit?: number },
  ): Promise<RepositoryProjectSummary[]> {
    const repo = this.resolveRepo(ref);
    const includeClosed = params?.includeClosed ?? false;
    const limit = Math.max(1, Math.min(params?.limit ?? 100, 100));

    type GraphqlNode = {
      id: string;
      number: number;
      title: string;
      url: string;
      closed: boolean;
      updatedAt: string;
    };

    const data = await this.octokit.graphql<{
      repository: {
        projectsV2: {
          nodes: GraphqlNode[];
        };
      };
    }>(
      `query RepoProjects($owner: String!, $repo: String!, $first: Int!) {
        repository(owner: $owner, name: $repo) {
          projectsV2(first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
            nodes {
              id
              number
              title
              url
              closed
              updatedAt
            }
          }
        }
      }`,
      {
        owner: repo.owner,
        repo: repo.repo,
        first: limit,
      },
    );

    const nodes = data.repository.projectsV2.nodes ?? [];
    const filtered = nodes
      .filter((project) => includeClosed || !project.closed)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    return filtered.slice(0, limit).map((project) => ({
      id: project.id,
      number: project.number,
      title: project.title,
      url: project.url,
      closed: project.closed,
      updatedAt: project.updatedAt,
    }));
  }

  async listProjectTodoIssues(
    ref: RepoRef,
    projectNumber: number,
    params?: { limit?: number },
  ): Promise<ProjectTodoIssue[]> {
    const repo = this.resolveRepo(ref);
    const limit = Math.max(1, Math.min(params?.limit ?? 100, 100));

    type ProjectItem = {
      id: string;
      content:
        | {
            __typename: 'Issue';
            number: number;
            title: string;
            url: string;
            state: 'OPEN' | 'CLOSED';
            repository: {
              nameWithOwner: string;
            };
            labels: {
              nodes: Array<{ name: string }>;
            };
          }
        | null;
      fieldValues: {
        nodes: Array<{
          __typename: string;
          name?: string;
          field?: { name?: string };
        }>;
      };
    };

    const data = await this.octokit.graphql<{
      repository: {
        projectV2: {
          items: {
            nodes: ProjectItem[];
          };
        } | null;
      };
    }>(
      `query ProjectTodoIssues($owner: String!, $repo: String!, $number: Int!, $first: Int!) {
        repository(owner: $owner, name: $repo) {
          projectV2(number: $number) {
            items(first: $first) {
              nodes {
                id
                content {
                  __typename
                  ... on Issue {
                    number
                    title
                    url
                    state
                    repository {
                      nameWithOwner
                    }
                    labels(first: 40) {
                      nodes {
                        name
                      }
                    }
                  }
                }
                fieldValues(first: 20) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field {
                        ... on ProjectV2SingleSelectField {
                          name
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      {
        owner: repo.owner,
        repo: repo.repo,
        number: projectNumber,
        first: limit,
      },
    );

    const project = data.repository.projectV2;
    if (!project) {
      return [];
    }

    const repoFullName = `${repo.owner}/${repo.repo}`.toLowerCase();

    const items = project.items.nodes
      .filter((item) => item.content?.__typename === 'Issue')
      .map((item) => {
        const content = item.content as NonNullable<ProjectItem['content']>;
        const statusValue = item.fieldValues.nodes
          .filter((field) => field.__typename === 'ProjectV2ItemFieldSingleSelectValue')
          .find((field) => String(field.field?.name ?? '').trim().toLowerCase() === 'status');
        const statusName = statusValue?.name ? String(statusValue.name).trim() : null;
        const labels = content.labels.nodes.map((label) => label.name).filter((name) => name.length > 0);
        return {
          itemId: item.id,
          issueNumber: content.number,
          title: content.title,
          url: content.url,
          state: content.state === 'OPEN' ? ('open' as const) : ('closed' as const),
          labels,
          statusName,
          repositoryFullName: content.repository.nameWithOwner,
        };
      })
      .filter((item) => item.repositoryFullName.toLowerCase() === repoFullName)
      .filter((item) => item.state === 'open')
      .filter((item) => {
        const status = (item.statusName ?? '').toLowerCase();
        if (!status) {
          return true;
        }
        return status === 'todo' || status === 'to do' || status === 'backlog';
      })
      .sort((a, b) => a.issueNumber - b.issueNumber);

    return items.slice(0, limit);
  }
}
