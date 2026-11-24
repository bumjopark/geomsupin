import { loadEnvFile } from '../shared/env-file.mjs';
// 운영 dist를 덮어쓰지 않고 Git에 올릴 소스를 처음부터 순서대로 검증한다.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
loadEnvFile(resolve(root, '.env'));
if (!process.env.PLAYWRIGHT_EDGE_EXECUTABLE) console.warn('Edge 실행 경로 미설정: 이번 검증은 Chromium·Firefox만 실행합니다.');
const dist = resolve(root, process.env.DIST_DIR || 'dist-test');
if (dist === resolve(root, 'dist')) throw new Error('검증 빌드는 운영 dist와 다른 DIST_DIR을 사용해야 합니다');
for (const script of ['typecheck', 'build', 'test', 'test:browser']) {
  const result = spawnSync('npm', ['run', script], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DIST_DIR: dist },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
