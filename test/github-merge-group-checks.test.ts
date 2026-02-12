import { describe, expect, it, vi } from 'vitest';

import { GitHubClient } from '../src/integrations/github/client.js';

function createClientHarness(params: { mergeCommitSha: string | null }) {
  const client = new GitHubClient({
    webhookSecret: 'secret',
    targetOwner: 'khenson99',
    targetRepo: 'ralph-loop-orchestrator',
    baseBranch: 'main',
    token: 'gh-token',
  });

  const pullsGet = vi.fn().mockResolvedValue({
    data: {
      head: { sha: 'head-sha' },
      merge_commit_sha: params.mergeCommitSha,
    },
  });
  const checksListForRef = vi.fn();
  const getCombinedStatusForRef = vi.fn();

  (
    client as unknown as {
      octokit: {
        rest: {
          pulls: { get: typeof pullsGet };
          checks: { listForRef: typeof checksListForRef };
          repos: { getCombinedStatusForRef: typeof getCombinedStatusForRef };
        };
      };
    }
  ).octokit = {
    rest: {
      pulls: { get: pullsGet },
      checks: { listForRef: checksListForRef },
      repos: { getCombinedStatusForRef },
    },
  };

  return {
    client,
    pullsGet,
    checksListForRef,
    getCombinedStatusForRef,
  };
}

describe('GitHubClient merge-queue required check handling', () => {
  it('passes when required checks succeed on PR head ref', async () => {
    const { client, checksListForRef, getCombinedStatusForRef } = createClientHarness({
      mergeCommitSha: null,
    });

    checksListForRef.mockResolvedValue({
      data: {
        check_runs: [
          { name: 'CI / Tests', status: 'completed', conclusion: 'success' },
          { name: 'CI / Lint + Typecheck', status: 'completed', conclusion: 'success' },
        ],
      },
    });
    getCombinedStatusForRef.mockResolvedValue({ data: { statuses: [] } });

    await expect(
      client.hasRequiredChecksPassed(123, ['CI / Tests', 'CI / Lint + Typecheck']),
    ).resolves.toBe(true);
  });

  it('passes when required checks succeed on merge_group ref even if head ref is pending', async () => {
    const { client, checksListForRef, getCombinedStatusForRef } = createClientHarness({
      mergeCommitSha: 'merge-sha',
    });

    checksListForRef.mockImplementation(async ({ ref }: { ref: string }) => {
      if (ref === 'head-sha') {
        return {
          data: {
            check_runs: [
              { name: 'CI / Tests', status: 'in_progress', conclusion: null },
              { name: 'CI / Lint + Typecheck', status: 'in_progress', conclusion: null },
            ],
          },
        };
      }

      return {
        data: {
          check_runs: [
            { name: 'CI / Tests', status: 'completed', conclusion: 'success' },
            { name: 'CI / Lint + Typecheck', status: 'completed', conclusion: 'success' },
          ],
        },
      };
    });
    getCombinedStatusForRef.mockResolvedValue({ data: { statuses: [] } });

    await expect(
      client.hasRequiredChecksPassed(123, ['CI / Tests', 'CI / Lint + Typecheck']),
    ).resolves.toBe(true);

    expect(checksListForRef).toHaveBeenCalledTimes(2);
    expect(checksListForRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'merge-sha' }),
    );
  });

  it('accepts required checks satisfied via status contexts on merge_group ref', async () => {
    const { client, checksListForRef, getCombinedStatusForRef } = createClientHarness({
      mergeCommitSha: 'merge-sha',
    });

    checksListForRef.mockResolvedValue({ data: { check_runs: [] } });
    getCombinedStatusForRef.mockImplementation(async ({ ref }: { ref: string }) => {
      if (ref === 'merge-sha') {
        return {
          data: {
            statuses: [{ context: 'CI / Tests', state: 'success' }],
          },
        };
      }
      return {
        data: {
          statuses: [{ context: 'CI / Tests', state: 'pending' }],
        },
      };
    });

    await expect(client.hasRequiredChecksPassed(123, ['CI / Tests'])).resolves.toBe(true);
  });

  it('fails when any required check is missing across head and merge refs', async () => {
    const { client, checksListForRef, getCombinedStatusForRef } = createClientHarness({
      mergeCommitSha: 'merge-sha',
    });

    checksListForRef.mockResolvedValue({
      data: {
        check_runs: [{ name: 'CI / Tests', status: 'completed', conclusion: 'success' }],
      },
    });
    getCombinedStatusForRef.mockResolvedValue({ data: { statuses: [] } });

    await expect(
      client.hasRequiredChecksPassed(123, ['CI / Tests', 'CI / Lint + Typecheck']),
    ).resolves.toBe(false);
  });
});
