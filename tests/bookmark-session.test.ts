import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createSite, HOST, installManager, openReviewer, startTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
const origin = 'http://staging-bookmark.example';

beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t?.close(); });

it('북마크 세션은 연결된 출처, 미리보기 ID, 프로젝트의 활성 초대가 모두 일치할 때만 발급한다', async () => {
  const { headers } = await installManager(t);
  const { site, token } = await createSite(t, headers, '북마크 검수', origin + '/home');
  const other = await createSite(t, headers, '같은 출처의 별도 프로젝트', origin);
  const widgetHeaders = { ...HOST, origin, 'x-gp-key': site.widgetKey };
  const credentials = { token, pid: randomUUID(), previewId: site.preview.id };
  const exchange = (requestHeaders: Record<string, string> = widgetHeaders, payload = credentials, url = '/api/w/bookmark-session') =>
    t.app.inject({ method: 'POST', url, headers: requestHeaders, payload });

  const preflight = (targetOrigin: string) => t.app.inject({
    method: 'OPTIONS', url: '/api/w/bookmark-session',
    headers: { ...HOST, origin: targetOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-gp-key' },
  });
  expect((await preflight(origin)).headers['access-control-allow-origin']).toBe(origin);
  expect((await preflight('http://unregistered.example')).statusCode).toBe(403);
  const foreign = await exchange({ ...widgetHeaders, origin: 'http://unregistered.example' });
  expect(foreign.statusCode).toBe(403);
  expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  expect((await exchange({ ...HOST, 'x-gp-key': site.widgetKey })).statusCode).toBe(403);
  expect((await exchange({ ...widgetHeaders, origin: t.ctx.config.publicOrigin })).statusCode).toBe(403);
  expect((await exchange(widgetHeaders, credentials, '/api/w/session')).statusCode).toBe(403);
  expect((await exchange(widgetHeaders, { ...credentials, previewId: randomUUID() })).statusCode).toBe(403);
  expect((await exchange(widgetHeaders, { ...credentials, token: other.token })).statusCode).toBe(404);
  expect((await exchange({ ...widgetHeaders, 'x-gp-key': other.site.widgetKey })).statusCode).toBe(403);

  const issued = await exchange();
  expect(issued.statusCode).toBe(200);
  expect(issued.headers['access-control-allow-origin']).toBe(origin);
  expect(issued.headers['cache-control']).toBe('no-store');
  const { reviewer, session } = issued.json();
  const iframe = await openReviewer(t, widgetHeaders, token, { pid: credentials.pid });
  expect(iframe.json().reviewer).toEqual(reviewer);

  const board = (requestHeaders: Record<string, string> = widgetHeaders) => t.app.inject({
    url: '/api/w/requests', headers: { ...requestHeaders, authorization: `Bearer ${session}` },
  });
  expect((await board()).statusCode).toBe(200);
  expect((await board({ ...widgetHeaders, origin: 'http://unregistered.example' })).statusCode).toBe(401);
  expect((await board({ ...widgetHeaders, 'x-gp-key': other.site.widgetKey })).statusCode).toBe(401);

  const rotate = await t.app.inject({
    method: 'PATCH', url: `/api/sites/${site.id}`, headers, payload: { previewUrl: origin + '/another' },
  });
  expect(rotate.statusCode).toBe(200);
  expect((await exchange()).statusCode).toBe(403);
  expect((await board()).statusCode).toBe(401);
  const fresh = { ...credentials, previewId: rotate.json().site.preview.id };
  const reopened = await exchange(widgetHeaders, fresh);
  expect(reopened.statusCode).toBe(200);

  const revoked = await t.app.inject({
    method: 'PATCH', url: `/api/sites/${site.id}/links/${site.links[0].id}`, headers, payload: { revoked: true },
  });
  expect(revoked.statusCode).toBe(200);
  expect((await exchange(widgetHeaders, fresh)).statusCode).toBe(404);
  expect((await t.app.inject({
    url: '/api/w/requests', headers: { ...widgetHeaders, authorization: `Bearer ${reopened.json().session}` },
  })).statusCode).toBe(401);
});
