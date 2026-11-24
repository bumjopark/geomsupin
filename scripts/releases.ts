import { lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

async function point(stateDir: string, runtime: string) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const pending = join(stateDir, `.current-${randomUUID()}`);
  try { await symlink(runtime, pending); await rename(pending, join(stateDir, 'current')); }
  finally { await rm(pending, { force: true }); }
}

/** 코드·의존성·정적 파일을 함께 교체한다. 실패 시 이전 런타임을 다시 시작한다(DB는 역마이그레이션하지 않는다). */
export async function switchRuntime(options: {
  stateDir: string; next: string; previous: string;
  stop: () => Promise<void>; start: () => Promise<void>; smoke: (runtime: string) => Promise<void>;
}) {
  await options.stop();
  try {
    await point(options.stateDir, options.next);
    await options.start();
    await options.smoke(options.next);
  } catch (failure) {
    try {
      await options.stop(); await point(options.stateDir, options.previous);
      await options.start(); await options.smoke(options.previous);
    } catch (rollback) { throw new AggregateError([failure, rollback], '배포와 이전 릴리스 재시작이 모두 실패했습니다. 서비스 로그를 확인하세요.'); }
    throw new Error('배포 점검에 실패해 이전 릴리스를 다시 시작했습니다.', { cause: failure });
  }
}

/** 성공한 배포 뒤에만 실행한다. 현재·복귀 대상과 최근 준비본은 절대 지우지 않는다. */
export async function pruneReleases(stateDir: string, keep = 3, now = Date.now()) {
  const releases = resolve(stateDir, 'releases');
  const current = await realpath(join(stateDir, 'current'));
  const live = JSON.parse(await readFile(join(stateDir, 'deploy-current.json'), 'utf8'));
  const protectedDirs = new Set([dirname(current), dirname(live.previous)]);
  try {
    const prepared = JSON.parse(await readFile(join(dirname(current), 'prepared.json'), 'utf8'));
    protectedDirs.add(dirname(prepared.previous));
  } catch { /* 최초 기준 릴리스에는 prepared.json이 없다 */ }
  const completed: string[] = [];
  const abandoned: string[] = [];
  for (const entry of await readdir(releases, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(baseline-)?[a-f0-9]{7}-\d{8}T\d{9}Z$/.test(entry.name)) continue;
    const directory = join(releases, entry.name);
    if (protectedDirs.has(directory)) continue;
    try {
      await lstat(join(directory, 'source.tar')); // 배포 도구가 만든 폴더만 관리
      const names = await readdir(directory);
      if (names.includes('deployed.json') || names.includes('baseline.json')) completed.push(directory);
      else if ((await lstat(directory)).mtimeMs < now - 7 * 24 * 3600_000) abandoned.push(directory);
    } catch { /* 불완전하거나 알 수 없는 폴더는 보존 */ }
  }
  // 보호 대상은 보존 개수에 포함한다. 이름의 앞 커밋 대신 시간 부분으로 정렬한다.
  completed.sort((a, b) => b.slice(-20).localeCompare(a.slice(-20)));
  const remove = [...completed.slice(Math.max(0, keep - protectedDirs.size)), ...abandoned];
  for (const directory of remove) {
    if (!directory.startsWith(releases + sep) || protectedDirs.has(directory)) throw new Error('릴리스 보존 경로 확인 실패');
    await rm(directory, { recursive: true });
  }
  return remove;
}
