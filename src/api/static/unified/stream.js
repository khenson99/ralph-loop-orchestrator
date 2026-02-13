import { buildApiUrl } from './config.js';

export function connectBoardStream(params) {
  const { apiBase, topics, onPatch, onStatus } = params;
  let source = null;
  let reconnectTimer = null;

  const topicQuery = encodeURIComponent(topics.join(','));
  const url = buildApiUrl(apiBase, `/api/v1/stream?topics=${topicQuery}`);

  function connect() {
    if (source) {
      source.close();
      source = null;
    }

    source = new EventSource(url);

    source.addEventListener('open', () => {
      onStatus?.('live');
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    });

    source.addEventListener('task.patch', (event) => {
      try {
        const payload = JSON.parse(event.data);
        onPatch?.(payload);
      } catch {
        onPatch?.(null);
      }
    });

    source.onerror = () => {
      onStatus?.('polling');
      source?.close();
      source = null;
      if (!reconnectTimer) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 5000);
      }
    };
  }

  connect();

  return {
    close() {
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      if (source) {
        source.close();
      }
    },
  };
}
