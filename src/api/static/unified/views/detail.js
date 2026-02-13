import { escapeHtml, formatDate, statusPillClass } from '../lib/format.js';
import { renderAgentControl } from '../components/agent-control.js';

function groupedTimeline(events) {
  const groups = new Map();
  for (const event of events) {
    const prefix = String(event.event_type).split('.')[0] || 'other';
    if (!groups.has(prefix)) {
      groups.set(prefix, []);
    }
    groups.get(prefix).push(event);
  }
  return [...groups.entries()];
}

export function renderDetail(dom, state, callbacks) {
  const detail = state.detail;
  if (!detail) {
    dom.detailTitle.textContent = 'Select a card';
    dom.detailMeta.innerHTML = '';
    dom.detailLinks.innerHTML = '';
    dom.detailBody.innerHTML = '<div class="pill">No detail loaded.</div>';
    if (dom.agentControlRegion) {
      dom.agentControlRegion.innerHTML = '';
    }
    return;
  }

  const card = detail.card;
  dom.detailTitle.textContent = card.title;

  // Update aria-label on the detail region for screen readers
  if (dom.cardRegion) {
    dom.cardRegion.setAttribute('aria-label', `Task detail: ${card.title}`);
  }
  dom.detailMeta.innerHTML = `
    <span class="pill">${escapeHtml(card.card_id)}</span>
    <span class="pill">${escapeHtml(card.lane)}</span>
    <span class="pill">${escapeHtml(detail.task.owner_role)}</span>
    <span class="pill">updated: ${escapeHtml(formatDate(card.timestamps.last_updated_at))}</span>
  `;

  const links = [];
  if (card.links.github_issue_url) {
    links.push(
      `<a class="pill" target="_blank" rel="noreferrer" href="${escapeHtml(card.links.github_issue_url)}">Issue</a>`,
    );
  }
  if (card.links.pull_request_url) {
    links.push(`<a class="pill" id="prLink" target="_blank" rel="noreferrer" href="${escapeHtml(card.links.pull_request_url)}">PR</a>`);
  }
  dom.detailLinks.innerHTML = links.join('');

  if (dom.agentControlRegion) {
    renderAgentControl(dom.agentControlRegion, {
      me: state.me,
      detail: state.detail,
      onAction: callbacks.onAgentAction,
    });
  }

  dom.detailBody.innerHTML = renderPanelBody(detail, state.detailPanel);

  dom.detailBody.querySelectorAll('[data-detail-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-detail-action');
      if (action) {
        callbacks.onDetailAction(action);
      }
    });
  });
}

function renderPanelBody(detail, panel) {
  if (panel === 'timeline') {
    const groups = groupedTimeline(detail.timeline);
    if (groups.length === 0) {
      return '<div class="pill">No timeline events.</div>';
    }
    return groups
      .map(([group, events]) => {
        const rendered = events
          .map(
            (event) => `
            <article class="event">
              <strong>${escapeHtml(event.message)}</strong>
              <div class="event-meta">${escapeHtml(formatDate(event.occurred_at))} · ${escapeHtml(
                event.actor.id,
              )} · ${escapeHtml(event.event_type)}</div>
              <pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
            </article>
          `,
          )
          .join('');
        return `<section><h4 class="group-title">${escapeHtml(group)}</h4>${rendered}</section>`;
      })
      .join('');
  }

  if (panel === 'spec') {
    const specArtifact = detail.artifacts.find((artifact) => artifact.kind.includes('spec'));
    return `<pre>${escapeHtml(specArtifact?.content ?? 'No spec artifact found.')}</pre>`;
  }

  if (panel === 'logs') {
    const lines = detail.attempts.map((attempt) => ({
      agent: attempt.agent_role,
      status: attempt.status,
      created_at: attempt.created_at,
      error: attempt.error,
      duration_ms: attempt.duration_ms,
      output: attempt.output,
    }));
    return `<pre>${escapeHtml(JSON.stringify(lines, null, 2))}</pre>`;
  }

  if (!detail.pull_request) {
    const fallback = {
      issue_url: detail.card.links.github_issue_url,
      pr_url: detail.card.links.pull_request_url,
      ci_status: detail.card.signals.ci_status,
      llm_review_verdict: detail.card.signals.llm_review_verdict,
      run_stage: detail.run.current_stage,
    };
    return `<pre>${escapeHtml(JSON.stringify(fallback, null, 2))}</pre>`;
  }

  const checks = detail.pull_request.checks;
  const renderedChecks =
    checks.length === 0
      ? '<div class="pill">No check runs found for this PR head.</div>'
      : checks
          .map((check) => {
            const pillClass = statusPillClass(check.conclusion === 'success' ? 'passing' : 'failing', 'in_review');
            return `
              <article class="event">
                <strong>${escapeHtml(check.name)} ${check.required ? '(required)' : ''}</strong>
                <div class="event-meta">${escapeHtml(check.status)} · ${escapeHtml(check.conclusion ?? 'pending')}</div>
                <div class="pill-row">
                  <span class="pill ${pillClass}">${escapeHtml(check.conclusion ?? 'pending')}</span>
                  ${
                    check.details_url
                      ? `<a class="pill" target="_blank" rel="noreferrer" href="${escapeHtml(check.details_url)}">details</a>`
                      : ''
                  }
                </div>
              </article>
            `;
          })
          .join('');

  const statusClass = statusPillClass(detail.pull_request.overall_status, 'in_review');
  return `
    <div class="pill-row">
      <a class="pill" target="_blank" rel="noreferrer" href="${escapeHtml(detail.pull_request.url)}">PR #${
        detail.pull_request.number
      }</a>
      <span class="pill">${escapeHtml(detail.pull_request.state)}</span>
      <span class="pill ${statusClass}">ci: ${escapeHtml(detail.pull_request.overall_status)}</span>
      <span class="pill">mergeable: ${escapeHtml(String(detail.pull_request.mergeable))}</span>
    </div>
    ${renderedChecks}
  `;
}
