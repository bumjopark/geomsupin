import { loadEnvFile } from '../shared/env-file.mjs';
// 서비스의 고정 진입점. Git 작업 폴더를 갱신해도 실행 중인 릴리스의 소스·의존성은 바뀌지 않는다.
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const current = join(root, '.local/current');
const runtime = existsSync(current) ? realpathSync(current) : root;
if (runtime !== root && !runtime.startsWith(join(root, '.local/releases') + sep)) throw new Error('잘못된 릴리스 경로');
loadEnvFile(join(root, '.env'));
const backup = process.argv[2] === '--backup';
// 실행 cwd가 릴리스로 바뀌어도 사용자가 지정한 상대 백업 경로는 원래 설치 폴더 기준이다.
for (const key of ['BACKUP_DIR', 'BACKUP_MIRROR_DIR']) if (process.env[key]) process.env[key] = resolve(root, process.env[key]);
const child = spawn(process.execPath, [join(runtime, 'node_modules/tsx/dist/cli.mjs'), join(runtime, backup ? 'scripts/backup.ts' : 'server/index.ts'), ...(backup ? process.argv.slice(3) : [])], {
  cwd: runtime, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', GP_ENV_FILE: join(root, '.env'), DATA_DIR: resolve(root, process.env.DATA_DIR || 'data'), DIST_DIR: join(runtime, 'dist') },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
