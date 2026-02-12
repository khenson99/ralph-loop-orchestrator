import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import type { ClaudeAdapter } from '../integrations/anthropic/claude.js';
import type { CodexAdapter } from '../integrations/openai/codex.js';
import type { GitHubClient } from '../integrations/github/client.js';
import {
  retriesTotal,
  workflowRunDurationMs,
  workflowRunsTotal,
} from '../lib/metrics.js';
import { RetryExhaustedError, withRetry } from '../lib/retry.js';
import type { WebhookEventEnvelope } from '../schemas/contracts.js';
import { classifyError } from './stages.js';
import type { WorkflowRepository } from '../state/repository.js';

export type EnqueuePayload = {
  eventId: string;
  envelope: WebhookEventEnvelope;
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

    try {
      runId = await this.repo.createWorkflowRun({
        issueNumber,
        externalTaskRef: item.envelope.event_id,
      });
      await this.repo.linkEventToRun(item.eventId, runId);
      // createWorkflowRun already sets currentStage to 'TaskRequested'

      const issue = await this.github.getIssueContext(issueNumber);
      const baselineCommit = await this.github.getBranchSha(this.config.github.baseBranch);

      const specRetry = await withRetry(
        async (attempt) => {
          if (attempt > 1) {
            retriesTotal.inc({ operation: 'codex.generateFormalSpec' });
          }
          return this.codex.generateFormalSpec({
            repo: `${issue.owner}/${issue.repo}`,
            issueNumber: issue.issueNumber,
            issueTitle: issue.title,
            issueBody: issue.body,
            baselineCommit,
          });
        },
        { retries: 2, baseDelayMs: 500, maxDelayMs: 2500, classifyError },
      );
      const specResult = specRetry.value;

      await this.repo.storeSpec(runId, specResult.spec.spec_id, specResult.rawYaml);
      await this.repo.addArtifact({
        workflowRunId: runId,
        kind: 'formal_spec',
        content: specResult.rawYaml,
        metadata: { specId: specResult.spec.spec_id },
      });

      await this.repo.createTasks(
        runId,
        specResult.spec.work_breakdown.map((itemWork) => ({
          taskKey: itemWork.id,
          title: itemWork.title,
          ownerRole: itemWork.owner_role,
          definitionOfDone: itemWork.definition_of_done,
          dependsOn: itemWork.depends_on,
        })),
      );
      await this.repo.updateRunStage(runId, 'SubtasksDispatched');

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

                return this.claude.executeSubtask({
                  taskId: task.taskKey,
                  taskTitle: task.title,
                  ownerRole: task.ownerRole,
                  spec: specResult.spec,
                });
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

      await this.repo.updateRunStage(runId, 'PRReviewed');
      const runView = await this.repo.getRunView(runId);
      const agentOutputs = (runView?.tasks ?? []).map(
        (task) => `${task.taskKey} (${task.status}, attempts=${task.attempts})`,
      );

      const reviewSummary = await this.codex.summarizeReview({
        spec: specResult.spec,
        agentOutputs,
        ciSummary: 'CI summary unavailable in orchestrator context; use live checks at merge time.',
      });

      await this.repo.addArtifact({
        workflowRunId: runId,
        kind: 'review_summary',
        content: reviewSummary,
      });

      const prNumber = await this.github.findOpenPullRequestForIssue(issue.issueNumber);
      if (prNumber !== null) {
        await this.repo.setRunPrNumber(runId, prNumber);
      }
      const checksPassed =
        prNumber !== null &&
        (await this.github.hasRequiredChecksPassed(prNumber, this.config.requiredChecks));

      const mergeDecision = await this.codex.generateMergeDecision({
        reviewSummary,
        requiredChecksPassed: checksPassed,
      });
      await this.repo.addMergeDecision(runId, prNumber, mergeDecision);

      if (prNumber !== null) {
        if (mergeDecision.decision === 'approve') {
          await this.github.approvePullRequest(
            prNumber,
            `Automated review approval for run ${runId}.\n\n${mergeDecision.rationale}`,
          );

          if (this.config.autoMergeEnabled && checksPassed) {
            await this.github.enableAutoMerge(prNumber);
          }
        } else if (mergeDecision.decision === 'request_changes' || mergeDecision.decision === 'block') {
          await this.github.requestChanges(
            prNumber,
            `Automated review requests changes for run ${runId}.\n\n${mergeDecision.rationale}\n\n${mergeDecision.blocking_findings
              .map((f) => `- ${f}`)
              .join('\n')}`,
          );
        }
      } else {
        await this.github.addIssueComment(
          issue.issueNumber,
          [
            `Orchestrator run ${runId} completed planning/execution but no linked open PR was found.`,
            'Open or link a PR with `Closes #<issue>` for automated review/merge.',
          ].join('\n\n'),
        );
      }

      await this.repo.updateRunStage(runId, 'MergeDecision');
      const pending = await this.repo.countPendingTasks(runId);
      const status = pending === 0 ? 'completed' : 'failed';
      await this.repo.markRunStatus(runId, status);
      workflowRunsTotal.inc({ status });

      await this.repo.markEventProcessed(item.eventId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown run failure';
      this.logger.error(
        {
          err: error,
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
}
