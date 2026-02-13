import { buildApiUrl } from './config.js';

async function parseResponseBody(response) {
  const raw = await response.text();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function createApiClient(options) {
  const { getApiBase, getAuthHeaders } = options;

  async function request(path, init = {}) {
    const url = buildApiUrl(getApiBase(), path);
    const headers = {
      ...(init.headers || {}),
      ...(getAuthHeaders ? getAuthHeaders() : {}),
    };

    const response = await fetch(url, {
      ...init,
      headers,
    });

    const body = await parseResponseBody(response);

    if (!response.ok) {
      const error = new Error(
        typeof body === 'object' && body !== null && typeof body.error === 'string'
          ? body.error
          : `${response.status} ${response.statusText}`,
      );
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return body;
  }

  return {
    get(path) {
      return request(path, { method: 'GET' });
    },
    post(path, body) {
      return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    },
    request,
  };
}
