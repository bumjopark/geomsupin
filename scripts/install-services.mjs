// 사용자 systemd 서비스 파일을 만든다 (이름은 geomsupin-*).
//   npm run services:install            파일 생성 + daemon-reload
//   npm run services:install -- --enable   + enable --now
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readInstallation } from './installation-settings.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = join(homedir(), '.config', 'systemd', 'user');
mkdirSync(dir, { recursive: true });

const { env, externalDatabase } = readInstallation(root);
// Node 는 NODE_BIN 으로 지정하거나, 프로젝트 전용(.tools)이 있으면 그것을, 없으면 지금 이 스크립트를 돌리는 Node 를 쓴다(사내 서버 설치).
const toolsNode = join(root, '.tools/node_modules/node/bin/node');
const NODE = process.env.NODE_BIN || (existsSync(toolsNode) ? toolsNode : process.execPath);
const PG = process.env.PG_BIN || env.PG_BIN || '/usr/lib/postgresql/16/bin';
if (!existsSync(NODE)) throw new Error(`Node 를 찾을 수 없습니다: ${NODE}`);
if (Number(process.versions.node.split('.')[0]) < 22 && NODE === process.execPath) throw new Error('Node 22 이상이 필요합니다 (현재 ' + process.versions.node + ')');
const noDb = process.argv.includes('--no-db') || externalDatabase;
const DB_PORT = process.env.GP_PG_PORT || '55433';
const BIND = `${env.HOST || '127.0.0.1'}:${env.PORT || 8200}`;

const units = {
  'geomsupin-db.service': `[Unit]
Description=Geomsupin PostgreSQL (127.0.0.1:${DB_PORT}, 전용 클러스터)
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
  'geomsupin-api.service': `[Unit]
Description=Geomsupin 메인 서버 (API + 관리 화면 + 위젯, ${BIND})
${noDb ? 'After=network.target' : 'After=geomsupin-db.service network.target\nRequires=geomsupin-db.service'}

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
  'geomsupin-backup.service': `[Unit]
Description=Geomsupin DB·캡처·설정 통합 백업
${noDb ? '' : 'After=geomsupin-db.service'}

[Service]
Type=oneshot
WorkingDirectory=${root}
ExecStart=${NODE} ${root}/scripts/serve-release.mjs --backup --kind scheduled
NoNewPrivileges=yes
`,
  'geomsupin-backup.timer': `[Unit]
Description=Geomsupin 매일 백업 (04:40)

[Timer]
OnCalendar=*-*-* 04:40:00
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
`,
};

if (noDb) delete units['geomsupin-db.service'];
for (const [name, body] of Object.entries(units)) writeFileSync(join(dir, name), body);
const sc = (...a) => execFileSync('systemctl', ['--user', ...a], { stdio: 'inherit' });
sc('daemon-reload');
console.log(`wrote ${Object.keys(units).length} units to ${dir}`);
if (process.argv.includes('--enable')) {
  // 외부 DB(DATABASE_URL 을 직접 지정한 경우)를 쓰면 전용 DB 서비스는 켜지 않는다.
  sc('enable', '--now', ...(noDb ? [] : ['geomsupin-db.service']), 'geomsupin-api.service', 'geomsupin-backup.timer');
}
