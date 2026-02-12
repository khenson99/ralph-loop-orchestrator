const API_BASE = "https://orchestrator-production-114a.up.railway.app";
const RUN_IDS_KEY = "ralphConsole.runIds";
const TASK_IDS_KEY = "ralphConsole.taskIds";

const apiBaseEl = document.getElementById("apiBase");
const healthEl = document.getElementById("health");
const readyEl = document.getElementById("ready");
const runResultEl = document.getElementById("runResult");
const taskResultEl = document.getElementById("taskResult");
const runSelectEl = document.getElementById("runId");
const taskSelectEl = document.getElementById("taskId");
const newRunIdEl = document.getElementById("newRunId");
const newTaskIdEl = document.getElementById("newTaskId");

apiBaseEl.textContent = API_BASE;

function loadIds(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveIds(key, ids) {
  localStorage.setItem(key, JSON.stringify(ids.slice(0, 100)));
}

function upsertId(key, value) {
  const id = value.trim();
  if (!id) return null;
  const existing = loadIds(key).filter((v) => v !== id);
  const next = [id, ...existing];
  saveIds(key, next);
  return id;
}

function renderSelect(selectEl, ids, placeholder) {
  const current = selectEl.value;
  selectEl.innerHTML = "";

  const placeholderOpt = document.createElement("option");
  placeholderOpt.value = "";
  placeholderOpt.textContent = placeholder;
  selectEl.appendChild(placeholderOpt);

  ids.forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    selectEl.appendChild(opt);
  });

  if (current && ids.includes(current)) {
    selectEl.value = current;
  }
}

function refreshDropdowns() {
  renderSelect(runSelectEl, loadIds(RUN_IDS_KEY), "Select a Run ID");
  renderSelect(taskSelectEl, loadIds(TASK_IDS_KEY), "Select a Task ID");
}

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return { status: res.status, body: parsed };
}

async function refreshStatus() {
  try {
    const [health, ready] = await Promise.all([fetchJson("/healthz"), fetchJson("/readyz")]);
    healthEl.textContent = JSON.stringify(health, null, 2);
    readyEl.textContent = JSON.stringify(ready, null, 2);
  } catch (error) {
    healthEl.textContent = `Error: ${String(error)}`;
    readyEl.textContent = `Error: ${String(error)}`;
  }
}

async function loadRecentIdsFromApi() {
  try {
    const [runs, tasks] = await Promise.all([fetchJson("/api/runs?limit=100"), fetchJson("/api/tasks?limit=200")]);
    if (runs.status === 200 && runs.body && Array.isArray(runs.body.items)) {
      for (const run of runs.body.items) {
        if (run && typeof run.id === "string") {
          upsertId(RUN_IDS_KEY, run.id);
        }
      }
    }
    if (tasks.status === 200 && tasks.body && Array.isArray(tasks.body.items)) {
      for (const task of tasks.body.items) {
        if (task && typeof task.id === "string") {
          upsertId(TASK_IDS_KEY, task.id);
        }
      }
    }
    refreshDropdowns();
  } catch {
    // Keep local cached IDs if API list call fails.
  }
}

document.getElementById("addRunId").addEventListener("click", () => {
  const id = upsertId(RUN_IDS_KEY, newRunIdEl.value);
  if (!id) return;
  newRunIdEl.value = "";
  refreshDropdowns();
  runSelectEl.value = id;
});

document.getElementById("addTaskId").addEventListener("click", () => {
  const id = upsertId(TASK_IDS_KEY, newTaskIdEl.value);
  if (!id) return;
  newTaskIdEl.value = "";
  refreshDropdowns();
  taskSelectEl.value = id;
});

document.getElementById("fetchRun").addEventListener("click", async () => {
  const runId = runSelectEl.value.trim();
  if (!runId) {
    runResultEl.textContent = "Select a run ID first.";
    return;
  }

  runResultEl.textContent = "Loading...";
  try {
    const run = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
    runResultEl.textContent = JSON.stringify(run, null, 2);

    if (run.status === 200 && run.body && typeof run.body === "object") {
      upsertId(RUN_IDS_KEY, runId);
      if (Array.isArray(run.body.tasks)) {
        for (const task of run.body.tasks) {
          if (task && typeof task.id === "string") {
            upsertId(TASK_IDS_KEY, task.id);
          }
        }
      }
      refreshDropdowns();
      runSelectEl.value = runId;
    }
  } catch (error) {
    runResultEl.textContent = `Error: ${String(error)}`;
  }
});

document.getElementById("fetchTask").addEventListener("click", async () => {
  const taskId = taskSelectEl.value.trim();
  if (!taskId) {
    taskResultEl.textContent = "Select a task ID first.";
    return;
  }

  taskResultEl.textContent = "Loading...";
  try {
    const task = await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}`);
    taskResultEl.textContent = JSON.stringify(task, null, 2);

    if (task.status === 200) {
      upsertId(TASK_IDS_KEY, taskId);
      refreshDropdowns();
      taskSelectEl.value = taskId;
    }
  } catch (error) {
    taskResultEl.textContent = `Error: ${String(error)}`;
  }
});

refreshDropdowns();
void refreshStatus();
void loadRecentIdsFromApi();
