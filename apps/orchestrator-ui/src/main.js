import { createApiClient } from './api.js';
import { authHeaders, canPerformAction, clearIdentity, loadIdentity, saveIdentity, summarizeAuth } from './auth.js';
import { createCommandPalette } from './components/command-palette.js';
import { clearApiBase, getIncidentMode, resolveApiBase, saveApiBase, setIncidentMode } from './config.js';
import { formatDate } from './lib/format.js';
import {
  addRunId,
  addTaskId,
  fetchRun,
  fetchTask,
  loadRecentRuns,
  loadRecentTasks,
  refreshInspectDropdowns,
} from './views/inspect.js';
import { getLaneOrder, renderBoard } from './views/board.js';
import { renderDetail } from './views/detail.js';
import { refreshServiceStatus } from './views/service.js';
import { connectBoardStream } from './stream.js';

const SAVED_VIEWS_KEY = 'ralph.ui.savedViews';

const ACTIONS_FOR_BUTTON = {
  retry: ['retry'],
  reassign: ['reassign'],
  escalate: ['escalate'],
  'block-toggle': ['block', 'unblock'],
};

const dom = {
  statusApi: document.getElementById('statusApi'),
  statusAuth: document.getElementById('statusAuth'),
  statusStream: document.getElementById('statusStream'),
  statusGenerated: document.getElementById('statusGenerated'),
  statusBanner: document.getElementById('statusBanner'),
  incidentToggle: document.getElementById('incidentToggle'),
  incidentPanel: document.getElementById('incidentPanel'),
  openPalette: document.getElementById('openPalette'),

  viewButtons: [...document.querySelectorAll('.tab')],
  views: [...document.querySelectorAll('.view')],

  searchInput: document.getElementById('searchInput'),
  repoFilter: document.getElementById('repoFilter'),
  ownerFilter: document.getElementById('ownerFilter'),
  laneFilter: document.getElementById('laneFilter'),
  sortBy: document.getElementById('sortBy'),
  savedViews: document.getElementById('savedViews'),
  saveCurrentView: document.getElementById('saveCurrentView'),
  clearFilters: document.getElementById('clearFilters'),
  refreshBoard: document.getElementById('refreshBoard'),
  lanes: document.getElementById('lanes'),
  needsHumanQueue: document.getElementById('needsHumanQueue'),
  boardRegion: document.getElementById('boardRegion'),

  detailTitle: document.getElementById('detailTitle'),
  detailMeta: document.getElementById('detailMeta'),
  detailLinks: document.getElementById('detailLinks'),
  detailBody: document.getElementById('detailBody'),
  detailTabs: [...document.querySelectorAll('.detail-tab')],
  detailActions: [...document.querySelectorAll('[data-action]')],
  openInBoard: document.getElementById('openInBoard'),
  cardRegion: document.getElementById('cardRegion'),

  runId: document.getElementById('runId'),
  fetchRun: document.getElementById('fetchRun'),
  newRunId: document.getElementById('newRunId'),
  addRunId: document.getElementById('addRunId'),
  refreshRecentRuns: document.getElementById('refreshRecentRuns'),
  runResult: document.getElementById('runResult'),

  taskId: document.getElementById('taskId'),
  fetchTask: document.getElementById('fetchTask'),
  newTaskId: document.getElementById('newTaskId'),
  addTaskId: document.getElementById('addTaskId'),
  refreshRecentTasks: document.getElementById('refreshRecentTasks'),
  taskResult: document.getElementById('taskResult'),

  refreshService: document.getElementById('refreshService'),
  healthResult: document.getElementById('healthResult'),
  readyResult: document.getElementById('readyResult'),
  intakeRepoSelect: document.getElementById('intakeRepoSelect'),
  intakeProjectSelect: document.getElementById('intakeProjectSelect'),
  intakeTodoSelect: document.getElementById('intakeTodoSelect'),
  loadProjects: document.getElementById('loadProjects'),
  loadProjectTodos: document.getElementById('loadProjectTodos'),
  dispatchProjectTodos: document.getElementById('dispatchProjectTodos'),

  apiBaseInput: document.getElementById('apiBaseInput'),
  testApiBase: document.getElementById('testApiBase'),
  saveApiBase: document.getElementById('saveApiBase'),
  resetApiBase: document.getElementById('resetApiBase'),
  apiBaseResolved: document.getElementById('apiBaseResolved'),

  identityUser: document.getElementById('identityUser'),
  identityRole: document.getElementById('identityRole'),
  applyIdentity: document.getElementById('applyIdentity'),
  clearIdentity: document.getElementById('clearIdentity'),

  palette: document.getElementById('palette'),
  paletteInput: document.getElementById('paletteInput'),
  paletteList: document.getElementById('paletteList'),
};

const state = {
  api: resolveApiBase(),
  activeView: 'board',
  board: null,
  detail: null,
  selectedCardId: null,
  detailPanel: 'timeline',
  me: null,
  identity: loadIdentity(),
  filters: {
    search: '',
    repo: '',
    owner: '',
    lane: '',
    sort: 'updated_desc',
  },
  intake: {
    repos: [],
    selectedRepo: '',
    projects: [],
    selectedProjectNumber: null,
    todos: [],
  },
  incidentMode: getIncidentMode(),
  streamStatus: 'connecting',
  streamHandle: null,
  pollTimer: null,
  inspect: {
    selectedRunId: '',
    selectedTaskId: '',
  },
  savedViews: loadSavedViews(),
};

const apiClient = createApiClient({
  getApiBase: () => state.api.value,
  getAuthHeaders: () => authHeaders(state.identity),
});

function loadSavedViews() {
  const raw = window.localStorage.getItem(SAVED_VIEWS_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item) => item && typeof item.name === 'string' && item.filters)
      .slice(0, 50)
      .map((item, index) => ({
        id: String(item.id ?? `view-${index}`),
        name: String(item.name),
        filters: {
          search: String(item.filters.search ?? ''),
          repo: String(item.filters.repo ?? ''),
          owner: String(item.filters.owner ?? ''),
          lane: String(item.filters.lane ?? ''),
          sort: String(item.filters.sort ?? 'updated_desc'),
        },
      }));
  } catch {
    return [];
  }
}

function persistSavedViews() {
  window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(state.savedViews));
}

function setBanner(message, visible = true) {
  dom.statusBanner.textContent = message;
  dom.statusBanner.dataset.visible = visible ? 'true' : 'false';
}

function clearBanner() {
  setBanner('', false);
}

function updateHeaderStatus() {
  dom.statusApi.textContent = `api: ${state.api.value || 'same-origin'} (${state.api.source})`;
  dom.statusAuth.textContent = summarizeAuth(state.me);
  dom.statusStream.textContent = `stream: ${state.streamStatus}`;
  dom.statusGenerated.textContent = state.board
    ? `generated: ${formatDate(state.board.generated_at)}`
    : 'generated: --';

  dom.apiBaseResolved.textContent = `resolved: ${state.api.value || 'same-origin'} (${state.api.source})`;
}

function updateTopNav() {
  dom.viewButtons.forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.view === state.activeView ? 'true' : 'false');
  });
  dom.views.forEach((view) => {
    view.hidden = view.dataset.view !== state.activeView;
  });
}

function updateDetailTabs() {
  dom.detailTabs.forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.panel === state.detailPanel ? 'true' : 'false');
  });
}

function updateActionButtons() {
  dom.detailActions.forEach((button) => {
    const action = button.getAttribute('data-action');
    const required = ACTIONS_FOR_BUTTON[action] ?? [];
    const allowed = required.some((permission) => canPerformAction(state.me, permission));
    button.hidden = !allowed;
    button.disabled = !allowed;
  });
}

function updateSavedViewsSelect() {
  const options = ['<option value="">Saved views</option>']
    .concat(
      state.savedViews.map((item) => `<option value="${item.id}">${item.name}</option>`),
    )
    .join('');
  dom.savedViews.innerHTML = options;
}

function renderRepoIntakeControls() {
  const repoSelect = dom.intakeRepoSelect;
  const projectSelect = dom.intakeProjectSelect;
  const todoSelect = dom.intakeTodoSelect;
  if (!(repoSelect instanceof HTMLSelectElement)) {
    return;
  }
  if (!(projectSelect instanceof HTMLSelectElement)) {
    return;
  }
  if (!(todoSelect instanceof HTMLSelectElement)) {
    return;
  }

  const repoOptions = ['<option value="">Select repository</option>']
    .concat(
      state.intake.repos.map(
        (repo) =>
          `<option value="${repo.full_name}" ${repo.full_name === state.intake.selectedRepo ? 'selected' : ''}>${repo.full_name}</option>`,
      ),
    )
    .join('');
  repoSelect.innerHTML = repoOptions;

  const projectOptions = ['<option value="">Select project</option>']
    .concat(
      state.intake.projects.map(
        (project) =>
          `<option value="${project.number}" ${
            Number(project.number) === Number(state.intake.selectedProjectNumber) ? 'selected' : ''
          }>#${project.number} ${project.title}</option>`,
      ),
    )
    .join('');
  projectSelect.innerHTML = projectOptions;

  const selectedTodoValues = new Set(Array.from(todoSelect.selectedOptions).map((option) => option.value));
  todoSelect.innerHTML = state.intake.todos
    .map((todo) => {
      const labelSuffix = todo.status_name ? ` (${todo.status_name})` : '';
      return `<option value="${todo.issue_number}">#${todo.issue_number} ${todo.title}${labelSuffix}</option>`;
    })
    .join('');
  todoSelect.size = Math.min(Math.max(state.intake.todos.length, 1), 10);
  Array.from(todoSelect.options).forEach((option) => {
    option.selected = selectedTodoValues.has(option.value);
  });
}

function toggleIncidentMode(enabled) {
  state.incidentMode = enabled;
  setIncidentMode(enabled);
  dom.incidentToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  dom.incidentPanel.hidden = !enabled;
  renderBoardView();
}

async function loadAuth() {
  state.me = await apiClient.get('/api/v1/auth/me');
  updateActionButtons();
  updateHeaderStatus();
}

async function loadBoard() {
  state.board = await apiClient.get('/api/v1/boards/default');
  if (!state.selectedCardId) {
    const firstCardId = Object.keys(state.board.cards)[0];
    if (firstCardId) {
      state.selectedCardId = firstCardId;
    }
  }
  updateHeaderStatus();
  renderBoardView();
}

async function loadDetail(taskId) {
  if (!taskId) {
    return;
  }
  state.detail = await apiClient.get(`/api/v1/tasks/${encodeURIComponent(taskId)}/detail`);
  state.selectedCardId = taskId;
  renderDetailView();
  renderBoardView();
}

async function refreshAll() {
  await loadBoard();
  if (state.selectedCardId) {
    await loadDetail(state.selectedCardId);
  }
}

async function safeRefreshAll() {
  try {
    await refreshAll();
    clearBanner();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setBanner(`Refresh failed: ${message}`);
  }
}

function renderBoardView() {
  if (dom.searchInput.value !== state.filters.search) {
    dom.searchInput.value = state.filters.search;
  }

  renderBoard(dom, state, {
    onSelectCard: (taskId, options = {}) => {
      void selectCard(taskId, options);
    },
  });

  updateSavedViewsSelect();
}

function renderDetailView() {
  renderDetail(dom, state, {
    onDetailAction: (action) => {
      void performAction(action);
    },
  });

  updateDetailTabs();
  updateActionButtons();
}

async function selectCard(taskId, options = {}) {
  try {
    await loadDetail(taskId);
    if (options.switchToDetail) {
      state.activeView = 'detail';
      updateTopNav();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setBanner(`Unable to load task detail: ${message}`);
  }
}

function startPollingFallback() {
  if (state.pollTimer) {
    return;
  }
  state.pollTimer = window.setInterval(() => {
    void safeRefreshAll();
  }, 30000);
}

function stopPollingFallback() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function connectStream() {
  state.streamHandle?.close();

  state.streamHandle = connectBoardStream({
    apiBase: state.api.value,
    topics: ['board'],
    onStatus(status) {
      state.streamStatus = status;
      updateHeaderStatus();
      if (status === 'live') {
        stopPollingFallback();
      } else {
        startPollingFallback();
      }
    },
    onPatch() {
      void safeRefreshAll();
    },
  });
}

async function performAction(action) {
  if (!state.selectedCardId) {
    setBanner('Select a task first.');
    return;
  }

  const resolvedAction =
    action === 'block-toggle' ? (state.detail?.task?.status === 'blocked' ? 'unblock' : 'block') : action;

  if (!canPerformAction(state.me, resolvedAction)) {
    setBanner(`Not authorized for action: ${resolvedAction}`);
    return;
  }

  let payload;
  if (resolvedAction === 'reassign') {
    const newOwner = window.prompt('New owner role:', state.detail?.task?.owner_role ?? 'frontend');
    if (!newOwner) {
      return;
    }
    const reason = window.prompt('Reason for reassignment:', 'Handing off to specialist');
    if (reason === null) {
      return;
    }
    payload = {
      reason,
      new_owner_role: newOwner,
    };
  } else {
    const reason = window.prompt(`Reason for ${resolvedAction}:`, '');
    if (reason === null) {
      return;
    }
    payload = { reason };
  }

  try {
    await apiClient.post(`/api/v1/tasks/${encodeURIComponent(state.selectedCardId)}/actions/${resolvedAction}`, payload);
    clearBanner();
    await safeRefreshAll();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setBanner(`Action failed: ${message}`);
  }
}

async function refreshServicePanel() {
  try {
    await refreshServiceStatus(apiClient, dom);
    clearBanner();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setBanner(`Service refresh failed: ${message}`);
  }
}

async function loadReposForIntake() {
  const response = await apiClient.get('/api/v1/github/repos?limit=250');
  const repos = Array.isArray(response.items) ? response.items : [];
  state.intake.repos = repos.sort((a, b) => a.full_name.localeCompare(b.full_name));
  if (!state.intake.selectedRepo && state.intake.repos.length > 0) {
    state.intake.selectedRepo = state.intake.repos[0].full_name;
  }
  renderRepoIntakeControls();
}

async function loadProjectsForSelectedRepo() {
  const repoFullName =
    dom.intakeRepoSelect instanceof HTMLSelectElement ? dom.intakeRepoSelect.value : state.intake.selectedRepo;
  if (!repoFullName) {
    state.intake.projects = [];
    state.intake.selectedProjectNumber = null;
    state.intake.todos = [];
    renderRepoIntakeControls();
    return;
  }

  state.intake.selectedRepo = repoFullName;
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    throw new Error('Invalid repository format');
  }

  const response = await apiClient.get(
    `/api/v1/github/projects?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&state=open&limit=100`,
  );
  const projects = Array.isArray(response.items) ? response.items : [];
  state.intake.projects = projects;
  state.intake.selectedProjectNumber = projects.length > 0 ? projects[0].number : null;
  state.intake.todos = [];
  renderRepoIntakeControls();
}

async function loadTodosForSelectedProject() {
  const repoFullName =
    dom.intakeRepoSelect instanceof HTMLSelectElement ? dom.intakeRepoSelect.value : state.intake.selectedRepo;
  const projectNumberRaw =
    dom.intakeProjectSelect instanceof HTMLSelectElement
      ? dom.intakeProjectSelect.value
      : String(state.intake.selectedProjectNumber ?? '');
  const projectNumber = Number.parseInt(projectNumberRaw, 10);
  if (!repoFullName || !Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new Error('Select a repository and project first');
  }

  state.intake.selectedRepo = repoFullName;
  state.intake.selectedProjectNumber = projectNumber;
  const [owner, repo] = repoFullName.split('/');
  const response = await apiClient.get(
    `/api/v1/github/project-todos?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&project_number=${projectNumber}&limit=250`,
  );
  state.intake.todos = Array.isArray(response.items) ? response.items : [];
  renderRepoIntakeControls();
}

async function dispatchSelectedProjectTodos() {
  if (!(dom.intakeTodoSelect instanceof HTMLSelectElement)) {
    return;
  }
  const repoFullName =
    dom.intakeRepoSelect instanceof HTMLSelectElement ? dom.intakeRepoSelect.value : state.intake.selectedRepo;
  if (!repoFullName) {
    setBanner('Select a repository before dispatching to-dos.');
    return;
  }
  const issueNumbers = Array.from(dom.intakeTodoSelect.selectedOptions)
    .map((option) => Number(option.value))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (issueNumbers.length === 0) {
    setBanner('Select one or more to-do issues to dispatch.');
    return;
  }

  const response = await apiClient.post('/api/v1/project-todos/dispatch', {
    repo_full_name: repoFullName,
    project_number: state.intake.selectedProjectNumber,
    issue_numbers: issueNumbers,
  });
  const acceptedCount = Array.isArray(response.accepted) ? response.accepted.length : 0;
  const duplicateCount = Array.isArray(response.duplicates) ? response.duplicates.length : 0;
  setBanner(
    `Started ${acceptedCount} task(s) from project to-dos${duplicateCount > 0 ? ` · duplicates skipped: ${duplicateCount}` : ''}.`,
  );
  await safeRefreshAll();
}

function applySavedView(viewId) {
  const target = state.savedViews.find((item) => item.id === viewId);
  if (!target) {
    return;
  }
  state.filters = {
    search: target.filters.search ?? '',
    repo: target.filters.repo ?? '',
    owner: target.filters.owner ?? '',
    lane: target.filters.lane ?? '',
    sort: target.filters.sort ?? 'updated_desc',
  };
  dom.searchInput.value = state.filters.search;
  renderBoardView();
}

function saveCurrentView() {
  const name = window.prompt('Name this view:');
  if (!name) {
    return;
  }
  const id = `view-${Date.now()}`;
  state.savedViews = [{ id, name, filters: { ...state.filters } }, ...state.savedViews].slice(0, 50);
  persistSavedViews();
  updateSavedViewsSelect();
}

function buildPaletteItems() {
  const items = [
    {
      title: 'Go to Board',
      subtitle: 'View lane overview and queue pressure',
      run: () => {
        state.activeView = 'board';
        updateTopNav();
      },
    },
    {
      title: 'Go to Task Detail',
      subtitle: 'Inspect selected task deeply',
      run: () => {
        state.activeView = 'detail';
        updateTopNav();
      },
    },
    {
      title: 'Go to Inspect',
      subtitle: 'Fetch run and task payloads',
      run: () => {
        state.activeView = 'inspect';
        updateTopNav();
      },
    },
    {
      title: 'Go to Service',
      subtitle: 'Health and readiness checks',
      run: () => {
        state.activeView = 'service';
        updateTopNav();
      },
    },
    {
      title: 'Go to Settings',
      subtitle: 'API routing and identity',
      run: () => {
        state.activeView = 'settings';
        updateTopNav();
      },
    },
  ];

  if (state.selectedCardId) {
    items.push(
      {
        title: 'Retry selected task',
        subtitle: state.selectedCardId,
        run: () => {
          void performAction('retry');
        },
      },
      {
        title: 'Escalate selected task',
        subtitle: state.selectedCardId,
        run: () => {
          void performAction('escalate');
        },
      },
    );
  }

  const cards = Object.values(state.board?.cards ?? {}).slice(0, 40);
  for (const card of cards) {
    items.push({
      title: `Open task: ${card.title}`,
      subtitle: `${card.card_id} · ${card.lane}`,
      run: () => {
        void selectCard(card.card_id, { switchToDetail: true });
      },
    });
  }

  return items;
}

function registerGlobalShortcuts() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);

    if (!typing && event.key === '/') {
      event.preventDefault();
      dom.searchInput.focus();
      return;
    }

    if (typing) {
      return;
    }

    if (event.key === 'r') {
      void performAction('retry');
    } else if (event.key === 'e') {
      void performAction('escalate');
    } else if (event.key === 'b') {
      void performAction('block-toggle');
    } else if (event.key === 'l') {
      state.detailPanel = 'logs';
      renderDetailView();
      state.activeView = 'detail';
      updateTopNav();
    } else if (event.key === 's') {
      state.detailPanel = 'spec';
      renderDetailView();
      state.activeView = 'detail';
      updateTopNav();
    } else if (event.key === 'p') {
      const prLink = document.getElementById('prLink');
      if (prLink instanceof HTMLAnchorElement) {
        prLink.click();
      }
    }
  });
}

function registerHandlers() {
  dom.viewButtons.forEach((button) => {
    button.addEventListener('click', () => {
      state.activeView = button.dataset.view;
      updateTopNav();
    });
  });

  dom.detailTabs.forEach((button) => {
    button.addEventListener('click', () => {
      state.detailPanel = button.dataset.panel;
      renderDetailView();
    });
  });

  dom.openInBoard.addEventListener('click', () => {
    state.activeView = 'board';
    updateTopNav();
  });

  dom.searchInput.addEventListener('input', () => {
    state.filters.search = dom.searchInput.value;
    renderBoardView();
  });

  dom.repoFilter.addEventListener('change', () => {
    state.filters.repo = dom.repoFilter.value;
    renderBoardView();
  });

  dom.ownerFilter.addEventListener('change', () => {
    state.filters.owner = dom.ownerFilter.value;
    renderBoardView();
  });

  dom.laneFilter.addEventListener('change', () => {
    state.filters.lane = dom.laneFilter.value;
    renderBoardView();
  });

  dom.sortBy.addEventListener('change', () => {
    state.filters.sort = dom.sortBy.value || 'updated_desc';
    renderBoardView();
  });

  dom.savedViews.addEventListener('change', () => {
    if (dom.savedViews.value) {
      applySavedView(dom.savedViews.value);
    }
  });

  dom.saveCurrentView.addEventListener('click', () => {
    saveCurrentView();
  });

  dom.clearFilters.addEventListener('click', () => {
    state.filters = { search: '', repo: '', owner: '', lane: '', sort: 'updated_desc' };
    dom.searchInput.value = '';
    dom.repoFilter.value = '';
    dom.ownerFilter.value = '';
    dom.laneFilter.value = '';
    dom.sortBy.value = 'updated_desc';
    renderBoardView();
  });

  dom.refreshBoard.addEventListener('click', () => {
    void safeRefreshAll();
  });

  dom.incidentToggle.addEventListener('click', () => {
    toggleIncidentMode(!state.incidentMode);
  });

  dom.detailActions.forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-action');
      if (action) {
        void performAction(action);
      }
    });
  });

  document.querySelectorAll('[data-incident-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-incident-action');
      if (action) {
        void performAction(action);
      }
    });
  });

  dom.addRunId.addEventListener('click', () => {
    const id = addRunId(dom.newRunId.value, state, dom);
    if (id) {
      dom.newRunId.value = '';
    }
  });

  dom.addTaskId.addEventListener('click', () => {
    const id = addTaskId(dom.newTaskId.value, state, dom);
    if (id) {
      dom.newTaskId.value = '';
    }
  });

  dom.fetchRun.addEventListener('click', () => {
    void fetchRun(apiClient, state, dom).catch((error) => {
      dom.runResult.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    });
  });

  dom.fetchTask.addEventListener('click', () => {
    void fetchTask(apiClient, state, dom, {
      onTaskSelected(taskId) {
        void selectCard(taskId);
      },
    }).catch((error) => {
      dom.taskResult.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    });
  });

  dom.refreshRecentRuns.addEventListener('click', () => {
    void loadRecentRuns(apiClient, state, dom, (message, isError) => {
      if (isError) {
        setBanner(message);
      } else {
        clearBanner();
      }
    }).catch((error) => {
      setBanner(`Failed to load runs: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  dom.refreshRecentTasks.addEventListener('click', () => {
    void loadRecentTasks(apiClient, state, dom, (message, isError) => {
      if (isError) {
        setBanner(message);
      } else {
        clearBanner();
      }
    }).catch((error) => {
      setBanner(`Failed to load tasks: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  dom.refreshService.addEventListener('click', () => {
    void refreshServicePanel();
  });

  dom.loadProjects.addEventListener('click', () => {
    void loadProjectsForSelectedRepo()
      .then(() => clearBanner())
      .catch((error) => {
        setBanner(`Failed to load projects: ${error instanceof Error ? error.message : String(error)}`);
      });
  });

  dom.loadProjectTodos.addEventListener('click', () => {
    void loadTodosForSelectedProject()
      .then(() => clearBanner())
      .catch((error) => {
        setBanner(`Failed to load project to-dos: ${error instanceof Error ? error.message : String(error)}`);
      });
  });

  dom.dispatchProjectTodos.addEventListener('click', () => {
    void dispatchSelectedProjectTodos().catch((error) => {
      setBanner(`Failed to dispatch project to-dos: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  if (dom.intakeRepoSelect instanceof HTMLSelectElement) {
    dom.intakeRepoSelect.addEventListener('change', () => {
      state.intake.selectedRepo = dom.intakeRepoSelect.value;
    });
  }

  if (dom.intakeProjectSelect instanceof HTMLSelectElement) {
    dom.intakeProjectSelect.addEventListener('change', () => {
      state.intake.selectedProjectNumber = Number.parseInt(dom.intakeProjectSelect.value, 10) || null;
    });
  }

  dom.testApiBase.addEventListener('click', () => {
    const candidate = dom.apiBaseInput.value.trim();
    const backup = state.api;
    state.api = {
      source: 'manual-test',
      value: candidate,
    };

    void apiClient
      .get('/healthz')
      .then(() => {
        setBanner(`API base is reachable: ${candidate || 'same-origin'}`, true);
      })
      .catch((error) => {
        setBanner(`API base test failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        state.api = backup;
        updateHeaderStatus();
      });
  });

  dom.saveApiBase.addEventListener('click', () => {
    const saved = saveApiBase(dom.apiBaseInput.value);
    state.api = resolveApiBase();
    dom.apiBaseInput.value = saved;
    updateHeaderStatus();
    connectStream();
    void safeRefreshAll();
  });

  dom.resetApiBase.addEventListener('click', () => {
    clearApiBase();
    state.api = resolveApiBase();
    dom.apiBaseInput.value = state.api.value;
    updateHeaderStatus();
    connectStream();
    void safeRefreshAll();
  });

  dom.applyIdentity.addEventListener('click', () => {
    state.identity = saveIdentity({
      userId: dom.identityUser.value,
      role: dom.identityRole.value,
    });

    void loadAuth()
      .then(() => safeRefreshAll())
      .catch((error) => {
        setBanner(`Failed to load identity: ${error instanceof Error ? error.message : String(error)}`);
      });
  });

  dom.clearIdentity.addEventListener('click', () => {
    clearIdentity();
    state.identity = loadIdentity();
    dom.identityUser.value = state.identity.userId;
    dom.identityRole.value = state.identity.role;
    void loadAuth().catch((error) => {
      setBanner(`Failed to refresh auth: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

const palette = createCommandPalette(dom, {
  getItems: () => buildPaletteItems(),
});

dom.openPalette.addEventListener('click', () => {
  palette.open(buildPaletteItems());
});

async function bootstrap() {
  dom.identityUser.value = state.identity.userId;
  dom.identityRole.value = state.identity.role;
  dom.apiBaseInput.value = state.api.value;
  toggleIncidentMode(state.incidentMode);
  updateTopNav();
  updateDetailTabs();
  updateSavedViewsSelect();
  refreshInspectDropdowns(dom, state);
  registerHandlers();
  registerGlobalShortcuts();
  connectStream();

  try {
    await Promise.all([loadAuth(), safeRefreshAll(), refreshServicePanel(), loadReposForIntake()]);
    if (state.intake.selectedRepo) {
      await loadProjectsForSelectedRepo();
      if (state.intake.selectedProjectNumber) {
        await loadTodosForSelectedProject();
      }
    }
  } catch (error) {
    setBanner(`Initialization warning: ${error instanceof Error ? error.message : String(error)}`);
  }

  const lanes = getLaneOrder();
  if (state.filters.lane && !lanes.some((lane) => lane.id === state.filters.lane)) {
    state.filters.lane = '';
  }
  if (!state.filters.sort) {
    state.filters.sort = 'updated_desc';
  }

  updateHeaderStatus();
}

void bootstrap();
