import { existsSync, readFileSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../shared/env-file.mjs';

export function servicePrefix(instance) {
  if (instance === 'default') return 'geomsupin';
  if (instance === 'http') return 'geomsupin-http';
  throw new Error('인스턴스는 default 또는 http여야 합니다.');
}

export function checkedPort(value, label) {
  if (!/^[0-9]+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) throw new Error(`${label}는 1~65535 범위의 포트 번호여야 합니다.`);
  return Number(value);
}

export function databaseAddress(value) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) return null;
    return { host: url.hostname.toLowerCase(), port: Number(url.port || 5432), name: decodeURIComponent(url.pathname.slice(1)) };
  } catch { return null; }
}

export function readInstallation(root) {
  const env = {};
  loadEnvFile(join(root, '.env'), env);
  const dedicatedCluster = existsSync(join(root, 'data', 'postgres', 'PG_VERSION'));
  const externalDatabase = env.GP_DATABASE_MODE
    ? env.GP_DATABASE_MODE === 'external'
    : Boolean(env.DATABASE_URL) && !dedicatedCluster;
  const instance = env.GP_INSTANCE || 'default';
  const prefix = servicePrefix(instance);
  const database = databaseAddress(env.DATABASE_URL);
  const savedPgPort = env.GP_PG_PORT ?? (!externalDatabase && database?.host === '127.0.0.1' ? database.port : undefined);
  const pgPort = checkedPort(savedPgPort ?? (process.env.GP_PG_PORT || (instance === 'http' ? 55434 : 55433)), 'GP_PG_PORT');
  return { env, externalDatabase, dedicatedCluster, instance, prefix, pgPort, savedPgPort };
}

export function apiOrigin(host, port) {
  const address = host === '::' ? '::1' : host === '0.0.0.0' ? '127.0.0.1' : host;
  return `http://${isIPv6(address) ? `[${address}]` : address}:${port}`;
}

export const unitDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
export const unitMarker = (root) => `# Geomsupin installation: ${root}`;

function readUnit(name) {
  try { return readFileSync(join(unitDir(), name), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
}

export function unitOwner(prefix) {
  const api = readUnit(`${prefix}-api.service`);
  return api.match(/^# Geomsupin installation: (.+)$/m)?.[1] ?? api.match(/^WorkingDirectory=(.+)$/m)?.[1];
}

export function assertUnitOwnership(root, prefix, names) {
  const owner = unitOwner(prefix);
  for (const name of names) {
    const unit = readUnit(name);
    if (!unit) continue;
    const marked = unit.match(/^# Geomsupin installation: (.+)$/m)?.[1];
    if (marked === root || (!marked && (
      unit.split('\n').includes(`WorkingDirectory=${root}`) ||
      unit.split('\n').some(line => line.startsWith('ExecStart=') && line.endsWith(` -D ${root}/data/postgres`)) ||
      (owner === root && (name === `${prefix}-backup.timer` || name === `${prefix}-tls.service`)) ||
      (name === `${prefix}-tls.service` && unit.split('\n').some(line => line.startsWith('ExecStart=') && line.includes(` -c ${root}/`)))
    ))) continue;
    throw new Error(`${name}이 다른 설치에 속합니다. 이 설치에서 기존 사용자 서비스를 덮어쓸 수 없습니다.`);
  }
}

export function apiUnitNames(prefix) {
  return ['api.service', 'db.service', 'backup.service', 'backup.timer'].map(name => `${prefix}-${name}`);
}
