/**
 * Filter persistence module for board views.
 *
 * Responsibilities:
 * - Serialize/deserialize filter state to/from URL search params
 * - Push filter state into the browser URL (history.pushState) without reload
 * - Read filter state from the URL on page load (URL params take priority)
 * - CRUD operations for saved views in localStorage
 */

const SAVED_VIEWS_KEY = 'ralph.ui.savedViews';

const VALID_SORT_VALUES = new Set(['updated_desc', 'repo_asc', 'repo_desc', 'title_asc']);

const FILTER_KEYS = ['search', 'repo', 'owner', 'lane', 'sort'];

const DEFAULT_FILTERS = Object.freeze({
  search: '',
  repo: '',
  owner: '',
  lane: '',
  sort: 'updated_desc',
});

/**
 * Produce a canonical filter object from partial input, applying defaults
 * for any missing or invalid fields.
 */
export function normalizeFilters(raw) {
  const sort = VALID_SORT_VALUES.has(String(raw?.sort ?? '')) ? String(raw.sort) : 'updated_desc';
  return {
    search: String(raw?.search ?? ''),
    repo: String(raw?.repo ?? ''),
    owner: String(raw?.owner ?? ''),
    lane: String(raw?.lane ?? ''),
    sort,
  };
}

/**
 * Convert a filters object into a URL search params string.
 * Only includes non-default values to keep URLs compact.
 */
export function serializeFilters(filters) {
  const params = new URLSearchParams();
  const normalized = normalizeFilters(filters);

  for (const key of FILTER_KEYS) {
    const value = normalized[key];
    if (value && value !== DEFAULT_FILTERS[key]) {
      params.set(key, value);
    }
  }

  const result = params.toString();
  return result;
}

/**
 * Parse URL search params (string or URLSearchParams) into a filters object.
 * Missing keys fall back to defaults.
 */
export function deserializeFilters(searchParams) {
  const params =
    typeof searchParams === 'string' ? new URLSearchParams(searchParams) : searchParams;

  return normalizeFilters({
    search: params.get('search') ?? '',
    repo: params.get('repo') ?? '',
    owner: params.get('owner') ?? '',
    lane: params.get('lane') ?? '',
    sort: params.get('sort') ?? 'updated_desc',
  });
}

/**
 * Update the browser URL with the current filter state using history.pushState.
 * Does not trigger a page reload or navigation.
 */
export function pushFilterState(filters) {
  const serialized = serializeFilters(filters);
  const url = new URL(window.location.href);
  const newSearch = serialized ? `?${serialized}` : '';

  if (url.search !== newSearch) {
    const newUrl = `${url.pathname}${newSearch}${url.hash}`;
    window.history.pushState({ filters: normalizeFilters(filters) }, '', newUrl);
  }
}

/**
 * Read filter state from the current URL search params.
 * Returns default filters if URL has no filter params.
 */
export function readFilterState() {
  const params = new URLSearchParams(window.location.search);
  const hasFilterParams = FILTER_KEYS.some((key) => params.has(key));

  if (!hasFilterParams) {
    return { ...DEFAULT_FILTERS };
  }

  return deserializeFilters(params);
}

/**
 * Check whether the current URL contains any filter parameters.
 */
export function hasUrlFilterParams() {
  const params = new URLSearchParams(window.location.search);
  return FILTER_KEYS.some((key) => params.has(key));
}

// ---------------------------------------------------------------------------
// Saved Views CRUD (localStorage-backed)
// ---------------------------------------------------------------------------

/**
 * Load all saved views from localStorage.
 * Returns an empty array on parse failure or missing data.
 */
export function loadSavedViews() {
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
        filters: normalizeFilters(item.filters),
      }));
  } catch {
    return [];
  }
}

/**
 * Persist the full saved views array to localStorage.
 */
export function saveSavedViews(views) {
  const clamped = Array.isArray(views) ? views.slice(0, 50) : [];
  window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(clamped));
}

/**
 * Add a new saved view. Returns the updated views array.
 */
export function addSavedView(name, filters) {
  const trimmed = String(name).trim();
  if (!trimmed) {
    return loadSavedViews();
  }
  const views = loadSavedViews();
  const id = `view-${Date.now()}`;
  const newView = { id, name: trimmed, filters: normalizeFilters(filters) };
  const updated = [newView, ...views].slice(0, 50);
  saveSavedViews(updated);
  return updated;
}

/**
 * Delete a saved view by ID. Returns the updated views array.
 */
export function deleteSavedView(viewId) {
  const views = loadSavedViews();
  const updated = views.filter((item) => item.id !== viewId);
  saveSavedViews(updated);
  return updated;
}

/**
 * Find a saved view by ID.
 */
export function findSavedView(viewId) {
  const views = loadSavedViews();
  return views.find((item) => item.id === viewId) ?? null;
}

/**
 * Check if two filter objects are functionally equal.
 */
export function filtersEqual(a, b) {
  const na = normalizeFilters(a);
  const nb = normalizeFilters(b);
  return FILTER_KEYS.every((key) => na[key] === nb[key]);
}

/**
 * Detect which saved view (if any) matches the given filters.
 * Returns the matching view or null.
 */
export function detectActiveView(filters) {
  const views = loadSavedViews();
  return views.find((view) => filtersEqual(view.filters, filters)) ?? null;
}

/**
 * Return a copy of the default filters object.
 */
export function getDefaultFilters() {
  return { ...DEFAULT_FILTERS };
}
