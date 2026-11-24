import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiOrigin } from '../scripts/installation-settings.mjs';

let work: string;
let units: string;
let logs: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'gp-install-instances-'));
  units = join(work, 'config/systemd/user');
  logs = join(work, 'systemctl.log');
  mkdirSync(join(work, 'bin'));
  writeFileSync(join(work, 'bin/systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GP_TEST_SYSTEMCTL_LOG"\n', { mode: 0o700 });
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

function checkout(name: string, settings = '') {
  const root = join(work, name);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'shared'));
  for (const script of ['check.mjs', 'installation-settings.mjs', 'install-services.mjs', 'onprem-setup.mjs', 'set-hosts.mjs', 'tls-setup.mjs']) {
    cpSync(new URL(`../scripts/${script}`, import.meta.url), join(root, 'scripts', script));
  }
  for (const script of ['env-file.mjs', 'installation-peer.mjs']) {
    cpSync(new URL(`../shared/${script}`, import.meta.url), join(root, 'shared', script));
  }
  if (settings) writeFileSync(join(root, '.env'), settings);
  return root;
}

function stubBuild(root: string) {
  for (const directory of ['node_modules/tsx', 'dist/admin', 'dist/widget']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'dist/admin/index.html'), '');
  writeFileSync(join(root, 'dist/widget/w.js'), '');
}

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return address.port;
}

function run(root: string, script: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [`scripts/${script}`, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH}`,
      XDG_CONFIG_HOME: join(work, 'config'), GP_TEST_SYSTEMCTL_LOG: logs, GP_PG_PORT: '', ...extraEnv },
  });
}

describe('parallel on-prem installations', () => {
  it('creates independent legacy-compatible, HTTP and external-database unit definitions', () => {
    const primary = checkout('primary', 'PUBLIC_URL=https://review.example.test:3443\nHOST=127.0.0.1\nPORT=3200\n');
    const secondary = checkout('secondary', 'GP_INSTANCE=http\nGP_PG_PORT=55434\nPUBLIC_URL=http://review.example.test:3080\nHOST=192.0.2.1\nPORT=3080\n');
    expect(run(primary, 'install-services.mjs', ['--enable']).status).toBe(0);
    const api = readFileSync(join(units, 'geomsupin-api.service'), 'utf8');
    expect(api).toContain('Requires=geomsupin-db.service');
    expect(run(secondary, 'install-services.mjs', ['--enable']).status).toBe(0);
    expect(run(secondary, 'install-services.mjs', ['--enable']).status).toBe(0);
    expect(readFileSync(join(units, 'geomsupin-api.service'), 'utf8')).toBe(api);
    expect(readFileSync(join(units, 'geomsupin-http-api.service'), 'utf8')).toContain('Requires=geomsupin-http-db.service');
    expect(readFileSync(join(units, 'geomsupin-http-db.service'), 'utf8')).toContain('127.0.0.1:55434');
    expect(readFileSync(join(units, 'geomsupin-http-backup.timer'), 'utf8')).toContain('Unit=geomsupin-http-backup.service');
    const duplicate = checkout('duplicate', 'GP_INSTANCE=http\n');
    const denied = run(duplicate, 'install-services.mjs', ['--enable']);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('geomsupin-http-api.service');
    const tls = run(secondary, 'tls-setup.mjs', ['--host', '192.0.2.1']);
    expect(tls.status).toBe(1);
    expect(tls.stderr).toContain('HTTP 보조 설치');

    writeFileSync(join(secondary, '.env'), 'GP_INSTANCE=http\nGP_DATABASE_MODE=external\nDATABASE_URL=postgresql://localhost/secondary\n');
    expect(run(secondary, 'install-services.mjs', ['--enable']).status).toBe(0);
    expect(readFileSync(join(units, 'geomsupin-http-api.service'), 'utf8')).not.toContain('Requires=');
    expect(readFileSync(logs, 'utf8').trim().split('\n').at(-1)).toBe('--user enable --now geomsupin-http-api.service geomsupin-http-backup.timer');
  });

  it('rejects conflicting installation options before touching services', async () => {
    const root = checkout('secondary', 'GP_INSTANCE=http\nGP_PG_PORT=55434\n');
    expect(run(root, 'onprem-setup.mjs', ['--instance', 'default', '--url', 'http://192.0.2.1:3080']).status).toBe(1);
    expect(run(root, 'onprem-setup.mjs', ['--url', 'https://192.0.2.1:3443']).status).toBe(1);
    expect(run(root, 'onprem-setup.mjs', ['--url', 'http://192.0.2.1:3080', '--pg-port', '55433']).status).toBe(1);
    expect(run(root, 'onprem-setup.mjs', ['--url', 'http://192.0.2.1:3080', '--peer-url', 'http://192.0.2.1:3443']).status).toBe(1);
    const peer = checkout('primary', 'DATABASE_URL=postgresql://127.0.0.1:5432/review\nGP_DATABASE_MODE=external\n');
    expect(run(peer, 'install-services.mjs', []).status).toBe(0);
    expect(run(root, 'onprem-setup.mjs', ['--url', 'http://192.0.2.1:3080', '--database-url', 'postgresql://127.0.0.1:5432/review']).stderr)
      .toContain('같은 PostgreSQL 데이터베이스');
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      expect(run(root, 'onprem-setup.mjs', ['--bind', '127.0.0.1', '--url', `http://127.0.0.1:${address.port}`, '--database-url', 'postgresql://localhost/other']).stderr)
        .toContain('EADDRINUSE');
    } finally { await new Promise<void>((resolve) => listener.close(() => resolve())); }
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('GP_INSTANCE=http\nGP_PG_PORT=55434\n');
  });

  it('checks the configured API listener rather than assuming loopback', () => {
    expect(apiOrigin('192.0.2.1', 3080)).toBe('http://192.0.2.1:3080');
    expect(apiOrigin('0.0.0.0', 3200)).toBe('http://127.0.0.1:3200');
    expect(apiOrigin('::', 3200)).toBe('http://[::1]:3200');
  });

  it('restarts only the running API owned by this checkout when its peer changes', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const root = checkout('secondary', `GP_INSTANCE=http\nGP_DATABASE_MODE=external\nDATABASE_URL=postgresql://localhost/secondary\nPUBLIC_URL=${origin}\nHOST=127.0.0.1\nPORT=${port}\nAUTH_SECRET=fixture\n`);
    stubBuild(root);
    expect(run(root, 'install-services.mjs', ['--no-db']).status).toBe(0);
    const current = ['--url', origin, '--bind', '127.0.0.1', '--peer-url', 'https://127.0.0.1:3443'];
    expect(run(root, 'onprem-setup.mjs', current).status).toBe(0);
    expect(run(root, 'onprem-setup.mjs', current).status).toBe(0);
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('PEER_REVIEW_URL=https://127.0.0.1:3443');
    expect(readFileSync(logs, 'utf8').split('\n').filter((line) => line.includes('restart')))
      .toEqual(['--user restart geomsupin-http-api.service']);
  });

  it('keeps the signing secret, capture directory and image policy on an explicitly forced reconfiguration', async () => {
    const root = checkout('primary', 'GP_DATABASE_MODE=external\nPUBLIC_URL=https://old.example.test\nDATABASE_URL=postgresql://localhost/primary\n AUTH_SECRET = "fixture-secret"\nDATA_DIR=./custom-storage\nIMAGE_PROXY_ENABLED=false\n');
    stubBuild(root);
    const setup = run(root, 'onprem-setup.mjs', ['--url', 'https://new.example.test', '--bind', '127.0.0.1', '--port', String(await availablePort()), '--force']);
    expect(setup.stderr).toBe('');
    expect(setup.status).toBe(0);
    const updated = readFileSync(join(root, '.env'), 'utf8');
    expect(updated).toContain('PUBLIC_URL=https://new.example.test');
    expect(updated).toContain(' AUTH_SECRET = "fixture-secret"\nDATA_DIR=./custom-storage\nIMAGE_PROXY_ENABLED=false');
    expect(updated.match(/AUTH_SECRET/g)).toHaveLength(1);
  });

  it('leaves the environment intact if an address change is unusable', () => {
    const original = ' PUBLIC_URL = "https://old.example.test"\n PEER_REVIEW_URL = http://old.example.test:3080\n PORT = "3200"\n';
    const root = checkout('primary', original);
    for (const url of ['ftp://other.example.test', 'https://other.example.test/path', 'http://new.example.test']) {
      expect(run(root, 'set-hosts.mjs', [url]).status).toBe(1);
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
    }
    expect(run(root, 'set-hosts.mjs', ['https://new.example.test']).status).toBe(0);
    const updated = readFileSync(join(root, '.env'), 'utf8');
    expect(updated).toContain('PUBLIC_URL=https://new.example.test\n');
    expect(updated).toContain('ALLOWED_HOSTS=new.example.test,127.0.0.1:3200,localhost:3200\n');
  });

  it('keeps check builds outside the configured production static tree, including symlinks', () => {
    const root = checkout('primary', 'DIST_DIR=custom-production\n');
    mkdirSync(join(root, 'custom-production'));
    symlinkSync(join(root, 'custom-production'), join(root, 'custom-alias'));
    writeFileSync(join(work, 'bin/npm'), '#!/bin/sh\nprintf "%s\\n" "$DIST_DIR"\n', { mode: 0o700 });
    const defaultCheck = run(root, 'check.mjs', [], { DIST_DIR: undefined });
    expect(defaultCheck.status).toBe(0);
    expect(defaultCheck.stdout.trim().split('\n')).toEqual(Array(4).fill(join(root, 'dist-test')));
    const overlap = run(root, 'check.mjs', [], { DIST_DIR: 'custom-alias/nested' });
    expect(overlap.status).toBe(1);
    expect(overlap.stderr).toContain('운영 dist와 다른 DIST_DIR');
    expect(overlap.stdout).toBe('');
  });
});
