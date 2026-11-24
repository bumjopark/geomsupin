import { loadEnvFile } from '../shared/env-file.mjs';
// 운영 dist를 덮어쓰지 않고 Git에 올릴 소스를 처음부터 순서대로 검증한다.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const requestedDist = process.env.DIST_DIR;
const saved = {};
loadEnvFile(resolve(root, '.env'), saved);
loadEnvFile(resolve(root, '.env'));
if (!process.env.PLAYWRIGHT_EDGE_EXECUTABLE) console.warn('Edge 실행 경로 미설정: 이번 검증은 Chromium·Firefox만 실행합니다.');

function canonical(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    return join(canonical(parent), path.slice(parent.length));
  }
}
const dist = canonical(resolve(root, requestedDist || 'dist-test'));
for (const production of new Set(['dist', saved.DIST_DIR || 'dist'])) {
  const live = canonical(resolve(root, production));
  if (dist === live || dist.startsWith(live + sep) || live.startsWith(dist + sep)) {
    throw new Error('검증 빌드는 운영 dist와 다른 DIST_DIR을 사용해야 합니다');
  }
}
for (const script of ['typecheck', 'build', 'test', 'test:browser']) {
  const result = spawnSync('npm', ['run', script], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DIST_DIR: dist },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
