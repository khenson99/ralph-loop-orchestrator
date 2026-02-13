import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal browser stubs
// ---------------------------------------------------------------------------

const storage = new Map<string, string>();

const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
};

let currentSearch = '';
let pushStateHistory: Array<{ state: unknown; url: string }> = [];

const locationStub = {
  get search() {
    return currentSearch;
  },
  get href() {
    return `http://localhost${currentSearch}`;
  },
  get pathname() {
    return '/';
  },
  get hash() {
    return '';
  },
};

const historyStub = {
  pushState: vi.fn((state: unknown, _title: string, url: string) => {
    pushStateHistory.push({ state, url });
    const parsed = new URL(url, 'http://localhost');
    currentSearch = parsed.search;
  }),
};

// Install stubs before module import
vi.stubGlobal('localStorage', localStorageStub);

Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: localStorageStub,
    location: locationStub,
    history: historyStub,
  },
  writable: true,
  configurable: true,
});

// Dynamic import so stubs are in place before module code runs
// @ts-expect-error -- vanilla JS module without type declarations
const mod = await import('../apps/orchestrator-ui/src/lib/filter-persistence.js');
const {
  normalizeFilters,
  serializeFilters,
  deserializeFilters,
  pushFilterState,
  readFilterState,
  hasUrlFilterParams,
  loadSavedViews,
  saveSavedViews,
  addSavedView,
  deleteSavedView,
  findSavedView,
  filtersEqual,
  detectActiveView,
  getDefaultFilters,
} = mod;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  storage.clear();
  currentSearch = '';
  pushStateHistory = [];
  historyStub.pushState.mockClear();
});

describe('normalizeFilters', () => {
  it('applies defaults for missing fields', () => {
    const result = normalizeFilters({});
    expect(result).toEqual({
      search: '',
      repo: '',
      owner: '',
      lane: '',
      sort: 'updated_desc',
    });
  });

  it('preserves valid sort values', () => {
    expect(normalizeFilters({ sort: 'repo_asc' }).sort).toBe('repo_asc');
    expect(normalizeFilters({ sort: 'repo_desc' }).sort).toBe('repo_desc');
    expect(normalizeFilters({ sort: 'title_asc' }).sort).toBe('title_asc');
  });

  it('rejects invalid sort values', () => {
    expect(normalizeFilters({ sort: 'bogus' }).sort).toBe('updated_desc');
  });

  it('coerces null/undefined to empty strings', () => {
    const result = normalizeFilters(null as unknown);
    expect(result.search).toBe('');
    expect(result.repo).toBe('');
  });
});

describe('serializeFilters / deserializeFilters round-trip', () => {
  it('round-trips a full filter set', () => {
    const original = {
      search: 'auth',
      repo: 'org/app',
      owner: 'frontend',
      lane: 'in_progress',
      sort: 'repo_asc' as const,
    };
    const serialized = serializeFilters(original);
    const restored = deserializeFilters(serialized);
    expect(restored).toEqual(original);
  });

  it('omits default values from serialized output', () => {
    const defaults = getDefaultFilters();
    const serialized = serializeFilters(defaults);
    expect(serialized).toBe('');
  });

  it('round-trips with only one non-default field', () => {
    const original = { ...getDefaultFilters(), repo: 'my/repo' };
    const serialized = serializeFilters(original);
    expect(serialized).toContain('repo=');
    expect(serialized).not.toContain('search=');
    const restored = deserializeFilters(serialized);
    expect(restored).toEqual(original);
  });

  it('handles URLSearchParams as input to deserialize', () => {
    const params = new URLSearchParams('search=hello&sort=title_asc');
    const result = deserializeFilters(params);
    expect(result.search).toBe('hello');
    expect(result.sort).toBe('title_asc');
    expect(result.repo).toBe('');
  });
});

describe('pushFilterState', () => {
  it('calls history.pushState with serialized filters', () => {
    pushFilterState({ search: 'test', repo: '', owner: '', lane: '', sort: 'updated_desc' });
    expect(historyStub.pushState).toHaveBeenCalledTimes(1);
    const call = pushStateHistory[0];
    expect(call?.url).toContain('search=test');
  });

  it('does not push if URL already matches', () => {
    currentSearch = '?search=test';
    pushFilterState({ search: 'test', repo: '', owner: '', lane: '', sort: 'updated_desc' });
    expect(historyStub.pushState).not.toHaveBeenCalled();
  });

  it('pushes clean URL for default filters', () => {
    currentSearch = '?search=old';
    pushFilterState(getDefaultFilters());
    expect(historyStub.pushState).toHaveBeenCalledTimes(1);
    const call = pushStateHistory[0];
    expect(call?.url).toBe('/');
  });
});

describe('readFilterState / hasUrlFilterParams', () => {
  it('returns defaults when URL has no filter params', () => {
    currentSearch = '';
    expect(hasUrlFilterParams()).toBe(false);
    expect(readFilterState()).toEqual(getDefaultFilters());
  });

  it('reads filter params from URL', () => {
    currentSearch = '?repo=org/app&lane=blocked';
    expect(hasUrlFilterParams()).toBe(true);
    const result = readFilterState();
    expect(result.repo).toBe('org/app');
    expect(result.lane).toBe('blocked');
    expect(result.search).toBe('');
  });
});

describe('Saved views CRUD', () => {
  it('returns empty array when nothing stored', () => {
    expect(loadSavedViews()).toEqual([]);
  });

  it('adds and loads a saved view', () => {
    const filters = { search: 'auth', repo: 'org/app', owner: '', lane: '', sort: 'updated_desc' as const };
    const views = addSavedView('My View', filters);
    expect(views).toHaveLength(1);
    expect(views[0]?.name).toBe('My View');
    expect(views[0]?.filters).toEqual(normalizeFilters(filters));

    const loaded = loadSavedViews();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe('My View');
  });

  it('deletes a saved view', () => {
    const filtersA = { search: 'aaa', repo: '', owner: '', lane: '', sort: 'updated_desc' as const };
    const filtersB = { search: 'bbb', repo: '', owner: '', lane: '', sort: 'updated_desc' as const };
    // Mock Date.now so each addSavedView call generates a distinct ID
    let nowCounter = 1000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowCounter++);
    addSavedView('View A', filtersA);
    const views = addSavedView('View B', filtersB);
    dateNowSpy.mockRestore();
    expect(views).toHaveLength(2);
    // addSavedView prepends, so views[0] is "View B"
    const idToDelete = views[0]?.id;
    const updated = deleteSavedView(idToDelete!);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe('View A');
  });

  it('findSavedView returns a view by ID', () => {
    const views = addSavedView('Target', { search: 'x', repo: '', owner: '', lane: '', sort: 'updated_desc' });
    const found = findSavedView(views[0]!.id);
    expect(found?.name).toBe('Target');
  });

  it('findSavedView returns null for missing ID', () => {
    expect(findSavedView('nonexistent')).toBeNull();
  });

  it('rejects empty name', () => {
    const views = addSavedView('  ', getDefaultFilters());
    expect(views).toEqual([]);
  });

  it('caps saved views at 50', () => {
    for (let i = 0; i < 55; i++) {
      addSavedView(`View ${i}`, getDefaultFilters());
    }
    const loaded = loadSavedViews();
    expect(loaded.length).toBeLessThanOrEqual(50);
  });

  it('handles corrupt localStorage gracefully', () => {
    storage.set('ralph.ui.savedViews', 'not-json');
    expect(loadSavedViews()).toEqual([]);
  });

  it('handles non-array localStorage gracefully', () => {
    storage.set('ralph.ui.savedViews', JSON.stringify({ oops: true }));
    expect(loadSavedViews()).toEqual([]);
  });
});

describe('filtersEqual', () => {
  it('considers identical filters equal', () => {
    const a = { search: 'x', repo: '', owner: '', lane: '', sort: 'updated_desc' as const };
    const b = { search: 'x', repo: '', owner: '', lane: '', sort: 'updated_desc' as const };
    expect(filtersEqual(a, b)).toBe(true);
  });

  it('detects differences', () => {
    const a = { search: 'x', repo: '', owner: '', lane: '', sort: 'updated_desc' as const };
    const b = { search: 'y', repo: '', owner: '', lane: '', sort: 'updated_desc' as const };
    expect(filtersEqual(a, b)).toBe(false);
  });

  it('normalizes before comparing', () => {
    expect(filtersEqual({}, {})).toBe(true);
    expect(filtersEqual({}, getDefaultFilters())).toBe(true);
  });
});

describe('detectActiveView', () => {
  it('returns matching view', () => {
    const filters = { search: 'auth', repo: 'org/app', owner: '', lane: '', sort: 'updated_desc' as const };
    addSavedView('Match Me', filters);

    const active = detectActiveView(filters);
    expect(active?.name).toBe('Match Me');
  });

  it('returns null when no match', () => {
    addSavedView('Something', { search: 'other', repo: '', owner: '', lane: '', sort: 'updated_desc' });
    const active = detectActiveView({ search: 'nope', repo: '', owner: '', lane: '', sort: 'updated_desc' });
    expect(active).toBeNull();
  });
});

describe('getDefaultFilters', () => {
  it('returns a fresh copy each time', () => {
    const a = getDefaultFilters();
    const b = getDefaultFilters();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
