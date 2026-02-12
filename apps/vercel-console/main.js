const API_BASE = "https://orchestrator-production-114a.up.railway.app";

const apiBaseEl = document.getElementById("apiBase");
const healthEl = document.getElementById("health");
const readyEl = document.getElementById("ready");
const runResultEl = document.getElementById("runResult");
const taskResultEl = document.getElementById("taskResult");

apiBaseEl.textContent = API_BASE;

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

document.getElementById("fetchRun").addEventListener("click", async () => {
  const runId = document.getElementById("runId").value.trim();
  if (!runId) {
    runResultEl.textContent = "Enter a run ID first.";
    return;
  }

  runResultEl.textContent = "Loading...";
  try {
    const run = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
    runResultEl.textContent = JSON.stringify(run, null, 2);
  } catch (error) {
    runResultEl.textContent = `Error: ${String(error)}`;
  }
});

document.getElementById("fetchTask").addEventListener("click", async () => {
  const taskId = document.getElementById("taskId").value.trim();
  if (!taskId) {
    taskResultEl.textContent = "Enter a task ID first.";
    return;
  }

  taskResultEl.textContent = "Loading...";
  try {
    const task = await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}`);
    taskResultEl.textContent = JSON.stringify(task, null, 2);
  } catch (error) {
    taskResultEl.textContent = `Error: ${String(error)}`;
  }
});

void refreshStatus();
