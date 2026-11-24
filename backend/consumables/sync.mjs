export function plantingSync(queue, { plantUrl, syncToken, intervalMs }) {
  const endpoint = new URL('/api/internal/plantings', plantUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Проверьте PLANT_SERVICE_URL.');
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) throw new Error('Некорректный интервал опроса.');
  const shutdown = new AbortController();
  let running = false;
  let timer;
  let lastSuccess = null;
  let lastError = null;

  async function poll() {
    if (running || shutdown.signal.aborted) return;
    running = true;
    try {
      const url = new URL(endpoint);
      url.searchParams.set('after', queue.cursor());
      const result = await fetch(url, { headers: { Authorization: 'Bearer ' + syncToken },
        redirect: 'error', signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(5000)]) });
      if (!result.ok) throw new Error(`Сервис растений вернул HTTP ${result.status}.`);
      const page = await result.json();
      if (shutdown.signal.aborted) return;
      queue.accept(page.items);
      lastSuccess = new Date().toISOString();
      lastError = null;
    } catch (error) {
      if (!shutdown.signal.aborted) lastError = error.message;
    } finally {
      try {
        if (!shutdown.signal.aborted) queue.settlePending();
      } catch (error) {
        lastError = error.message;
      }
      running = false;
    }
  }

  return {
    start() {
      void poll();
      timer = setInterval(poll, intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      shutdown.abort();
    },
    status() {
      return { cursor: queue.cursor(), last_success: lastSuccess, last_error: lastError };
    },
  };
}
