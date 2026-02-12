import { escapeHtml } from '../lib/format.js';

const RUN_IDS_KEY = 'ralph.ui.inspect.runIds';
const TASK_IDS_KEY = 'ralph.ui.inspect.taskIds';

function loadIds(key) {
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function saveIds(key, values) {
  window.localStorage.setItem(key, JSON.stringify(values.slice(0, 120)));
}

function upsertId(key, value) {
  const id = String(value ?? '').trim();
  if (!id) {
    return null;
  }
  const next = [id, ...loadIds(key).filter((item) => item !== id)];
  saveIds(key, next);
  return id;
}

function renderSelect(selectEl, ids, placeholder, selected) {
  selectEl.innerHTML = ['<option value="">' + escapeHtml(placeholder) + '</option>']
    .concat(
      ids.map(
        (id) => `<option value="${escapeHtml(id)}" ${selected === id ? 'selected' : ''}>${escapeHtml(id)}</option>`,
      ),
    )
    .join('');
}

export function refreshInspectDropdowns(dom, state) {
  const runIds = loadIds(RUN_IDS_KEY);
  const taskIds = loadIds(TASK_IDS_KEY);
  renderSelect(dom.runId, runIds, 'Select run ID', state.inspect.selectedRunId);
  renderSelect(dom.taskId, taskIds, 'Select task ID', state.inspect.selectedTaskId);
}

export async function loadRecentRuns(apiClient, state, dom, notify) {
  let payload;
  try {
    payload = await apiClient.get('/api/v1/runs/recent?limit=80');
  } catch {
    payload = await apiClient.get('/api/runs?limit=80');
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  for (const item of items) {
    if (item?.id) {
      upsertId(RUN_IDS_KEY, item.id);
    }
  }
  refreshInspectDropdowns(dom, state);
  notify(`Loaded ${items.length} recent runs.`, false);
}

export async function loadRecentTasks(apiClient, state, dom, notify) {
  let payload;
  try {
    payload = await apiClient.get('/api/v1/tasks/recent?limit=120');
  } catch {
    payload = await apiClient.get('/api/tasks?limit=120');
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  for (const item of items) {
    if (item?.id) {
      upsertId(TASK_IDS_KEY, item.id);
    }
  }
  refreshInspectDropdowns(dom, state);
  notify(`Loaded ${items.length} recent tasks.`, false);
}

export function addRunId(value, state, dom) {
  const id = upsertId(RUN_IDS_KEY, value);
  if (!id) {
    return null;
  }
  state.inspect.selectedRunId = id;
  refreshInspectDropdowns(dom, state);
  return id;
}

export function addTaskId(value, state, dom) {
  const id = upsertId(TASK_IDS_KEY, value);
  if (!id) {
    return null;
  }
  state.inspect.selectedTaskId = id;
  refreshInspectDropdowns(dom, state);
  return id;
}

export async function fetchRun(apiClient, state, dom) {
  const runId = String(dom.runId.value ?? '').trim();
  if (!runId) {
    dom.runResult.textContent = 'Select a run ID first.';
    return;
  }

  dom.runResult.textContent = 'Loading...';
  const run = await apiClient.get(`/api/runs/${encodeURIComponent(runId)}`);
  dom.runResult.textContent = JSON.stringify(run, null, 2);

  upsertId(RUN_IDS_KEY, runId);
  if (Array.isArray(run?.tasks)) {
    for (const task of run.tasks) {
      if (task?.id) {
        upsertId(TASK_IDS_KEY, task.id);
      }
    }
  }
  state.inspect.selectedRunId = runId;
  refreshInspectDropdowns(dom, state);
}

export async function fetchTask(apiClient, state, dom, callbacks) {
  const taskId = String(dom.taskId.value ?? '').trim();
  if (!taskId) {
    dom.taskResult.textContent = 'Select a task ID first.';
    return;
  }

  dom.taskResult.textContent = 'Loading...';
  const task = await apiClient.get(`/api/tasks/${encodeURIComponent(taskId)}`);
  dom.taskResult.textContent = JSON.stringify(task, null, 2);
  upsertId(TASK_IDS_KEY, taskId);
  state.inspect.selectedTaskId = taskId;
  refreshInspectDropdowns(dom, state);

  if (task?.id) {
    callbacks.onTaskSelected(task.id);
  }
}
