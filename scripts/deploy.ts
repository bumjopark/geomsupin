import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { createBackup } from '../server/backup.ts';
import { loadConfig, ROOT } from '../server/config.ts';
import { pruneReleases, switchRuntime } from './releases.ts';

const config = loadConfig();
const configHash = createHash('sha256').update(JSON.stringify({ ...config, allowedHosts: [...config.allowedHosts].sort() })).digest('hex');
const state = join(ROOT, '.local');
const releases = join(state, 'releases');
const env = { ...process.env, DATA_DIR: config.dataDir };
const run = (cmd: string, args: string[], cwd = ROOT) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const stamp = () => new Date().toISOString().replace(/[-:.]/g, '');
const metadata = async (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const sc = async (action: string) => { run('systemctl', ['--user', action, 'geomsupin-api.service']); };

async function runtimeHash(app: string) {
  const hash = createHash('sha256');
  for (const dir of ['server', 'shared', 'scripts', 'demo', 'dist', 'node_modules']) {
    const files = (await readdir(join(app, dir), { recursive: true, withFileTypes: true })).filter(f => f.isFile()).map(f => join(f.parentPath, f.name)).sort();
    for (const file of files) { hash.update(file.slice(app.length)); hash.update('\0'); hash.update(await readFile(file)); hash.update('\0'); }
  }
  hash.update(await readFile(join(app, 'package-lock.json')));
  return hash.digest('hex');
}

async function extract(commit: string, directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const app = join(directory, 'app'); await mkdir(app);
  run('git', ['archive', '--format=tar', `--output=${join(directory, 'source.tar')}`, commit]);
  run('tar', ['-xf', join(directory, 'source.tar'), '-C', app]);
  run('npm', ['ci', '--include=dev', process.argv.includes('--offline') ? '--offline' : '--prefer-offline'], app);
  return app;
}

async function current(): Promise<string> {
  if (existsSync(join(state, 'current'))) {
    const app = await realpath(join(state, 'current'));
    assert.ok(app.startsWith(releases + sep), '잘못된 현재 릴리스 경로');
    return app;
  }
  // 최초 전환은 이전 배포 기록의 실제 커밋과 현재 정적 파일을 보존한다.
  assert.ok(existsSync(join(state, 'deploy-current.json')), '이전 배포 기록이 없습니다. 최초 전환은 --baseline <실제 운영 커밋>으로 기록한 뒤 준비하세요.');
  const old = JSON.parse(await readFile(join(state, 'deploy-current.json'), 'utf8'));
  assert.match(old.commit, /^[a-f0-9]{40}$/);
  const directory = join(releases, `baseline-${old.commit.slice(0, 7)}-${stamp()}`);
  const app = await extract(old.commit, directory);
  await cp(config.distDir, join(app, 'dist'), { recursive: true });
  await metadata(join(directory, 'baseline.json'), { commit: old.commit, recordedAt: new Date().toISOString() });
  return app;
}

async function preserveAssets(old: string, app: string) {
  // 직전 릴리스에서 이미 열린 브라우저가 요청할 파일만 한 세대 유지한다.
  const previous = join(old, 'dist');
  const manifest = JSON.parse(await readFile(join(previous, 'widget/manifest.json'), 'utf8'));
  const html = await readFile(join(previous, 'admin/index.html'), 'utf8');
  const files = [...html.matchAll(/(?:src|href)="\/(assets\/[A-Za-z0-9_.-]+)"/g)].map(match => join('admin', match[1]!));
  for (const name of [manifest.core, manifest.capture]) {
    assert.match(name, /^w-(?:core|capture)\.[a-f0-9]{10}\.js$/);
    files.push(join('widget', name));
  }
  for (const file of files) {
    const target = join(app, 'dist', file);
    if (!existsSync(target)) await cp(join(previous, file), target);
  }
}

async function smoke(app: string) {
  const base = `http://127.0.0.1:${config.port}`;
  const headers = { host: new URL(config.publicUrl).host };
  for (let i = 0; ; i++) {
    try { const response = await fetch(base + '/healthz', { headers, signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); break; }
    catch (error) { if (i === 20) throw error; await new Promise(r => setTimeout(r, 500)); }
  }
  const manifest = JSON.parse(await readFile(join(app, 'dist/widget/manifest.json'), 'utf8'));
  for (const path of ['/w.js', `/${manifest.core}`, `/${manifest.capture}`, '/']) {
    const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200, path);
    const local = path === '/' ? 'admin/index.html' : `widget/${path.slice(1)}`;
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(app, 'dist', local)), `${path}: 반영된 파일 불일치`);
  }
}

await mkdir(releases, { recursive: true, mode: 0o700 });
const lock = join(state, 'deploy.lock');
await mkdir(lock).catch(() => { throw new Error('다른 배포가 실행 중입니다. 중단된 배포라면 프로세스·서비스 확인 후 .local/deploy.lock을 제거하세요.'); });
try {
  const [action, id] = process.argv.slice(2);
  if (action === '--baseline' && id) {
    assert.match(id, /^[a-f0-9]{7,40}$/);
    assert.ok(!existsSync(join(state, 'current')) && !existsSync(join(state, 'deploy-current.json')), '기존 배포 기록을 덮어쓸 수 없습니다');
    const commit = git('rev-parse', `${id}^{commit}`);
    await metadata(join(state, 'deploy-current.json'), { commit, recordedAt: new Date().toISOString() });
    console.log(`기존 운영 커밋 기록: ${commit}. 이제 --prepare를 실행하세요.`);
  } else if (action === '--prepare') {
    assert.equal(git('status', '--porcelain'), '', '먼저 변경을 커밋하고 작업 폴더를 정리하세요');
    const commit = git('rev-parse', 'HEAD');
    const previous = await current();
    // 구버전 백업 CLI는 ROOT/.env를 읽는다. 비밀값을 복사하지 않고 원래 설정을 연결해
    // 첫 전환 및 코드 복귀 후에도 같은 런타임의 백업을 실행할 수 있게 한다.
    if (!existsSync(join(previous, '.env'))) await symlink(join(ROOT, '.env'), join(previous, '.env'));
    const directory = join(releases, `${commit.slice(0, 7)}-${stamp()}`);
    const app = await extract(commit, directory);
    // 검증은 릴리스 내부의 별도 빌드·테스트 DB에서만 실행한다.
    execFileSync('npm', ['run', 'check'], { cwd: app, env: { ...env, DIST_DIR: join(app, 'dist-test') }, stdio: 'inherit' });
    await rename(join(app, 'dist-test'), join(app, 'dist'));
    await rename(join(app, 'test-results'), join(directory, 'test-results'));
    if (!process.argv.includes('--current-assets-only')) await preserveAssets(previous, app);
    const loadTest = JSON.parse(await readFile(join(directory, 'test-results/load.json'), 'utf8'));
    await metadata(join(directory, 'prepared.json'), { commit, configHash, previous, previousHash: await runtimeHash(previous), runtimeHash: await runtimeHash(app), loadTest, preparedAt: new Date().toISOString() });
    console.log(`검증 완료. 반영: npm run deploy -- --activate ${basename(directory)}`);
  } else if (action === '--activate' && id) {
    assert.match(id, /^[a-z0-9-]+$/i);
    const directory = join(releases, id);
    const prepared = JSON.parse(await readFile(join(directory, 'prepared.json'), 'utf8'));
    const app = join(directory, 'app');
    assert.equal(configHash, prepared.configHash, '준비 후 운영 설정이 바뀌었습니다. 다시 준비하세요');
    assert.equal(await runtimeHash(app), prepared.runtimeHash, '검증 후 릴리스 내용이 바뀌었습니다');
    if (existsSync(join(state, 'current'))) assert.equal(await realpath(join(state, 'current')), prepared.previous, '준비 후 다른 배포가 진행됐습니다. 다시 준비하세요');
    const unit = execFileSync('systemctl', ['--user', 'show', 'geomsupin-api', '--property=ExecStart', '--value'], { encoding: 'utf8' });
    assert.ok(unit.includes(join(ROOT, 'scripts/serve-release.mjs')), '먼저 npm run services:install로 새 서비스 진입점을 등록하세요');
    const backup = await createBackup({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, backupDir: process.env.BACKUP_DIR || join(config.dataDir, 'backups'), mirrorDir: process.env.BACKUP_MIRROR_DIR || undefined, envFile: join(ROOT, '.env'), kind: 'deployment' });
    const record = { commit: prepared.commit, directory, runtime: app, previous: prepared.previous, backup: backup.directory, deployedAt: new Date().toISOString() };
    await metadata(join(directory, 'activation.json'), record);
    await switchRuntime({ stateDir: state, next: app, previous: prepared.previous, stop: () => sc('stop'), start: () => sc('start'), smoke });
    await metadata(join(directory, 'deployed.json'), record);
    await metadata(join(state, 'deploy-current.json'), record);
    const removed = await pruneReleases(state).catch(() => { console.warn('오래된 릴리스 정리 실패: 운영 반영은 완료됐습니다. 디스크를 확인하세요.'); return []; });
    if (removed.length) console.log(`오래된 릴리스 ${removed.length}개 정리`);
    console.log(`배포·스모크 점검 완료: ${prepared.commit.slice(0, 7)}. 이전 런타임: ${prepared.previous}`);
  } else if (action === '--rollback' && id) {
    assert.match(id, /^[a-z0-9-]+$/i);
    const directory = join(releases, id);
    const prepared = JSON.parse(await readFile(join(directory, 'prepared.json'), 'utf8'));
    const app = join(directory, 'app');
    assert.equal(await realpath(join(state, 'current')), app, '현재 실행 중인 릴리스 ID를 지정하세요');
    assert.equal(await runtimeHash(prepared.previous), prepared.previousHash, '이전 릴리스 내용이 바뀌었습니다');
    const backup = await createBackup({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, backupDir: process.env.BACKUP_DIR || join(config.dataDir, 'backups'), mirrorDir: process.env.BACKUP_MIRROR_DIR || undefined, envFile: join(ROOT, '.env'), kind: 'deployment' });
    await switchRuntime({ stateDir: state, next: prepared.previous, previous: app, stop: () => sc('stop'), start: () => sc('start'), smoke });
    const oldDirectory = dirname(prepared.previous);
    const old = JSON.parse(await readFile(join(oldDirectory, existsSync(join(oldDirectory, 'baseline.json')) ? 'baseline.json' : 'prepared.json'), 'utf8'));
    const record = { commit: old.commit, directory: oldDirectory, runtime: prepared.previous, previous: app, backup: backup.directory, rolledBackFrom: id, deployedAt: new Date().toISOString() };
    await metadata(join(directory, 'rolled-back.json'), record);
    await metadata(join(state, 'deploy-current.json'), record);
    console.log(`이전 릴리스 재시작·점검 완료: ${old.commit.slice(0, 7)}`);
  } else throw new Error('사용법: npm run deploy -- --prepare | --activate <릴리스 ID> | --rollback <현재 릴리스 ID> | --baseline <기존 운영 커밋>');
} finally { await rm(lock, { recursive: true, force: true }); }
