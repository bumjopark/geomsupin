import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { buildConfig, loadConfig } from '../server/config.ts';
import { connect, migrate, type Sql } from '../server/db.ts';
import { LocalStorage } from '../server/storage.ts';
import { buildApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import { issueAdminLink } from '../server/installation-admin.ts';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  sql: Sql;
  dir: string;
  close: () => Promise<void>;
}

/** 테스트 전용 DB(geomsupin_test)와 임시 데이터 폴더로 앱을 띄운다. */
export async function startTestApp(extraEnv: Record<string, string> = {}): Promise<TestApp> {
  const liveConfig = loadConfig();
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL 이 필요합니다 (.env)');
  // 스키마를 통째로 지우므로 테스트 DB 가 아니면 절대 진행하지 않는다.
  const database = decodeURIComponent(new URL(testUrl).pathname);
  if (!/^\/[a-z0-9_]+_test$/i.test(database)) throw new Error('TEST_DATABASE_URL 은 *_test 데이터베이스여야 합니다');
  if (database === decodeURIComponent(new URL(liveConfig.databaseUrl).pathname)) throw new Error('운영 DB를 테스트 DB로 사용할 수 없습니다');
  // 별도 연결로 잠금을 유지한다. API 경합 시험이 쓰는 풀의 연결 수를 줄이지 않는다.
  const guard = connect(testUrl, 1);
  const sql = connect(testUrl, 5);
  let releaseGuard: (() => void) | undefined;
  let dir: string | undefined;
  let app: FastifyInstance | undefined;
  const close = async () => {
    try { await app?.close(); }
    finally {
      try { await sql.end({ timeout: 2 }); }
      finally {
        releaseGuard?.();
        await guard.end({ timeout: 2 });
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    }
  };
  try {
    const held = await guard.reserve();
    releaseGuard = () => held.release();
    const [lock] = await held`select pg_try_advisory_lock(7302027) as locked`;
    if (!lock!.locked) throw new Error('다른 테스트가 이 DB를 사용 중입니다. DB 시험은 순서대로 실행하세요');
    dir = mkdtempSync(join(tmpdir(), 'gp-test-'));
    const config = buildConfig({
      ...process.env,
      PORT: '0',
      PUBLIC_URL: 'http://localhost:80',
      PEER_REVIEW_URL: '',
      ALLOWED_HOSTS: 'localhost:80,localhost',
      IMAGE_PROXY_ALLOW_PRIVATE: 'false',
      ...extraEnv,
      DATABASE_URL: testUrl,
      DATA_DIR: dir,
    });
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await migrate(sql);
    const ctx: AppContext = { config, sql, storage: new LocalStorage(dir) };
    app = await buildApp(ctx, { logger: false });
    await app.ready();
    return { app, ctx, sql, dir, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export const HOST = { host: 'localhost:80' };

/** 독립된 테스트 작업공간에 실제 관리 링크 교환으로 권한을 부여한다. */
export async function installManager(t: TestApp, name = '테스터', contact?: string) {
  const workspaceId = randomUUID();
  const owner = randomUUID();
  await t.sql.begin(async tx => {
    await tx`insert into workspaces (id, name) values (${workspaceId}, ${name})`;
    await tx`insert into users (id, name, email) values (${owner}, ${name}, ${contact ?? null})`;
    await tx`insert into members (workspace_id, user_id) values (${workspaceId}, ${owner})`;
  });
  const { token } = await issueAdminLink(t.sql, workspaceId);
  const res = await t.app.inject({
    method: 'POST', url: '/api/manage/exchange', headers: { ...HOST, origin: t.ctx.config.publicOrigin }, payload: { token },
  });
  const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  return { res, cookie, workspaceId, headers: { ...HOST, cookie } };
}

/** 프로젝트를 만들고 초대 토큰을 돌려준다. */
export async function createSite(t: TestApp, headers: Record<string, string>, name: string, previewUrl?: string) {
  const res = await t.app.inject({ method: 'POST', url: '/api/sites', headers, payload: { name } });
  if (res.statusCode !== 200) throw new Error(res.body);
  let { site } = res.json();
  if (previewUrl) {
    const connected = await t.app.inject({ method: 'PATCH', url: `/api/sites/${site.id}`, headers, payload: { previewUrl } });
    if (connected.statusCode !== 200) throw new Error(connected.body);
    site = connected.json().site;
  }
  return { site, token: String(site.links[0].shareUrl).split('/r/')[1] as string };
}

export async function openReviewer(t: TestApp, headers: Record<string, string>, token: string, { name, pid = randomUUID() }: { name?: string; pid?: string } = {}) {
  const [site] = await t.sql`select preview_id from sites where widget_key = ${headers['x-gp-key'] ?? ''}`;
  const res = await t.app.inject({
    method: 'POST', url: '/api/w/session', headers: { ...headers, origin: t.ctx.config.publicOrigin },
    payload: { token, pid, previewId: site?.preview_id },
  });
  if (name && res.statusCode === 200) {
    const renamed = await t.app.inject({
      method: 'PATCH', url: '/api/w/reviewer', headers: { ...headers, authorization: `Bearer ${res.json().session}` },
      payload: { name },
    });
    if (renamed.statusCode !== 200) throw new Error(renamed.body);
  }
  return res;
}

/** 색이 있는 테스트용 PNG data URL (크기 지정) */
export async function pngDataUrl(w = 800, h = 500, color = '#3b82f6'): Promise<string> {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}
