import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../server/app.ts';
import { issueAdminLink } from '../server/installation-admin.ts';
import { randomToken, sha256 } from '../server/security.ts';
import { createSite, HOST, installManager, startTestApp } from './helpers.ts';

it('공개 방문은 설치자를 만들지 않고 CLI 링크만 한 번 교환할 수 있다', async () => {
  const t = await startTestApp();
  try {
    await t.app.inject({ url: '/', headers: HOST });
    expect((await t.app.inject({ url: '/api/sites', headers: HOST })).statusCode).toBe(401);
    expect(await t.sql`select id from workspaces`).toHaveLength(0);
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/manage.ts', '--name', '신규 조직'], {
      env: {
        ...process.env, GP_ENV_FILE: join(t.dir, 'cli.env'), DATABASE_URL: t.ctx.config.databaseUrl,
        PUBLIC_URL: t.ctx.config.publicUrl, PEER_REVIEW_URL: '',
      },
    });
    const token = /#manage=([A-Za-z0-9_-]{43})/.exec(stdout)![1]!;
    expect((await t.sql`select token_hash from installation_admin_links`)[0]!.token_hash).toBe(sha256(token));
    expect((await t.sql`select name, email, password_hash from users`)[0]).toMatchObject({ name: '설치 관리자', email: null, password_hash: null });
    const exchange = (origin = t.ctx.config.publicOrigin) => t.app.inject({
      method: 'POST', url: '/api/manage/exchange', headers: { ...HOST, origin }, payload: { token },
    });
    expect((await exchange('http://other.example')).statusCode).toBe(403);
    const attempts = await Promise.all([exchange(), exchange()]);
    expect(attempts.map(r => r.statusCode).sort()).toEqual([200, 401]);
    const setCookie = String(attempts.find(r => r.statusCode === 200)!.headers['set-cookie']);
    expect(setCookie).toMatch(/^gp_install_session=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const headers = { ...HOST, cookie: setCookie.split(';')[0]! };
    const session = await t.app.inject({ url: '/api/manage/session', headers });
    expect(session.json().user.workspace.name).toBe('신규 조직');
    expect((await t.app.inject({ method: 'DELETE', url: '/api/manage/session', headers })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/sites', headers })).statusCode).toBe(401);
    const expired = await issueAdminLink(t.sql);
    await t.sql`update installation_admin_links set expires_at = now() - interval '1 second'`;
    expect((await t.app.inject({ method: 'POST', url: '/api/manage/exchange', headers: { ...HOST, origin: t.ctx.config.publicOrigin }, payload: { token: expired.token } })).statusCode).toBe(401);
  } finally { await t.close(); }
});

it('여러 기존 작업공간의 데이터와 과거 연락처를 보존하고 선택한 곳의 권한만 회전한다', async () => {
  const t = await startTestApp();
  try {
    const a = await installManager(t, '운영 A', 'real-owner@example.com');
    const b = await installManager(t, '운영 B');
    const { site } = await createSite(t, a.headers, '기존 프로젝트');
    const [actor] = await t.sql`select user_id from members where workspace_id = ${a.workspaceId}`;
    const old = randomToken();
    await t.sql`insert into sessions (id, user_id, expires_at) values (${sha256(old)}, ${actor!.user_id}, now() + interval '1 hour')`;
    expect((await t.app.inject({ url: '/api/sites', headers: { ...HOST, cookie: `gp_session=${old}` } })).statusCode).toBe(401);
    await expect(issueAdminLink(t.sql)).rejects.toThrow('--workspace');
    const stale = await issueAdminLink(t.sql, a.workspaceId);
    const next = await issueAdminLink(t.sql, a.workspaceId);
    const exchange = (token: string) => t.app.inject({ method: 'POST', url: '/api/manage/exchange', headers: { ...HOST, origin: t.ctx.config.publicOrigin }, payload: { token } });
    expect((await exchange(stale.token)).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/sites', headers: a.headers })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/sites', headers: b.headers })).json().sites).toEqual([]);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/sites/${site.id}`, headers: b.headers })).statusCode).toBe(404);
    const response = await exchange(next.token);
    const headers = { ...HOST, cookie: String(response.headers['set-cookie']).split(';')[0]! };
    expect((await t.app.inject({ url: `/api/sites/${site.id}`, headers })).json().site.name).toBe('기존 프로젝트');
    expect((await t.sql`select email from users where id = ${actor!.user_id}`)[0]!.email).toBe('real-owner@example.com');
  } finally { await t.close(); }
});


it('같은 호스트의 paired HTTP와 HTTPS는 관리 쿠키와 로그아웃·링크 회전을 분리한다', async () => {
  const httpOrigin = 'http://review.example:3080';
  const httpsOrigin = 'https://review.example:3443';
  const http = await startTestApp({
    PUBLIC_URL: httpOrigin,
    PEER_REVIEW_URL: httpsOrigin,
    ALLOWED_HOSTS: 'localhost:80',
  });
  let httpsApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    // 서로 다른 작업공간이 한 데이터베이스를 쓰더라도 각 회전은 해당 작업공간에만 적용된다.
    const httpsCtx = {
      ...http.ctx,
      config: {
        ...http.ctx.config, publicUrl: httpsOrigin, publicOrigin: httpsOrigin, secureCookies: true,
        allowedHosts: new Set(['localhost:80', 'review.example:3443']), peerReviewUrl: httpOrigin,
      },
    };
    httpsApp = await buildApp(httpsCtx, { logger: false });
    const https = { ...http, app: httpsApp, ctx: httpsCtx };
    const httpsOwner = await installManager(https, 'HTTPS 검수');
    const httpOwner = await installManager(http, 'HTTP 검수');
    expect(String(httpsOwner.res.headers['set-cookie'])).toMatch(/^gp_install_session=.+; Secure(?:;|$)/);
    expect(String(httpOwner.res.headers['set-cookie'])).toMatch(/^gp_install_http_session=/);
    expect(String(httpOwner.res.headers['set-cookie'])).not.toMatch(/; Secure(?:;|$)/);
    const both = (httpCookie: string, httpsCookie: string) => ({ ...HOST, cookie: `${httpCookie}; ${httpsCookie}` });
    const user = async (app: typeof http.app, headers: Record<string, string>) =>
      (await app.inject({ url: '/api/manage/session', headers })).json().user?.workspace.name ?? null;

    const combined = both(httpOwner.cookie, httpsOwner.cookie);
    expect(await user(http.app, combined)).toBe('HTTP 검수');
    expect(await user(httpsApp, combined)).toBe('HTTPS 검수');
    expect(await user(http.app, httpsOwner.headers)).toBeNull();
    expect(await user(httpsApp, httpOwner.headers)).toBeNull();

    const rotate = async (owner: typeof httpOwner, app: typeof http.app, origin: string) => {
      const { token } = await issueAdminLink(http.sql, owner.workspaceId);
      const res = await app.inject({ method: 'POST', url: '/api/manage/exchange', headers: { ...HOST, origin }, payload: { token } });
      expect(res.statusCode).toBe(200);
      return String(res.headers['set-cookie']).split(';')[0]!;
    };

    const nextHttp = await rotate(httpOwner, http.app, httpOrigin);
    expect(await user(http.app, combined)).toBeNull();
    expect(await user(httpsApp, combined)).toBe('HTTPS 검수');
    const nextHttps = await rotate(httpsOwner, httpsApp, httpsOrigin);
    expect(await user(httpsApp, both(nextHttp, httpsOwner.cookie))).toBeNull();
    expect(await user(http.app, both(nextHttp, httpsOwner.cookie))).toBe('HTTP 검수');

    const current = both(nextHttp, nextHttps);
    const httpLogout = await http.app.inject({ method: 'DELETE', url: '/api/manage/session', headers: current });
    expect(String(httpLogout.headers['set-cookie'])).toMatch(/^gp_install_http_session=;/);
    expect(await user(http.app, current)).toBeNull();
    expect(await user(httpsApp, current)).toBe('HTTPS 검수');

    const lastHttp = await rotate(httpOwner, http.app, httpOrigin);
    const httpsLogout = await httpsApp.inject({ method: 'DELETE', url: '/api/manage/session', headers: both(lastHttp, nextHttps) });
    expect(String(httpsLogout.headers['set-cookie'])).toMatch(/^gp_install_session=;/);
    expect(await user(httpsApp, both(lastHttp, nextHttps))).toBeNull();
    expect(await user(http.app, both(lastHttp, nextHttps))).toBe('HTTP 검수');
  } finally {
    await httpsApp?.close();
    await http.close();
  }
});
