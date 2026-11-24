// 검수핀의 공개 주소와 허용 Host를 .env에 반영한다.
//   node scripts/set-hosts.mjs https://review.example.com
// 추가 Host로도 요청을 받으려면 --also 옵션을 사용한다.
//   node scripts/set-hosts.mjs https://10.0.0.5:3443 --also http://10.0.0.5:3200
// 이후 `systemctl --user restart geomsupin-api` 로 적용한다.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstallation } from './installation-settings.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const also = [];
const positional = [];
for (let i = 0; i < argv.length; i++) { if (argv[i] === '--also') also.push(new URL(argv[++i] ?? '')); else positional.push(argv[i]); }
const [main] = positional;
if (!main) { console.error('usage: node scripts/set-hosts.mjs <main-url> [--also <old-url>]...'); process.exit(1); }
const m = new URL(main);
if (readInstallation(root).instance === 'http' && m.protocol !== 'http:') throw new Error('HTTP 보조 설치에는 HTTP 공개 주소를 사용하세요.');

const path = join(root, '.env');
let env = readFileSync(path, 'utf8');
const set = (k, v) => { const re = new RegExp(`^${k}=.*$`, 'm'); env = re.test(env) ? env.replace(re, `${k}=${v}`) : env.replace(/\n?$/, `\n${k}=${v}\n`); };

set('PUBLIC_URL', m.origin);
const port = env.match(/^PORT=(\d+)$/m)?.[1] || '8200';
set('ALLOWED_HOSTS', [...new Set([m.host, ...also.map((u) => u.host), `127.0.0.1:${port}`, `localhost:${port}`])].join(','));
writeFileSync(path, env, { mode: 0o600 });
console.log(`PUBLIC_URL=${m.origin}`);
