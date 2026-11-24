import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { randomToken, sha256 } from '../server/security.ts';
import { createSite, openReviewer, installManager, startTestApp } from './helpers.ts';

const APP = 'http://127.0.0.1:8296';
const STAGE = 'http://localhost:8297';

async function readEvents(headers: Record<string, string>) {
  const response = await fetch(`${APP}/api/w/events`, { headers, signal: AbortSignal.timeout(12_000) });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(response.headers.get('access-control-allow-origin')).toBe(STAGE);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  return async () => {
    while (!pending.includes('\n\n')) {
      const { done, value } = await reader.read();
      if (done) return null;
      pending += value;
    }
    const end = pending.indexOf('\n\n');
    const event = pending.slice(0, end);
    pending = pending.slice(end + 2);
    return event;
  };
}

it('미리보기 스트림은 같은 프로젝트의 변경만 보내고 폐기·만료 때 열린 연결을 닫는다', async () => {
  const t = await startTestApp({ PUBLIC_URL: APP, ALLOWED_HOSTS: '127.0.0.1:8296,localhost:80' });
  try {
    await t.app.listen({ host: '127.0.0.1', port: 8296 });
    const owner = await installManager(t);
    async function setup(name: string) {
      const { site, token } = await createSite(t, owner.headers, name);
      const path = `/api/sites/${site.id}`;
      const linkPath = `${path}/links/${site.links[0].id}`;
      const connect = await t.app.inject({ method: 'PATCH', url: path, headers: owner.headers, payload: { previewUrl: STAGE } });
      expect(connect.statusCode).toBe(200);
      const headers = { 'x-gp-key': site.widgetKey as string, origin: STAGE };
      const sessionHeaders = { host: 'localhost:80', ...headers };
      const issued = await openReviewer(t, sessionHeaders, token, { name });
      expect(issued.statusCode).toBe(200);
      const session = issued.json();
      const oldToken = randomToken();
      const [link] = await t.sql`select id from review_links where token = ${token}`;
      await t.sql`insert into widget_sessions (id, site_id, link_id, reviewer_id, expires_at)
        values (${sha256(oldToken)}, ${site.id}, ${link!.id}, ${session.reviewer.id}, now() + interval '1 hour')`;
      return { linkPath, live: { ...headers, authorization: `Bearer ${session.session}` }, old: { ...headers, authorization: `Bearer ${oldToken}` } };
    }
    const a = await setup('프로젝트 A');
    const b = await setup('프로젝트 B');
    const reject = async (headers: Record<string, string>, status: number) => {
      const res = await fetch(`${APP}/api/w/events`, { headers, signal: AbortSignal.timeout(2000) });
      expect(res.status).toBe(status);
      await res.arrayBuffer();
    };
    await reject(a.old, 401);
    await reject({ ...a.live, origin: 'http://localhost:8298' }, 401);
    await reject({ ...a.live, 'x-gp-key': b.live['x-gp-key'] }, 401);

    const readA = await readEvents(a.live);
    const readB = await readEvents(b.live);
    expect(await readA()).toBe('data: ready');
    expect(await readB()).toBe('data: ready');
    const nextB = readB();
    async function createPin(headers: typeof a.live) {
      const res = await t.app.inject({
        method: 'POST', url: '/api/w/requests', headers: { ...owner.headers, ...headers },
        payload: { pageUrl: STAGE, body: '핀', viewportW: 800, viewportH: 600 },
      });
      expect(res.statusCode).toBe(200);
      return res.json().request.id as string;
    }
    const requestA = await createPin(a.live);
    expect(await readA()).toBe('data: change');
    expect(await Promise.race([nextB, wait(250, 'silent')])).toBe('silent');
    await createPin(b.live);
    expect(await nextB).toBe('data: change');

    const admin = await t.app.inject({
      method: 'POST', url: `/api/requests/${requestA}/comments`, headers: owner.headers, payload: { body: '관리자 댓글' },
    });
    expect(admin.statusCode).toBe(200);
    expect(await readA()).toBe('data: change');

    const revoked = await t.app.inject({ method: 'PATCH', url: a.linkPath, headers: owner.headers, payload: { revoked: true } });
    expect(revoked.statusCode).toBe(200);
    expect(await readA()).toBeNull();
    await reject(a.live, 401);

    const expiry = await t.app.inject({
      method: 'PATCH', url: b.linkPath, headers: owner.headers, payload: { expiresAt: new Date(Date.now() + 1200).toISOString() },
    });
    expect(expiry.statusCode).toBe(200);
    expect(await readB()).toBe('data: change');
    expect(await readB()).toBeNull();
    await reject(b.live, 401);
  } finally {
    await t.close();
  }
});
