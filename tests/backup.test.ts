import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scheduledBackupStatus } from '../server/backup-status.ts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, restoreBackup, verifyBackup } from '../server/backup.ts';
import { migrate } from '../server/db.ts';
import { newCaptureKey } from '../server/storage.ts';
import { createSite, openReviewer, HOST, pngDataUrl, installManager, startTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
let root: string;
let id: string;
let screenshot: string;
let options: Parameters<typeof createBackup>[0];
beforeAll(async () => {
  t = await startTestApp(); root = await mkdtemp(join(tmpdir(), 'gp-backup-test-'));
  const admin = (await installManager(t)).headers;
  const { site, token } = await createSite(t, admin, '복구 검수', 'http://review.example');
  const headers = { ...HOST, origin: 'http://review.example', 'x-gp-key': site.widgetKey };
  const session = (await openReviewer(t, headers, token, { name: '복구자' })).json();
  const result = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: { ...headers, authorization: `Bearer ${session.session}` }, payload: { pageUrl: 'http://review.example/', viewportW: 1200, viewportH: 800, body: '복구할 요청', screenshot: await pngDataUrl(80, 80) } });
  expect(result.statusCode).toBe(200); id = result.json().request.id;
  await t.sql`insert into comments (request_id, author_type, author_name, body) values (${id}, 'agency', '팀장', '복구할 대화')`;
  screenshot = (await t.sql`select screenshot_key from requests where id = ${id}`)[0]!.screenshot_key;
  await writeFile(join(root, 'test.env'), 'SECRET=test-only\n');
  options = { databaseUrl: t.ctx.config.databaseUrl, dataDir: t.dir, backupDir: join(root, 'backups'), envFile: join(root, 'test.env') };
});
afterAll(async () => { await t?.close(); if (root) await rm(root, { recursive: true, force: true }); });

it('DB·캡처·설정을 함께 백업하고 해시를 확인한다', async () => {
  const b = await createBackup(options);
  const manifest = await verifyBackup(b.directory);
  expect(manifest.requests).toBe(1);
  expect(manifest.files).toHaveLength(4);
  expect(await readFile(join(b.directory, screenshot))).toEqual(await readFile(join(t.dir, screenshot)));
  expect(await readFile(join(b.directory, 'config.env'), 'utf8')).toBe('SECRET=test-only\n');
});

it('외부 폴더 복사도 검증하고 완성된 백업만 지정 개수로 보존한다', async () => {
  const mirror = join(root, 'mirror'); await mkdir(mirror);
  await writeFile(join(options.backupDir, 'legacy.dump'), 'keep');
  await mkdir(join(options.backupDir, 'unrelated'));
  for (let i = 0; i < 3; i++) await createBackup({ ...options, mirrorDir: mirror, keep: 2 });
  const names = (await readdir(options.backupDir)).filter((n) => n.startsWith('geomsupin-'));
  expect(names).toHaveLength(2);
  expect((await readdir(mirror)).sort()).toEqual(names.sort());
  for (const name of names) {
    expect((await stat(join(mirror, name))).mode & 0o777).toBe(0o700);
    expect((await stat(join(mirror, name, 'config.env'))).mode & 0o777).toBe(0o600);
  }
  expect(await readFile(join(options.backupDir, 'legacy.dump'), 'utf8')).toBe('keep');
  expect(await readdir(join(options.backupDir, 'unrelated'))).toEqual([]);
});

it('수동·배포 전 백업은 야간 백업이나 종류를 모르는 구버전 백업을 밀어내지 않는다', async () => {
  const dir = join(root, 'separate');
  const opts = { ...options, backupDir: dir, keep: 2 };
  const legacy = await createBackup(opts);
  const { kind: _kind, ...oldManifest } = legacy.manifest;
  await writeFile(join(legacy.directory, 'manifest.json'), JSON.stringify(oldManifest));
  const scheduled = await createBackup({ ...opts, kind: 'scheduled' });
  for (const kind of ['manual', 'deployment'] as const) {
    for (let i = 0; i < 3; i++) await createBackup({ ...opts, kind });
  }
  expect(await readdir(dir)).toHaveLength(6); // 구버전 1 + 야간 1 + 수동 2 + 배포 2
  expect((await verifyBackup(scheduled.directory)).kind).toBe('scheduled');
  expect((await verifyBackup(legacy.directory)).kind).toBeUndefined();
});

it('외부 복사 실패와 손상된 manifest가 로컬 백업 보존을 막지 않는다', async () => {
  const dir = join(root, 'mirror-failure');
  const opts = { ...options, backupDir: dir, keep: 2, mirrorDir: join(root, 'unmounted') };
  await mkdir(dir);
  const damaged = join(dir, 'geomsupin-20200101T000000000Z-deadbeef');
  await mkdir(damaged); await writeFile(join(damaged, 'manifest.json'), '{broken');
  const missing = join(dir, 'geomsupin-20200101T000000000Z-deadbee0');
  await mkdir(missing);
  for (let i = 0; i < 4; i++) await expect(createBackup(opts)).rejects.toThrow();
  const names = (await readdir(dir)).filter(name => !name.startsWith('geomsupin-2020'));
  expect(names).toHaveLength(2);
  for (const name of names) expect((await verifyBackup(join(dir, name))).requests).toBe(1);
  expect(await readFile(join(damaged, 'manifest.json'), 'utf8')).toBe('{broken');
  expect(await readdir(missing)).toEqual([]);
});

it('야간 백업 CLI는 외부 복사 실패를 기록하고 다음 성공 때 복구 상태로 바꾼다', async () => {
  const env = { ...process.env, DATABASE_URL: options.databaseUrl, DATA_DIR: t.dir,
    BACKUP_DIR: join(root, 'scheduled-cli'), BACKUP_MIRROR_DIR: join(root, 'not-mounted'), GP_ENV_FILE: join(root, 'test.env') };
  const args = ['--import', 'tsx', 'scripts/backup.ts', '--kind', 'scheduled'];
  await expect(promisify(execFile)(process.execPath, args, { env })).rejects.toMatchObject({ code: 1 });
  expect((await scheduledBackupStatus(t.dir)).state).toBe('failed');
  await promisify(execFile)(process.execPath, args, { env: { ...env, BACKUP_MIRROR_DIR: '' } });
  expect((await scheduledBackupStatus(t.dir)).state).toBe('ok');
});

it('캡처가 하나라도 유실됐으면 성공으로 기록하지 않고 기존 백업을 지킨다', async () => {
  const before = await readdir(options.backupDir);
  const original = await readFile(join(t.dir, screenshot));
  await rm(join(t.dir, screenshot));
  try { await expect(createBackup(options)).rejects.toThrow(); }
  finally { await writeFile(join(t.dir, screenshot), original); }
  expect(await readdir(options.backupDir)).toEqual(before);
});

it('손상된 파일은 검증 및 복구를 거부한다', async () => {
  const b = await createBackup(options);
  await writeFile(join(b.directory, screenshot), 'damaged');
  await expect(verifyBackup(b.directory)).rejects.toThrow('무결성');
  await expect(restoreBackup({ backupDir: b.directory, databaseUrl: options.databaseUrl, dataDir: join(root, 'damaged-target') })).rejects.toThrow('무결성');
  await rm(b.directory, { recursive: true });
});

it('기존 DB·데이터 폴더를 덮어쓰지 않는다', async () => {
  const b = await createBackup(options);
  await expect(restoreBackup({ backupDir: b.directory, databaseUrl: options.databaseUrl, dataDir: t.dir })).rejects.toThrow('데이터 폴더가 비어');
  await expect(restoreBackup({ backupDir: b.directory, databaseUrl: options.databaseUrl, dataDir: join(root, 'nonempty-db') })).rejects.toThrow('DB가 비어');
  expect((await t.sql`select count(*)::int as n from requests`)[0]!.n).toBe(1);
});

it.each(['005', '006'])('%s DB에서 배포 전 백업이 참조된 캡처를 담는다', async (version) => {
  const original = await readFile(join(t.dir, screenshot));
  const proposal = version === '006' ? newCaptureKey('proposal', 'webp') : null;
  if (proposal) await t.ctx.storage.put(proposal, original);
  await t.sql.begin(async tx => {
    if (version === '005') {
      await tx`alter table requests drop column proposal_key`;
      await tx`alter table widget_sessions drop column preview_id`;
      await tx`alter table sites drop column preview_url, drop column preview_id`;
      await tx`delete from schema_migrations where name = '006_review_preview.sql'`;
    } else {
      await tx`update requests set proposal_key = ${proposal} where id = ${id}`;
    }
    await tx`drop table installation_admin_sessions, installation_admin_links`;
    await tx`update users set email = 'backup@example.com', password_hash = 'legacy-fixture'`;
    await tx`alter table users alter column email set not null, alter column password_hash set not null`;
    await tx`delete from schema_migrations where name = '007_installation_admin.sql'`;
  });
  try {
    const b = await createBackup({ ...options, kind: 'deployment' });
    const manifest = await verifyBackup(b.directory);
    expect(manifest.kind).toBe('deployment');
    expect(manifest.requests).toBe(1);
    expect(manifest.files).toHaveLength(proposal ? 5 : 4);
    expect(await readFile(join(b.directory, screenshot))).toEqual(original);
    if (proposal) expect(await readFile(join(b.directory, proposal))).toEqual(original);
  } finally {
    expect(await migrate(t.sql)).toEqual(version === '005' ? ['006_review_preview.sql', '007_installation_admin.sql'] : ['007_installation_admin.sql']);
    if (proposal) {
      await t.sql`update requests set proposal_key = null where id = ${id}`;
      await t.ctx.storage.delete(proposal);
    }
  }
  expect((await t.sql`select email, password_hash from users`)[0]).toMatchObject({ email: 'backup@example.com', password_hash: 'legacy-fixture' });
});

it('빈 테스트 DB와 새 폴더로 실제 복구하면 요청·대화·캡처·제안 이미지·설정이 모두 살아난다', async () => {
  const capture = await readFile(join(t.dir, screenshot));
  const proposal = newCaptureKey('proposal', 'webp');
  await t.ctx.storage.put(proposal, capture);
  await t.sql`update requests set proposal_key = ${proposal} where id = ${id}`;
  const b = await createBackup(options);
  expect((await verifyBackup(b.directory)).files.some(file => file.key === proposal)).toBe(true);
  // startTestApp에서 *_test 이름을 검사한 DB만 사용한다.
  await t.sql`drop schema public cascade`; await t.sql`create schema public`;
  const target = join(root, 'restored');
  const result = await restoreBackup({ backupDir: b.directory, databaseUrl: options.databaseUrl, dataDir: target });
  expect(result).toEqual({ requests: 1, captures: 3 });
  expect((await t.sql`select body, proposal_key from requests where id = ${id}`)[0]).toMatchObject({ body: '복구할 요청', proposal_key: proposal });
  expect((await t.sql`select body from comments where request_id = ${id}`)[0]!.body).toBe('복구할 대화');
  expect(await readFile(join(target, screenshot))).toEqual(capture);
  expect(await readFile(join(target, proposal))).toEqual(capture);
  expect(await readFile(join(target, 'recovered.env'), 'utf8')).toBe('SECRET=test-only\n');
}, 30_000);
