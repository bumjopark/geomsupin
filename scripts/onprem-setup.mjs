// 사내 설치 도우미: 검수핀 API, PostgreSQL과 사용자 서비스를 준비한다.
//
//   node scripts/onprem-setup.mjs --url https://192.168.1.50:3443 --bind 127.0.0.1 --port 3200 --services
//   node scripts/tls-setup.mjs --host 192.168.1.50 --port 3443
//
//   --url <주소>          (필수) 검수핀 자신의 주소. 사람들이 브라우저에 입력하는 주소와 같아야 한다 (예: http://10.0.0.5:3200)
//   --bind <주소>         서버가 듣는 주소. 기본 0.0.0.0 (사내 모든 인터페이스). 127.0.0.1 이면 이 서버 안에서만 접속된다
//   --database-url <URL>  사내에 이미 있는 PostgreSQL 을 쓴다. 없으면 이 폴더에 전용 PostgreSQL 클러스터(127.0.0.1)를 만든다
//   --port <번호>         내부 API 포트. HTTPS 프록시를 쓸 때 공개 주소의 포트와 별도로 지정한다
//   --issue-admin         설치 뒤 현재 작업공간의 1회용 관리 링크를 발급한다
//   --services            systemd 사용자 서비스까지 만들어 바로 켠다 (Linux)
//   --rebuild             위젯·관리 화면을 다시 빌드한다
//   --force               이미 있는 .env 의 값도 덮어쓴다 (기본은 없는 항목만 채움 — 비밀값은 그대로 둔다)
//
// 여러 번 실행해도 안전하다. 요구: Node 22 이상, (전용 DB 를 쓸 때) PostgreSQL 16 (apt install postgresql-16, 또는 PG_BIN 지정).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnvFile } from '../shared/env-file.mjs';
import { readInstallation } from './installation-settings.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const step = (msg) => console.log(`\n▶ ${msg}`);
const rand = (n) => randomBytes(n).toString('base64url');

if (flag('help') || flag('h') || !opt('url')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(opt('url') ? 0 : 1);
}

// ── 점검 ──
step('환경 점검');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22 || (nodeMajor === 22 && Number(process.versions.node.split('.')[1]) < 12)) die(`Node 22.12 이상이 필요합니다 (현재 ${process.versions.node}).`);
console.log(`  Node ${process.versions.node} ✓`);

let url;
try { url = new URL(opt('url')); } catch { die(`--url 이 올바른 주소가 아닙니다: ${opt('url')}`); }
if (!/^https?:$/.test(url.protocol)) die('--url 은 http:// 또는 https:// 로 시작해야 합니다');
if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) die('--url에는 검수핀의 프로토콜, 호스트, 포트만 입력하세요');
const port = Number(opt('port') ?? (url.port || (url.protocol === 'https:' ? 443 : 80)));
if (!Number.isInteger(port) || port < 1 || port > 65535) die('--port는 1~65535 범위의 포트 번호입니다');
const bind = opt('bind') ?? '0.0.0.0';
const { env: saved, externalDatabase } = readInstallation(root);
const requestedDb = opt('database-url');
if (requestedDb && saved.DATABASE_URL && requestedDb !== saved.DATABASE_URL && !flag('force')) {
  die('기존 DATABASE_URL이 새 주소와 다릅니다. DB를 전환하려면 .env에서 DATABASE_URL을 먼저 갱신하세요.');
}
const customDb = requestedDb || (externalDatabase ? saved.DATABASE_URL : undefined);
if (customDb) { try { new URL(customDb); } catch { die('--database-url 이 올바르지 않습니다 (예: postgresql://사용자:비밀번호@호스트:5432/데이터베이스)'); } }
console.log(`  주소 ${url.origin} (포트 ${port}, 바인드 ${bind}) ✓`);
if (url.protocol === 'http:') console.log('  http 로 운영합니다: 검수할 사이트도 http 여야 합니다(https 사이트에서는 브라우저가 http 검수핀을 막습니다).');

const PG_BIN = process.env.PG_BIN || saved.PG_BIN || '/usr/lib/postgresql/16/bin';
if (!customDb && !existsSync(join(PG_BIN, 'initdb'))) {
  die(`PostgreSQL 16 을 찾을 수 없습니다 (${PG_BIN}).\n  - Ubuntu/Debian:  sudo apt install postgresql-16   (설치되면 PG_BIN 기본 경로가 맞습니다)\n  - 다른 경로면:    PG_BIN=/경로/bin node scripts/onprem-setup.mjs ...\n  - 사내 DB 가 있으면: --database-url postgresql://... 를 주면 이 단계가 필요 없습니다`);
}
if (!customDb) console.log(`  PostgreSQL ${PG_BIN} ✓ (전용 클러스터를 data/postgres 에 만듭니다)`);

const portFree = await new Promise((ok) => { const s = net.createServer(); s.once('error', () => ok(false)); s.listen(port, bind, () => s.close(() => ok(true))); });
if (!portFree) console.log(`  ⚠ ${bind}:${port} 를 이미 다른 프로그램이 쓰고 있습니다. (이미 검수핀이 떠 있는 재실행이면 괜찮습니다)`);
else console.log(`  포트 ${port} 비어 있음 ✓`);

const run = (cmd, args, extra = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env, ...extra });
  if (r.status !== 0) die(`실패: ${cmd} ${args.join(' ')}`);
};

// ── 의존성·빌드 ──
if (!existsSync(join(root, 'node_modules', 'tsx'))) { step('npm ci (빌드와 실행 의존성 설치)'); run('npm', ['ci', '--include=dev']); }
if (flag('rebuild') || !existsSync(join(root, 'dist', 'admin', 'index.html')) || !existsSync(join(root, 'dist', 'widget', 'w.js'))) { step('빌드 (위젯·관리 화면)'); run('npm', ['run', 'build']); }
else console.log('\n▶ 빌드는 이미 되어 있습니다 (다시 하려면 --rebuild)');

// ── .env ──
step('.env 설정');
const envPath = join(root, '.env');
const cur = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const has = (k) => new RegExp(`^${k}=`, 'm').test(cur);
let out = cur && !cur.endsWith('\n') ? cur + '\n' : cur;
const notes = [];
const set = (k, v, { secret = false, replace = false } = {}) => {
  if (has(k) && !replace && !flag('force')) { notes.push(`  = ${k} (기존 값 유지)`); return; }
  if (has(k)) out = out.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${v}`);
  else out += `${k}=${v}\n`;
  notes.push(`  + ${k}${secret ? ' (비공개)' : `=${v}`}`);
};
set('PORT', String(port));
set('HOST', bind);
set('PUBLIC_URL', url.origin);
set('ALLOWED_HOSTS', [...new Set([url.host, `127.0.0.1:${port}`, `localhost:${port}`])].join(','));
set('DATA_DIR', './data');
set('GP_DATABASE_MODE', customDb ? 'external' : 'dedicated', { replace: true });
if (process.env.PG_BIN) set('PG_BIN', PG_BIN, { replace: true });
set('AUTH_SECRET', rand(48), { secret: true });
set('IMAGE_PROXY_ENABLED', 'true');
if (customDb) set('DATABASE_URL', customDb, { secret: true });
writeFileSync(envPath, out, { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(notes.join('\n'));

// ── DB ──
if (!customDb) {
  step('전용 PostgreSQL 클러스터 준비 (data/postgres, 127.0.0.1 전용)');
  run(process.execPath, ['scripts/pg.mjs', 'init'], { env: { ...process.env, PG_BIN } });
}

// ── 서비스 ──
if (flag('services')) {
  step('systemd 사용자 서비스 설치·시작');
  // pg:init 이 pg_ctl 로 띄운 PostgreSQL 은 systemd 밖의 프로세스다. 그대로 두면 geomsupin-db 서비스가 같은 데이터 폴더를 못 잡고 재시작을 반복하고, 묶인 api 도 같이 내려간다.
  if (!customDb && spawnSync('systemctl', ['--user', 'is-active', '--quiet', 'geomsupin-db.service']).status !== 0) {
    run(process.execPath, ['scripts/pg.mjs', 'stop'], { env: { ...process.env, PG_BIN } });
  }
  run(process.execPath, ['scripts/install-services.mjs', '--enable', ...(customDb ? ['--no-db'] : [])], { env: { ...process.env, PG_BIN } });
  const settings = {};
  loadEnvFile(envPath, settings);
  const listenHost = settings.HOST === '::' ? '::1' : settings.HOST === '0.0.0.0' ? '127.0.0.1' : settings.HOST;
  const hostname = net.isIPv6(listenHost) ? `[${listenHost}]` : listenHost;
  const endpoint = `http://${hostname}:${settings.PORT}/healthz`;
  const host = new URL(settings.PUBLIC_URL).host;
  // The API starts listening after all pending database migrations finish.
  const startupTimeoutMs = 180_000;
  const deadline = Date.now() + startupTimeoutMs;
  console.log(`  API 시작과 DB 마이그레이션을 기다립니다 (최대 ${startupTimeoutMs / 60_000}분)`);
  let healthy = false;
  do {
    try {
      const response = await fetch(endpoint, { headers: { host }, signal: AbortSignal.timeout(1500) });
      healthy = response.ok && (await response.json()).ok === true;
    } catch { /* DB와 API 프로세스의 초기화가 끝나기를 기다린다. */ }
    if (!healthy) await delay(500);
  } while (!healthy && Date.now() < deadline);
  if (!healthy) die(`API가 ${startupTimeoutMs / 60_000}분 안에 준비되지 않았습니다. journalctl --user -u geomsupin-api -n 50 으로 서비스 로그를 확인하세요.`);
  console.log('  API와 DB 연결 확인 ✓');
}

if (flag('issue-admin')) run('npm', ['run', 'manage']);
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 설치 준비 끝
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 접속 주소    ${url.origin}
 관리 링크    npm run manage        (작업공간 선택은 npm run manage -- --list)
${flag('services') ? '' : `
 서버 켜기     cd ${root} && npm start        (또는 --services 로 다시 실행하면 systemd 가 관리)
`}
 상태 확인     ${url.origin}/healthz → {"ok":true}${url.protocol === 'https:' ? ' (HTTPS 설정 및 인증서 신뢰 후)' : ''}
 방화벽        참여자 PC에서 공개 주소의 ${url.port || (url.protocol === 'https:' ? 443 : 80)}/tcp 포트에 접속할 수 있어야 합니다
 재부팅 후 유지 (systemd 사용 시) sudo loginctl enable-linger $USER
 검수 시작    관리 링크 → 프로젝트 설정의 검수할 사이트 → 참여자 초대
`);
