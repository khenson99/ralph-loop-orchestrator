import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import type { ClaudeAdapter } from '../integrations/anthropic/claude.js';
import type { CodexAdapter } from '../integrations/openai/codex.js';
import type { GitHubClient } from '../integrations/github/client.js';
import {
  orchestrationBoundaryCallsTotal,
  orchestrationBoundaryDurationMs,
  retriesTotal,
  workflowRunDurationMs,
  workflowRunsTotal,
} from '../lib/metrics.js';
import { redactSecretsInText } from '../lib/redaction.js';
import { RetryExhaustedError, withRetry } from '../lib/retry.js';
import { withSpan } from '../lib/telemetry.js';
import type { WebhookEventEnvelope } from '../schemas/contracts.js';
import { classifyError } from './stages.js';
import { formatDeadLetterReason } from '../lib/errors.js';
import type { WorkflowRepository } from '../state/repository.js';

export type EnqueuePayload = {
  eventId: string;
  envelope: WebhookEventEnvelope;
};

type BoundaryContext = {
  eventId: string;
  runId?: string;
  issueNumber: number;
  taskKey?: string;
};

export class OrchestratorService {
  private readonly queue: EnqueuePayload[] = [];
  private processing = false;

  constructor(
    private readonly repo: WorkflowRepository,
    private readonly github: GitHubClient,
    private readonly codex: CodexAdapter,
    private readonly claude: ClaudeAdapter,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  enqueue(item: EnqueuePayload): void {
    this.queue.push(item);
    if (!this.processing) {
      void this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) {
        continue;
      }

      try {
        await this.handleEvent(item);
      } catch (error) {
        this.logger.error({ err: error }, 'Failed to process queued event');
      }
    }

    this.processing = false;
  }

  private async handleEvent(item: EnqueuePayload): Promise<void> {
    const start = Date.now();
    let runId = '';
    const issueNumber = item.envelope.task_ref.id;
    const baseContext: BoundaryContext = {
      eventId: item.eventId,
      issueNumber,
    };

    try {
      runId = await this.runBoundary('repo.create_workflow_run', baseContext, () =>
        this.repo.createWorkflowRun({
          issueNumber,
          externalTaskRef: item.envelope.event_id,
        }),
      );
      await this.runBoundary('repo.link_event_to_run', { ...baseContext, runId }, () =>
        this.repo.linkEventToRun(item.eventId, runId),
      );
      // createWorkflowRun already sets currentStage to 'TaskRequested'

      const issue = await this.runBoundary('github.get_issue_context', { ...baseContext, runId }, () =>
        this.github.getIssueContext(issueNumber),
      );
      const baselineCommit = await this.runBoundary('github.get_branch_sha', { ...baseContext, runId }, () =>
        this.github.getBranchSha(this.config.github.baseBranch),
      );

      const specRetry = await withRetry(
        async (attempt) => {
          if (attempt > 1) {
            retriesTotal.inc({ operation: 'codex.generateFormalSpec' });
          }
          return this.runBoundary('codex.generate_formal_spec', { ...baseContext, runId }, () =>
            this.codex.generateFormalSpec({
              repo: `${issue.owner}/${issue.repo}`,
              issueNumber: issue.issueNumber,
              issueTitle: issue.title,
              issueBody: issue.body,
              baselineCommit,
            }),
          );
        },
        { retries: 2, baseDelayMs: 500, maxDelayMs: 2500, classifyError },
      );
      const specResult = specRetry.value;

      await this.runBoundary('repo.store_spec', { ...baseContext, runId }, () =>
        this.repo.storeSpec(runId, specResult.spec.spec_id, specResult.rawYaml),
      );
      await this.runBoundary('repo.add_artifact.formal_spec', { ...baseContext, runId }, () =>
        this.repo.addArtifact({
          workflowRunId: runId,
          kind: 'formal_spec',
          content: specResult.rawYaml,
          metadata: { specId: specResult.spec.spec_id },
        }),
      );

      await this.runBoundary('repo.create_tasks', { ...baseContext, runId }, () =>
        this.repo.createTasks(
          runId,
          specResult.spec.work_breakdown.map((itemWork) => ({
            taskKey: itemWork.id,
            title: itemWork.title,
            ownerRole: itemWork.owner_role,
            definitionOfDone: itemWork.definition_of_done,
            dependsOn: itemWork.depends_on,
          })),
        ),
      );
      await this.runBoundary('repo.update_run_stage', { ...baseContext, runId }, () =>
        this.repo.updateRunStage(runId, 'SubtasksDispatched'),
      );

      let runnable = await this.repo.listRunnableTasks(runId);
      while (runnable.length > 0) {
        for (const task of runnable) {
          await this.repo.markTaskRunning(task.id);
          const taskStart = Date.now();

          try {
            const taskRetry = await withRetry(
              async (attempt) => {
                if (attempt > 1) {
                  retriesTotal.inc({ operation: 'claude.executeSubtask' });
                }

                return this.runBoundary(
                  'claude.execute_subtask',
                  { ...baseContext, runId, taskKey: task.taskKey },
                  () =>
                    this.claude.executeSubtask({
                      taskId: task.taskKey,
                      taskTitle: task.title,
                      ownerRole: task.ownerRole,
                      spec: specResult.spec,
                    }),
                );
              },
              { retries: 2, baseDelayMs: 1000, maxDelayMs: 6000, classifyError },
            );
            const result = taskRetry.value;

            const taskStatus = result.status === 'completed' ? 'completed' : result.status;
            await this.repo.markTaskResult(task.id, result, taskStatus);
            await this.repo.addAgentAttempt({
              taskId: task.id,
              agentRole: task.ownerRole,
              attemptNumber: task.attemptCount + 1,
              status: taskStatus,
              output: result as unknown as Record<string, unknown>,
              backoffDelayMs: taskRetry.lastBackoffMs ?? undefined,
              durationMs: Date.now() - taskStart,
            });
            await this.repo.addArtifact({
              workflowRunId: runId,
              taskId: task.id,
              kind: 'agent_result',
              content: JSON.stringify(result, null, 2),
              metadata: { ownerRole: task.ownerRole },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown task failure';
            const retryMeta =
              error instanceof RetryExhaustedError
                ? {
                    attempts: error.attempts,
                    backoffDelayMs: error.lastBackoffMs ?? undefined,
                    cause: error.lastError,
                  }
                : { attempts: 1, backoffDelayMs: undefined, cause: error };

            await this.repo.addAgentAttempt({
              taskId: task.id,
              agentRole: task.ownerRole,
              attemptNumber: task.attemptCount + 1,
              status: 'failed',
              output: {
                retryAttempts: retryMeta.attempts,
                lastBackoffMs: retryMeta.backoffDelayMs ?? null,
              },
              error: message,
              errorCategory: classifyError(retryMeta.cause),
              backoffDelayMs: retryMeta.backoffDelayMs,
              durationMs: Date.now() - taskStart,
            });
            await this.repo.markTaskResult(
              task.id,
              {
                task_id: task.taskKey,
                status: 'blocked',
                summary: message,
                files_changed: [],
                commands_ran: [],
                open_questions: [],
                handoff_notes: '',
              },
              'retry',
            );
          }
        }

        runnable = await this.repo.listRunnableTasks(runId);
      }

      await this.runBoundary('repo.update_run_stage', { ...baseContext, runId }, () =>
        this.repo.updateRunStage(runId, 'PRReviewed'),
      );
      const runView = await this.repo.getRunView(runId);
      const agentOutputs = (runView?.tasks ?? []).map(
        (task) => `${task.taskKey} (${task.status}, attempts=${task.attempts})`,
      );

      const reviewSummary = await this.runBoundary('codex.summarize_review', { ...baseContext, runId }, () =>
        this.codex.summarizeReview({
          spec: specResult.spec,
          agentOutputs,
          ciSummary: 'CI summary unavailable in orchestrator context; use live checks at merge time.',
        }),
      );

      await this.runBoundary('repo.add_artifact.review_summary', { ...baseContext, runId }, () =>
        this.repo.addArtifact({
          workflowRunId: runId,
          kind: 'review_summary',
          content: reviewSummary,
        }),
      );

      const prNumber = await this.runBoundary('github.find_open_pr_for_issue', { ...baseContext, runId }, () =>
        this.github.findOpenPullRequestForIssue(issue.issueNumber),
      );
      if (prNumber !== null) {
        await this.runBoundary('repo.set_run_pr_number', { ...baseContext, runId }, () =>
          this.repo.setRunPrNumber(runId, prNumber),
        );
      }
      const checksPassed =
        prNumber !== null &&
        (await this.runBoundary('github.has_required_checks_passed', { ...baseContext, runId }, () =>
          this.github.hasRequiredChecksPassed(prNumber, this.config.requiredChecks),
        ));

      const mergeDecision = await this.runBoundary('codex.generate_merge_decision', { ...baseContext, runId }, () =>
        this.codex.generateMergeDecision({
          reviewSummary,
          requiredChecksPassed: checksPassed,
        }),
      );
      await this.runBoundary('repo.add_merge_decision', { ...baseContext, runId }, () =>
        this.repo.addMergeDecision(runId, prNumber, mergeDecision),
      );

      if (prNumber !== null) {
        const safeRationale = redactSecretsInText(mergeDecision.rationale);
        const safeFindings = mergeDecision.blocking_findings.map((item) => redactSecretsInText(item));

        if (mergeDecision.decision === 'approve') {
          await this.runBoundary('github.approve_pull_request', { ...baseContext, runId }, () =>
            this.github.approvePullRequest(
              prNumber,
              `Automated review approval for run ${runId}.\n\n${safeRationale}`,
            ),
          );

          if (this.config.autoMergeEnabled && checksPassed) {
            await this.runBoundary('github.enable_auto_merge', { ...baseContext, runId }, () =>
              this.github.enableAutoMerge(prNumber),
            );
          }
        } else if (mergeDecision.decision === 'request_changes' || mergeDecision.decision === 'block') {
          await this.runBoundary('github.request_changes', { ...baseContext, runId }, () =>
            this.github.requestChanges(
              prNumber,
              `Automated review requests changes for run ${runId}.\n\n${safeRationale}\n\n${safeFindings
                .map((f) => `- ${f}`)
                .join('\n')}`,
            ),
          );
        }
      } else {
        await this.runBoundary('github.add_issue_comment', { ...baseContext, runId }, () =>
          this.github.addIssueComment(
            issue.issueNumber,
            [
              `Orchestrator run ${runId} completed planning/execution but no linked open PR was found.`,
              'Open or link a PR with `Closes #<issue>` for automated review/merge.',
            ].join('\n\n'),
          ),
        );
      }

      await this.runBoundary('repo.update_run_stage', { ...baseContext, runId }, () =>
        this.repo.updateRunStage(runId, 'MergeDecision'),
      );
      const pending = await this.repo.countPendingTasks(runId);
      const status = pending === 0 ? 'completed' : 'failed';
      await this.repo.markRunStatus(runId, status);
      workflowRunsTotal.inc({ status });

      await this.repo.markEventProcessed(item.eventId);
    } catch (error) {
      const message = redactSecretsInText(formatDeadLetterReason(error));
      this.logger.error(
        {
          error_name: error instanceof Error ? error.name : 'unknown_error',
          error_message: message,
          event_id: item.envelope.event_id,
          run_id: runId,
          task_id: issueNumber,
        },
        'Workflow run failed',
      );

      if (runId) {
        await this.repo.markRunStatus(runId, 'dead_letter', message);
      }
      await this.repo.markEventProcessed(item.eventId, message);
      workflowRunsTotal.inc({ status: 'dead_letter' });
    } finally {
      workflowRunDurationMs.observe(Date.now() - start);
    }
  }

  private async runBoundary<T>(
    boundary: string,
    context: BoundaryContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    return withSpan(
      `orchestrator.${boundary}`,
      {
        tracerName: 'ralph-loop-orchestrator.orchestrator',
        attributes: {
          boundary,
          correlation_event_id: context.eventId,
          run_id: context.runId ?? '',
          issue_number: context.issueNumber,
          task_key: context.taskKey ?? '',
        },
      },
      async () => {
        try {
          const result = await fn();
          orchestrationBoundaryCallsTotal.inc({ boundary, result: 'success' });
          this.logger.debug(
            {
              boundary,
              event_id: context.eventId,
              run_id: context.runId,
              issue_number: context.issueNumber,
              task_key: context.taskKey,
            },
            'Boundary call succeeded',
          );
          return result;
        } catch (error) {
          orchestrationBoundaryCallsTotal.inc({ boundary, result: 'error' });
          this.logger.warn(
            {
              boundary,
              event_id: context.eventId,
              run_id: context.runId,
              issue_number: context.issueNumber,
              task_key: context.taskKey,
              err: error,
            },
            'Boundary call failed',
          );
          throw error;
        } finally {
          orchestrationBoundaryDurationMs.observe({ boundary }, Date.now() - startedAt);
        }
      },
    );
  }
}
