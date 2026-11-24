import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const script of ['installation-settings.mjs', 'install-services.mjs', 'onprem-setup.mjs', 'tls-setup.mjs']) {
    cpSync(new URL(`../scripts/${script}`, import.meta.url), join(root, 'scripts', script));
  }
  for (const script of ['env-file.mjs', 'installation-peer.mjs']) {
    cpSync(new URL(`../shared/${script}`, import.meta.url), join(root, 'shared', script));
  }
  if (settings) writeFileSync(join(root, '.env'), settings);
  return root;
}

function run(root: string, script: string, args: string[]) {
  return spawnSync(process.execPath, [`scripts/${script}`, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH}`,
      XDG_CONFIG_HOME: join(work, 'config'), GP_TEST_SYSTEMCTL_LOG: logs, GP_PG_PORT: '' },
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
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const root = checkout('secondary', `GP_INSTANCE=http\nGP_DATABASE_MODE=external\nDATABASE_URL=postgresql://localhost/secondary\nPUBLIC_URL=${origin}\nHOST=127.0.0.1\nPORT=${address.port}\nAUTH_SECRET=fixture\n`);
    for (const directory of ['node_modules/tsx', 'dist/admin', 'dist/widget']) mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, 'dist/admin/index.html'), '');
    writeFileSync(join(root, 'dist/widget/w.js'), '');
    expect(run(root, 'install-services.mjs', ['--no-db']).status).toBe(0);
    const current = ['--url', origin, '--bind', '127.0.0.1', '--peer-url', 'https://127.0.0.1:3443'];
    expect(run(root, 'onprem-setup.mjs', current).status).toBe(0);
    expect(run(root, 'onprem-setup.mjs', current).status).toBe(0);
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('PEER_REVIEW_URL=https://127.0.0.1:3443');
    expect(readFileSync(logs, 'utf8').split('\n').filter((line) => line.includes('restart')))
      .toEqual(['--user restart geomsupin-http-api.service']);
  });
});
