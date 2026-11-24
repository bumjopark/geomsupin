import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createSite, pngDataUrl, installManager, startTestApp } from './helpers.ts';

it('같은 IP의 검수자 25명이 동시에 요청·댓글을 쓰고 목록을 반복 조회해도 누락되지 않는다', async () => {
  const base = 'http://127.0.0.1:8287';
  const t = await startTestApp({ PUBLIC_URL: base, ALLOWED_HOSTS: '127.0.0.1:8287,localhost:80' });
  const times: number[] = [];
  const started = performance.now();
  try {
    await t.app.listen({ port: 8287, host: '127.0.0.1' });
    console.log('부하 시험: 서버 준비');
    const owner = await installManager(t);
    const { site, token } = await createSite(t, owner.headers, '25명 협업', 'http://review.example');
    async function call(path: string, session = '', body?: unknown) {
      const since = performance.now();
      const response = await fetch(base + '/api/w' + path, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', origin: path === '/session' ? base : 'http://review.example', 'x-gp-key': site.widgetKey, ...(session ? { authorization: `Bearer ${session}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json(); times.push(performance.now() - since);
      expect(response.status, `${path}: HTTP ${response.status} ${response.ok ? '' : JSON.stringify(result)}`).toBe(200);
      return result;
    }
    const people = await Promise.all(Array.from({ length: 25 }, () => call('/session', '', { token, previewId: site.preview.id, pid: randomUUID() })));
    console.log('부하 시험: 25명 입장');
    const screenshot = await pngDataUrl(320, 200);
    const requests = await Promise.all(people.map((p, i) => call('/requests', p.session, { name: `검수자 ${i + 1}`, mutationId: randomUUID().replaceAll('-', ''), body: `동시 요청 ${i + 1}`, pageUrl: 'http://review.example/', viewportW: 1366, viewportH: 768, screenshot })));
    console.log('부하 시험: 요청 25건 작성');
    expect(new Set(requests.map(r => r.request.id)).size).toBe(25);
    expect(new Set(requests.map(r => r.request.no)).size).toBe(25);
    const shared = requests[0]!.request.id;
    await Promise.all(people.map(async (p, i) => {
      await call(`/requests/${shared}/comments`, p.session, { body: `함께 보는 댓글 ${i + 1}`, mutationId: randomUUID().replaceAll('-', '') });
      await call(`/requests/${requests[i]!.request.id}/comments`, p.session, { body: `내 요청 댓글 ${i + 1}`, mutationId: randomUUID().replaceAll('-', '') });
      for (let round = 0; round < 20; round++) {
        const board = await call('/requests', p.session);
        expect(board.requests).toHaveLength(25);
        await new Promise(r => setTimeout(r, 150));
      }
      const detail = await call(`/requests/${shared}`, p.session);
      expect(detail.request.comments.filter((c: { type: string }) => c.type !== 'system')).toHaveLength(26);
    }));
    const [count] = await t.sql`select (select count(*)::int from requests) as requests, (select count(*)::int from comments where author_type <> 'system') as comments`;
    expect(count).toMatchObject({ requests: 25, comments: 50 });
    times.sort((a, b) => a - b);
    const report = { clients: 25, httpRequests: times.length, errors: 0, p95Ms: Math.round(times[Math.floor(times.length * .95)]!), maxMs: Math.round(times.at(-1)!), seconds: Number(((performance.now() - started) / 1000).toFixed(1)), stored: count, measuredAt: new Date().toISOString() };
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/load.json', JSON.stringify(report, null, 2) + '\n');
    console.log(`동시 검수자 25명: ${JSON.stringify(report)} (테스트 환경 측정)`);
  } finally { t.app.server.closeAllConnections(); await t.close(); }
}, 60000);
