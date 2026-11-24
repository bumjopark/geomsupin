// 사용자 systemd 서비스 파일을 만든다 (.env의 GP_INSTANCE에 따라 geomsupin-* 또는 geomsupin-http-*).
//   npm run services:install            파일 생성 + daemon-reload
//   npm run services:install -- --enable   + enable --now
import { writeFileSync, mkdirSync, existsSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { apiUnitNames, assertUnitOwnership, readInstallation, unitDir, unitMarker } from './installation-settings.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = unitDir();
mkdirSync(dir, { recursive: true });

const { env, externalDatabase, prefix, pgPort } = readInstallation(root);
// Node 는 NODE_BIN 으로 지정하거나, 프로젝트 전용(.tools)이 있으면 그것을, 없으면 지금 이 스크립트를 돌리는 Node 를 쓴다(사내 서버 설치).
const toolsNode = join(root, '.tools/node_modules/node/bin/node');
const NODE = process.env.NODE_BIN || (existsSync(toolsNode) ? toolsNode : process.execPath);
const PG = process.env.PG_BIN || env.PG_BIN || '/usr/lib/postgresql/16/bin';
if (!existsSync(NODE)) throw new Error(`Node 를 찾을 수 없습니다: ${NODE}`);
if (Number(process.versions.node.split('.')[0]) < 22 && NODE === process.execPath) throw new Error('Node 22 이상이 필요합니다 (현재 ' + process.versions.node + ')');
const noDb = process.argv.includes('--no-db') || externalDatabase;
const BIND = `${env.HOST || '127.0.0.1'}:${env.PORT || 8200}`;
const db = `${prefix}-db.service`;
const api = `${prefix}-api.service`;
const backup = `${prefix}-backup.service`;
const timer = `${prefix}-backup.timer`;

const units = {
  [db]: `[Unit]
Description=Geomsupin PostgreSQL (127.0.0.1:${pgPort}, 전용 클러스터)
After=network.target

[Service]
Type=simple
ExecStart=${PG}/postgres -D ${root}/data/postgres
ExecReload=/bin/kill -HUP $MAINPID
KillSignal=SIGINT
TimeoutStopSec=60
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
MemoryMax=512M

[Install]
WantedBy=default.target
`,
  [api]: `[Unit]
Description=Geomsupin 메인 서버 (API + 관리 화면 + 위젯, ${BIND})
${noDb ? 'After=network.target' : `After=${db} network.target\nRequires=${db}`}

[Service]
Type=simple
WorkingDirectory=${root}
Environment=NODE_ENV=production
ExecStart=${NODE} ${root}/scripts/serve-release.mjs
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
MemoryMax=768M

[Install]
WantedBy=default.target
`,
  [backup]: `[Unit]
Description=Geomsupin DB·캡처·설정 통합 백업
${noDb ? '' : `After=${db}`}

[Service]
Type=oneshot
WorkingDirectory=${root}
ExecStart=${NODE} ${root}/scripts/serve-release.mjs --backup --kind scheduled
NoNewPrivileges=yes
`,
  [timer]: `[Unit]
Description=Geomsupin 매일 백업 (04:40)

[Timer]
Unit=${backup}
OnCalendar=*-*-* 04:40:00
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
`,
};

const sc = (...a) => execFileSync('systemctl', ['--user', ...a], { stdio: 'inherit' });
if (noDb) delete units[db];
const lock = join(dir, `.${prefix}-services.lock`);
mkdirSync(lock);
try {
  assertUnitOwnership(root, prefix, apiUnitNames(prefix));
  for (const [name, body] of Object.entries(units)) writeFileSync(join(dir, name), `${unitMarker(root)}\n${body}`);
  sc('daemon-reload');
  console.log(`wrote ${Object.keys(units).length} units to ${dir}`);
  if (process.argv.includes('--enable')) sc('enable', '--now', ...(noDb ? [] : [db]), api, timer);
} finally {
  rmdirSync(lock);
}
