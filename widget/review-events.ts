/** 인증 헤더를 넣어 SSE를 읽고, 재연결 때 놓친 변경은 기존 API로 다시 확인한다. */
export function followReviewEvents(url: string, key: string, session: string, sync: () => void) {
  if (typeof ReadableStream === 'undefined' || typeof TextDecoder === 'undefined') return () => {};
  let current: AbortController | undefined;
  let retry: number | undefined;
  let delay = 500;
  let paused = false;
  let stopped = false;

  async function connect() {
    window.clearTimeout(retry);
    if (current || paused || stopped) return;
    const controller = current = new AbortController();
    let watchdog: number | undefined;
    function expectHeartbeat() {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => controller.abort(), 18_000);
    }
    expectHeartbeat();
    try {
      const response = await fetch(url, {
        mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${session}`, 'X-GP-Key': key },
      });
      if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await response.body?.cancel();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end = buffer.indexOf('\n\n');
          while (end !== -1) {
            const event = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 2);
            if (event === 'data: ready' || event === 'data: change') sync();
            if (event === 'data: ready' || event === 'data: change' || event === 'data: ping') {
              delay = 500;
              expectHeartbeat();
            }
            end = buffer.indexOf('\n\n');
          }
          if (buffer.length > 4096) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      // 연결 차단·서버 전환 시에도 주기 조회가 계속된다.
    } finally {
      window.clearTimeout(watchdog);
      controller.abort();
      current = undefined;
      if (!paused && !stopped) {
        sync();
        retry = window.setTimeout(() => void connect(), delay);
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }

  const rejoin = () => { paused = false; void connect(); };
  const pause = () => {
    paused = true;
    window.clearTimeout(retry);
    current?.abort();
  };
  window.addEventListener('online', rejoin);
  window.addEventListener('pageshow', rejoin);
  window.addEventListener('pagehide', pause);
  void connect();
  return () => {
    stopped = true;
    pause();
    window.removeEventListener('online', rejoin);
    window.removeEventListener('pageshow', rejoin);
    window.removeEventListener('pagehide', pause);
  };
}
