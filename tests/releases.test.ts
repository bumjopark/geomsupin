import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { pruneReleases, switchRuntime } from '../scripts/releases.ts';

it('릴리스 실행기는 기존 설정 해석을 유지하고 원래 데이터 폴더를 사용한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gp-launcher-'));
  try {
    const runtime = join(root, '.local/releases/example/app');
    await mkdir(join(runtime, 'node_modules/tsx/dist'), { recursive: true });
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'shared'));
    await copyFile(new URL('../shared/env-file.mjs', import.meta.url), join(root, 'shared/env-file.mjs'));
    await copyFile(new URL('../scripts/serve-release.mjs', import.meta.url), join(root, 'scripts/serve-release.mjs'));
    await symlink(runtime, join(root, '.local/current'));
    await writeFile(join(root, '.env'), 'DATA_DIR="./kept-data"\nGP_LAUNCH_TEST=value#with=signs\nBACKUP_DIR=./kept-backups\n');
    await writeFile(join(runtime, 'node_modules/tsx/dist/cli.mjs'), 'console.log(JSON.stringify({ cwd:process.cwd(), data:process.env.DATA_DIR, dist:process.env.DIST_DIR, value:process.env.GP_LAUNCH_TEST, mode:process.env.NODE_ENV, entry:process.argv[2], args:process.argv.slice(3), backups:process.env.BACKUP_DIR }))');
    const { DATA_DIR: _data, DIST_DIR: _dist, BACKUP_DIR: _backups, ...env } = process.env;
    const result = await promisify(execFile)(process.execPath, [join(root, 'scripts/serve-release.mjs')], { env });
    const backup = await promisify(execFile)(process.execPath, [join(root, 'scripts/serve-release.mjs'), '--backup', '--kind', 'scheduled'], { env });
    expect(JSON.parse(backup.stdout).entry).toBe(join(runtime, 'scripts/backup.ts'));
    expect(JSON.parse(backup.stdout).args).toEqual(['--kind', 'scheduled']);
    expect(JSON.parse(backup.stdout).backups).toBe(join(root, 'kept-backups'));
    expect(JSON.parse(backup.stdout).data).toBe(join(root, 'kept-data'));
    expect(JSON.parse(result.stdout)).toEqual({ cwd: runtime, data: join(root, 'kept-data'), dist: join(runtime, 'dist'), value: 'value#with=signs', mode: 'production', entry: join(runtime, 'server/index.ts'), args: [], backups: join(root, 'kept-backups') });
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const fail of [false, true]) it(`릴리스 교체: ${fail ? '시작 후 점검 실패 시 이전 코드·정적 파일로 복귀' : '검증된 코드·정적 파일을 함께 반영'}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gp-release-'));
  const before = join(root, 'before'), after = join(root, 'after');
  try {
    for (const [runtime, version] of [[before, 'old'], [after, 'new']] as const) {
      await mkdir(join(runtime, 'dist'), { recursive: true });
      await writeFile(join(runtime, 'server.ts'), version);
      await writeFile(join(runtime, 'dist/index.html'), version);
    }
    await symlink(before, join(root, 'current'));
    const events: string[] = [];
    const started: string[] = [];
    const result = switchRuntime({ stateDir: root, next: after, previous: before,
      stop: async () => { events.push('stop'); },
      start: async () => {
        events.push('start');
        const runtime = await realpath(join(root, 'current'));
        started.push(await readFile(join(runtime, 'server.ts'), 'utf8'));
        expect(await readFile(join(runtime, 'dist/index.html'), 'utf8')).toBe(started.at(-1));
      },
      smoke: async runtime => { events.push('smoke'); if (runtime === after && fail) throw new Error('static response mismatch'); },
    });
    if (fail) await expect(result).rejects.toThrow('이전 릴리스를 다시 시작'); else await result;
    expect(await realpath(join(root, 'current'))).toBe(fail ? before : after);
    expect(started).toEqual(fail ? ['new', 'old'] : ['new']);
    expect(events).toEqual(fail ? ['stop', 'start', 'smoke', 'stop', 'start', 'smoke'] : ['stop', 'start', 'smoke']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('기존 서비스 중지에 실패하면 현재 릴리스를 바꾸지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gp-release-'));
  try {
    await mkdir(join(root, 'old')); await symlink(join(root, 'old'), join(root, 'current'));
    await expect(switchRuntime({ stateDir: root, next: join(root, 'new'), previous: join(root, 'old'), stop: async () => { throw new Error('stop failed'); }, start: async () => { throw new Error('must not start'); }, smoke: async () => {} })).rejects.toThrow('stop failed');
    expect(await realpath(join(root, 'current'))).toBe(join(root, 'old'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('릴리스 정리는 현재·직전·최근 준비본을 남기고 오래된 런타임만 제거한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gp-prune-'));
  try {
    const paths = [];
    for (let i = 1; i <= 5; i++) {
      const directory = join(root, 'releases', `abcdef${i}-2026100${i}T000000000Z`);
      await mkdir(join(directory, 'app'), { recursive: true });
      await writeFile(join(directory, 'source.tar'), 'archive');
      await writeFile(join(directory, i === 5 ? 'prepared.json' : 'deployed.json'), '{}');
      paths.push(directory);
    }
    await symlink(join(paths[3]!, 'app'), join(root, 'current'));
    await writeFile(join(root, 'deploy-current.json'), JSON.stringify({ previous: join(paths[2]!, 'app') }));
    await pruneReleases(root);
    const { readdir } = await import('node:fs/promises');
    const remaining = await readdir(join(root, 'releases'));
    expect(remaining.sort()).toEqual(paths.slice(1).map(p => p.split('/').at(-1)).sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
