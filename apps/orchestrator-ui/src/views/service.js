export async function refreshServiceStatus(apiClient, dom) {
  dom.healthResult.textContent = 'Loading...';
  dom.readyResult.textContent = 'Loading...';

  try {
    const [health, ready] = await Promise.all([apiClient.get('/healthz'), apiClient.get('/readyz')]);
    dom.healthResult.textContent = JSON.stringify(health, null, 2);
    dom.readyResult.textContent = JSON.stringify(ready, null, 2);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dom.healthResult.textContent = `Error: ${message}`;
    dom.readyResult.textContent = `Error: ${message}`;
    throw error;
  }
}
