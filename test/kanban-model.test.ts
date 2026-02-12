import { describe, expect, it } from 'vitest';

import { deriveLane, groupCardsByLane, projectBoardCards, type BoardCard } from '../src/ui/kanban-model.js';

const cards: BoardCard[] = [
  {
    runId: 'run-ingest',
    issueNumber: 20,
    prNumber: null,
    status: 'in_progress',
    currentStage: 'TaskRequested',
    updatedAt: '2026-02-12T00:00:00.000Z',
    taskCounts: { queued: 1, running: 0, retry: 0, completed: 0, failed: 0 },
  },
  {
    runId: 'run-review',
    issueNumber: 21,
    prNumber: 40,
    status: 'in_progress',
    currentStage: 'PRReviewed',
    updatedAt: '2026-02-12T00:10:00.000Z',
    taskCounts: { queued: 0, running: 0, retry: 1, completed: 2, failed: 0 },
  },
  {
    runId: 'run-done',
    issueNumber: 22,
    prNumber: 41,
    status: 'completed',
    currentStage: 'MergeDecision',
    updatedAt: '2026-02-12T00:20:00.000Z',
    taskCounts: { queued: 0, running: 0, retry: 0, completed: 3, failed: 0 },
  },
];

describe('kanban model', () => {
  it('derives lanes from status and stage', () => {
    expect(deriveLane(cards[0]!)).toBe('ingest');
    expect(deriveLane(cards[1]!)).toBe('review');
    expect(deriveLane(cards[2]!)).toBe('done');
  });

  it('applies query/lane/status filters and sorts newest first', () => {
    const projected = projectBoardCards(cards, {
      query: '#2',
      lane: 'review',
      status: 'in_progress',
    });
    expect(projected).toHaveLength(1);
    expect(projected[0]).toBeDefined();
    expect(projected[0]!.runId).toBe('run-review');

    const sorted = projectBoardCards(cards, {});
    expect(sorted.map((c) => c.runId)).toEqual(['run-done', 'run-review', 'run-ingest']);
  });

  it('groups projected cards by lane buckets', () => {
    const grouped = groupCardsByLane(projectBoardCards(cards, {}));
    expect(grouped.ingest).toHaveLength(1);
    expect(grouped.review).toHaveLength(1);
    expect(grouped.done).toHaveLength(1);
  });
});
