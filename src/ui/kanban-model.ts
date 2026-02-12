export type BoardCard = {
  runId: string;
  issueNumber: number | null;
  prNumber: number | null;
  status: string;
  currentStage: string;
  updatedAt: string;
  taskCounts: {
    queued: number;
    running: number;
    retry: number;
    completed: number;
    failed: number;
  };
};

export type BoardLane = {
  id: string;
  title: string;
  description: string;
};

export type BoardFilters = {
  query?: string;
  lane?: string;
  status?: string;
};

export type ProjectedBoardCard = BoardCard & {
  lane: string;
};

export const BOARD_LANES: BoardLane[] = [
  { id: 'ingest', title: 'Ingest', description: 'Webhook intake and spec setup.' },
  { id: 'execute', title: 'Execute', description: 'Tasks dispatched and running.' },
  { id: 'review', title: 'Review', description: 'PR and merge-decision phase.' },
  { id: 'blocked', title: 'Blocked', description: 'Dead-letter or failed orchestration.' },
  { id: 'done', title: 'Done', description: 'Completed workflow runs.' },
];

export function deriveLane(card: BoardCard): string {
  if (card.status === 'completed') {
    return 'done';
  }

  if (card.status === 'dead_letter' || card.currentStage === 'DeadLetter') {
    return 'blocked';
  }

  if (card.currentStage === 'PRReviewed' || card.currentStage === 'MergeDecision') {
    return 'review';
  }

  if (card.currentStage === 'SubtasksDispatched') {
    return 'execute';
  }

  if (card.currentStage === 'TaskRequested' || card.currentStage === 'SpecGenerated') {
    return 'ingest';
  }

  return 'execute';
}

export function projectBoardCards(cards: BoardCard[], filters: BoardFilters): ProjectedBoardCard[] {
  const query = (filters.query ?? '').trim().toLowerCase();
  const lane = (filters.lane ?? '').trim();
  const status = (filters.status ?? '').trim().toLowerCase();

  return cards
    .map((card) => ({ ...card, lane: deriveLane(card) }))
    .filter((card) => (lane ? card.lane === lane : true))
    .filter((card) => (status ? card.status.toLowerCase() === status : true))
    .filter((card) => {
      if (!query) {
        return true;
      }

      const searchable = [
        card.runId,
        card.issueNumber ? `#${card.issueNumber}` : '',
        card.prNumber ? `#${card.prNumber}` : '',
        card.status,
        card.currentStage,
      ]
        .join(' ')
        .toLowerCase();

      return searchable.includes(query);
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function groupCardsByLane(cards: ProjectedBoardCard[]): Record<string, ProjectedBoardCard[]> {
  const grouped: Record<string, ProjectedBoardCard[]> = {};
  for (const lane of BOARD_LANES) {
    grouped[lane.id] = [];
  }

  for (const card of cards) {
    const laneCards = grouped[card.lane] ?? (grouped[card.lane] = []);
    laneCards.push(card);
  }

  return grouped;
}
