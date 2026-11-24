// 기존 systemd ExecStart 경로를 유지하며 통합 백업을 실행한다(Node 22+).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const r = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./backup.ts', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.error) console.error(r.error.message);
process.exitCode = r.status ?? 1;
