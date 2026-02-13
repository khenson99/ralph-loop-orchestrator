const API_BASE_KEY = 'ralph.ui.apiBase';
const INCIDENT_MODE_KEY = 'ralph.ui.incidentMode';

function normalizeBase(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  return raw.replace(/\/$/, '');
}

export function resolveApiBase() {
  const url = new URL(window.location.href);
  const queryBase = normalizeBase(url.searchParams.get('apiBase') ?? '');
  if (queryBase) {
    return { source: 'query', value: queryBase };
  }

  const stored = normalizeBase(window.localStorage.getItem(API_BASE_KEY) ?? '');
  if (stored) {
    return { source: 'localStorage', value: stored };
  }

  const runtime = normalizeBase(window.__RALPH_CONFIG__?.apiBase ?? '');
  if (runtime) {
    return { source: 'runtime', value: runtime };
  }

  return { source: 'same-origin', value: '' };
}

export function saveApiBase(value) {
  const normalized = normalizeBase(value);
  if (!normalized) {
    window.localStorage.removeItem(API_BASE_KEY);
    return '';
  }
  window.localStorage.setItem(API_BASE_KEY, normalized);
  return normalized;
}

export function clearApiBase() {
  window.localStorage.removeItem(API_BASE_KEY);
}

export function getIncidentMode() {
  return window.localStorage.getItem(INCIDENT_MODE_KEY) === 'true';
}

export function setIncidentMode(enabled) {
  window.localStorage.setItem(INCIDENT_MODE_KEY, enabled ? 'true' : 'false');
}

export function buildApiUrl(apiBase, path) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const normalizedBase = normalizeBase(apiBase);
  return normalizedBase ? `${normalizedBase}${normalizedPath}` : normalizedPath;
}

export const configKeys = {
  API_BASE_KEY,
  INCIDENT_MODE_KEY,
};
