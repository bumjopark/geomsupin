// geomsupin 전용 PostgreSQL 클러스터 관리 (loopback 전용).
//   node scripts/pg.mjs init     클러스터·역할·DB 생성 + .env 에 DATABASE_URL 기록
//   node scripts/pg.mjs start|stop|status|psql
// 앱 계정은 superuser/createdb/createrole 권한이 없다.
// 유닉스 소켓은 쓰지 않는다(설치 경로가 깊으면 소켓 경로 107바이트 제한에 걸린다). 127.0.0.1 TCP + 비밀번호(scram)만 쓴다.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseAddress, readInstallation } from './installation-settings.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { env, pgPort: PORT, dedicatedCluster } = readInstallation(root);
const BIN = process.env.PG_BIN || env.PG_BIN || '/usr/lib/postgresql/16/bin';
const DATA = join(root, 'data', 'postgres');
const SECRETS = join(root, 'data', 'secrets');
const ADMIN = 'geomsupin_admin';
const APP = 'geomsupin_app';
const DB = 'geomsupin';
const TEST_DB = 'geomsupin_test';

const bin = (name) => join(BIN, name);
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`$ ${cmd} ${args.join(' ')}\n${r.stdout || ''}${r.stderr || ''}`);
    process.exit(r.status || 1);
  }
  return r;
}
const rand = (n = 24) => randomBytes(n).toString('base64url');
const psql = (sql, db = 'postgres', pw) =>
  run(bin('psql'), ['-X', '-h', '127.0.0.1', '-p', String(PORT), '-U', ADMIN, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tA', '-f', '-'], {
    input: sql, env: { ...process.env, PGPASSWORD: pw },
  });

function readSecret(name) {
  return readFileSync(join(SECRETS, name), 'utf8').trim();
}

function isRunning() {
  return run(bin('pg_ctl'), ['-D', DATA, 'status'], { allowFail: true }).status === 0;
}

function assertRunningPort() {
  if (Number(readFileSync(join(DATA, 'postmaster.pid'), 'utf8').split('\n')[3]) !== PORT) {
    throw new Error(`실행 중인 전용 클러스터의 포트가 GP_PG_PORT=${PORT}와 다릅니다.`);
  }
}

function start() {
  const configured = run(bin('postgres'), ['-D', DATA, '-C', 'port']).stdout.trim();
  if (Number(configured) !== PORT) throw new Error(`이 PostgreSQL 클러스터의 포트 ${configured}와 GP_PG_PORT=${PORT}가 다릅니다.`);
  if (isRunning()) {
    assertRunningPort();
    return console.log('postgres already running');
  }
  run(bin('pg_ctl'), ['-D', DATA, '-l', join(root, 'data', 'postgres.log'), '-w', 'start']);
  console.log(`postgres up on 127.0.0.1:${PORT}`);
}

function init() {
  const configuredDb = databaseAddress(env.DATABASE_URL);
  if (env.GP_DATABASE_MODE === 'external' || (env.DATABASE_URL &&
    (!configuredDb || configuredDb.host !== '127.0.0.1' || configuredDb.port !== PORT || configuredDb.name !== DB))) {
    throw new Error('현재 DATABASE_URL이 이 설치의 전용 PostgreSQL 주소와 다릅니다.');
  }
  mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  const adminPw = existsSync(join(SECRETS, 'pg-admin')) ? readSecret('pg-admin') : rand();
  const appPw = existsSync(join(SECRETS, 'pg-app')) ? readSecret('pg-app') : rand();
  writeFileSync(join(SECRETS, 'pg-admin'), adminPw + '\n', { mode: 0o600 });
  writeFileSync(join(SECRETS, 'pg-app'), appPw + '\n', { mode: 0o600 });

  if (!dedicatedCluster) {
    const pwfile = join(SECRETS, '.pwfile');
    writeFileSync(pwfile, adminPw, { mode: 0o600 });
    run(bin('initdb'), ['-D', DATA, '-U', ADMIN, '--pwfile', pwfile, '--auth=scram-sha-256', '-E', 'UTF8', '--locale=C.UTF-8']);
    run('rm', ['-f', pwfile]);
    appendFileSync(
      join(DATA, 'postgresql.conf'),
      `\n# geomsupin\nlisten_addresses = '127.0.0.1'\nport = ${PORT}\nunix_socket_directories = ''\nmax_connections = 60\nshared_buffers = 128MB\nlog_min_duration_statement = 500\ntimezone = 'Asia/Seoul'\n`,
    );
    chmodSync(DATA, 0o700);
  }
  start();

  const exists = (sql) => psql(sql, 'postgres', adminPw).stdout.trim() === '1';
  if (!exists(`select 1 from pg_roles where rolname='${APP}'`)) {
    psql(`create role ${APP} login nosuperuser nocreatedb nocreaterole password '${appPw}'`, 'postgres', adminPw);
  } else {
    psql(`alter role ${APP} password '${appPw}'`, 'postgres', adminPw);
  }
  for (const db of [DB, TEST_DB]) {
    if (!exists(`select 1 from pg_database where datname='${db}'`)) psql(`create database ${db} owner ${APP} encoding 'UTF8' template template0 lc_collate 'C.UTF-8' lc_ctype 'C.UTF-8'`, 'postgres', adminPw);
  }
  psql(`revoke all on database ${DB} from public; revoke all on database ${TEST_DB} from public`, 'postgres', adminPw);

  const envPath = join(root, '.env');
  const url = `postgresql://${APP}:${appPw}@127.0.0.1:${PORT}/${DB}`;
  const testUrl = `postgresql://${APP}:${appPw}@127.0.0.1:${PORT}/${TEST_DB}`;
  const cur = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const add = [];
  if (!/^GP_PG_PORT=/m.test(cur)) add.push(`GP_PG_PORT=${PORT}`);
  if (!/^DATABASE_URL=/m.test(cur)) add.push(`DATABASE_URL=${url}`);
  if (!/^TEST_DATABASE_URL=/m.test(cur)) add.push(`TEST_DATABASE_URL=${testUrl}`);
  if (add.length) {
    appendFileSync(envPath, (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n', { mode: 0o600 });
    chmodSync(envPath, 0o600);
  }
  console.log(`ready: db=${DB} test=${TEST_DB} role=${APP} port=${PORT}`);
}

const cmd = process.argv[2];
if (cmd === 'init') init();
else if (cmd === 'start') start();
else if (cmd === 'stop') { run(bin('pg_ctl'), ['-D', DATA, '-m', 'fast', '-w', 'stop'], { allowFail: true }); console.log('stopped'); }
else if (cmd === 'status') { const r = run(bin('pg_ctl'), ['-D', DATA, 'status'], { allowFail: true }); console.log((r.stdout || r.stderr).trim()); }
else if (cmd === 'psql') {
  if (!isRunning()) throw new Error('이 설치의 전용 PostgreSQL 클러스터가 실행 중이지 않습니다.');
  assertRunningPort();
  const r = spawnSync(bin('psql'), ['-h', '127.0.0.1', '-p', String(PORT), '-U', APP, '-d', DB], { stdio: 'inherit', env: { ...process.env, PGPASSWORD: readSecret('pg-app') } });
  process.exit(r.status ?? 0);
} else {
  console.log('usage: node scripts/pg.mjs init|start|stop|status|psql');
  process.exit(1);
}
