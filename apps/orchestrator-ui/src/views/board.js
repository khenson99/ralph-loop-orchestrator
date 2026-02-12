import { agingClass, escapeHtml, hoursSince, statusPillClass } from '../lib/format.js';

const LANE_ORDER = [
  { id: 'intake', label: 'Intake', wip: 20 },
  { id: 'spec_drafting', label: 'Spec Drafting', wip: 10 },
  { id: 'ready', label: 'Ready', wip: 20 },
  { id: 'in_progress', label: 'In Progress', wip: 10 },
  { id: 'in_review', label: 'In Review', wip: 10 },
  { id: 'blocked', label: 'Blocked', wip: 99 },
  { id: 'done', label: 'Done', wip: 99 },
];

export function getLaneOrder() {
  return LANE_ORDER;
}

export function applyBoardFilters(cards, filters, incidentMode) {
  const search = String(filters.search ?? '').trim().toLowerCase();
  const repo = String(filters.repo ?? '').trim();
  const owner = String(filters.owner ?? '').trim();
  const lane = String(filters.lane ?? '').trim();

  return cards.filter((card) => {
    if (search) {
      const haystack = [card.title, card.card_id, card.owner.display_name, ...(card.tags ?? [])]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }

    if (owner && card.owner.display_name !== owner) {
      return false;
    }

    if (repo && card.source?.full_name !== repo) {
      return false;
    }

    if (lane && card.lane !== lane) {
      return false;
    }

    if (incidentMode) {
      const humanNeeded =
        card.lane === 'blocked' ||
        card.signals.ci_status === 'failing' ||
        card.signals.llm_review_verdict === 'needs_changes' ||
        card.signals.human_review_state === 'requested';
      if (!humanNeeded) {
        return false;
      }
    }

    return true;
  });
}

function sortCards(cards, sortBy) {
  const mode = String(sortBy ?? 'updated_desc');
  const sorted = [...cards];
  switch (mode) {
    case 'repo_asc':
      sorted.sort((a, b) => String(a.source?.full_name ?? '').localeCompare(String(b.source?.full_name ?? '')));
      break;
    case 'repo_desc':
      sorted.sort((a, b) => String(b.source?.full_name ?? '').localeCompare(String(a.source?.full_name ?? '')));
      break;
    case 'title_asc':
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'updated_desc':
    default:
      sorted.sort((a, b) => Date.parse(b.timestamps.last_updated_at) - Date.parse(a.timestamps.last_updated_at));
      break;
  }
  return sorted;
}

export function computeNeedsHumanQueue(cards) {
  return cards
    .filter(
      (card) =>
        card.lane === 'blocked' ||
        card.signals.ci_status === 'failing' ||
        card.signals.llm_review_verdict === 'needs_changes' ||
        card.signals.human_review_state === 'requested',
    )
    .sort((a, b) => new Date(b.timestamps.last_updated_at).getTime() - new Date(a.timestamps.last_updated_at).getTime())
    .slice(0, 20);
}

export function renderBoard(dom, state, callbacks) {
  const board = state.board;
  if (!board) {
    dom.lanes.innerHTML = '<div class="pill">No board data loaded.</div>';
    dom.needsHumanQueue.innerHTML = '<div class="pill">No data.</div>';
    return;
  }

  const cards = Object.values(board.cards);
  const filtered = sortCards(
    applyBoardFilters(cards, state.filters, state.incidentMode),
    state.filters.sort,
  );
  const grouped = new Map(LANE_ORDER.map((lane) => [lane.id, []]));

  for (const card of filtered) {
    if (!grouped.has(card.lane)) {
      grouped.set(card.lane, []);
    }
    grouped.get(card.lane).push(card);
  }

  dom.lanes.innerHTML = LANE_ORDER.map((lane) => {
    const laneCards = grouped.get(lane.id) ?? [];
    const laneWarnClass = laneCards.length > lane.wip ? 'warn' : '';
    const cardMarkup =
      laneCards.length === 0
        ? '<div class="pill">No cards</div>'
        : laneCards
            .map((card) => {
              const hours = hoursSince(card.timestamps.lane_entered_at).toFixed(1);
              const ageClass = agingClass(card.timestamps.lane_entered_at);
              const statusClass = statusPillClass(card.signals.ci_status, card.lane);

              return `
                <button class="card ${ageClass}" data-card-id="${escapeHtml(card.card_id)}" data-selected="${
                  state.selectedCardId === card.card_id
                }" type="button">
                  <h3>${escapeHtml(card.title)}</h3>
                  <div class="pill-row">
                    <span class="pill">${escapeHtml(card.priority)}</span>
                    <span class="pill">${escapeHtml(card.owner.display_name)}</span>
                    <span class="pill">attempts: ${card.attempt.attempt_count}</span>
                  </div>
                  <div class="pill-row">
                    <span class="pill ${statusClass}">ci: ${escapeHtml(card.signals.ci_status)}</span>
                    <span class="pill">aging: ${hours}h</span>
                  </div>
                </button>
              `;
            })
            .join('');

    return `
      <section class="lane ${laneWarnClass}" role="listitem" aria-label="${lane.label}">
        <header class="lane-head">
          <span>${lane.label}</span>
          <span>${laneCards.length} / ${lane.wip}</span>
        </header>
        <div class="lane-body">${cardMarkup}</div>
      </section>
    `;
  }).join('');

  const needsHuman = computeNeedsHumanQueue(cards);
  dom.needsHumanQueue.innerHTML =
    needsHuman.length === 0
      ? '<div class="pill">No items need human intervention.</div>'
      : needsHuman
          .map(
            (card) => `
      <button type="button" class="queue-item" data-human-card-id="${escapeHtml(card.card_id)}">
        <span>${escapeHtml(card.title)}</span>
        <span class="pill ${statusPillClass(card.signals.ci_status, card.lane)}">${escapeHtml(card.lane)}</span>
      </button>
    `,
          )
          .join('');

  dom.lanes.querySelectorAll('[data-card-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const taskId = button.getAttribute('data-card-id');
      if (taskId) {
        callbacks.onSelectCard(taskId);
      }
    });
  });

  dom.needsHumanQueue.querySelectorAll('[data-human-card-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const taskId = button.getAttribute('data-human-card-id');
      if (taskId) {
        callbacks.onSelectCard(taskId, { switchToDetail: true });
      }
    });
  });

  const owners = [...new Set(cards.map((card) => card.owner.display_name))].sort((a, b) => a.localeCompare(b));
  const repos = [...new Set(cards.map((card) => String(card.source?.full_name ?? '')).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );

  const repoOptions = ['<option value="">All repos</option>']
    .concat(
      repos.map(
        (repo) =>
          `<option value="${escapeHtml(repo)}" ${state.filters.repo === repo ? 'selected' : ''}>${escapeHtml(repo)}</option>`,
      ),
    )
    .join('');
  dom.repoFilter.innerHTML = repoOptions;
  const ownerOptions = ['<option value="">All owners</option>']
    .concat(
      owners.map(
        (owner) =>
          `<option value="${escapeHtml(owner)}" ${state.filters.owner === owner ? 'selected' : ''}>${escapeHtml(owner)}</option>`,
      ),
    )
    .join('');
  dom.ownerFilter.innerHTML = ownerOptions;

  const laneOptions = ['<option value="">All lanes</option>']
    .concat(
      LANE_ORDER.map(
        (lane) =>
          `<option value="${lane.id}" ${state.filters.lane === lane.id ? 'selected' : ''}>${lane.label}</option>`,
      ),
    )
    .join('');
  dom.laneFilter.innerHTML = laneOptions;

  if (dom.sortBy) {
    dom.sortBy.value = state.filters.sort ?? 'updated_desc';
  }
}
