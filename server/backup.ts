import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { connect } from './db.ts';

const CAPTURE = /^captures\/\d{4}\/\d{2}\/[0-9a-f-]{36}-(?:full|thumb|proposal)\.(?:webp|jpg)$/;
const NAME = /^geomsupin-\d{8}T\d{9}Z-[0-9a-f]{8}$/;
const fileSchema = z.object({ key: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const backupKind = z.enum(['scheduled', 'manual', 'deployment']);
const manifestSchema = z.object({ format: z.literal(1), kind: backupKind.optional(), createdAt: z.string().datetime(), requests: z.number().int().nonnegative(), files: z.array(fileSchema).min(1) });
type Manifest = z.infer<typeof manifestSchema>;

async function pg(tool: 'pg_dump' | 'pg_restore', args: string[], databaseUrl?: string) {
  const bin = join(process.env.PG_BIN || '/usr/lib/postgresql/16/bin', tool);
  const env: NodeJS.ProcessEnv = { ...process.env, PGCONNECT_TIMEOUT: '10' };
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    // 접속 옵션을 유지하되 비밀번호를 명령줄에 노출하지 않는다.
    env.PGPASSWORD = decodeURIComponent(url.password); url.password = '';
    args = ['--dbname', url.toString(), ...args];
  }
  await new Promise<void>((done, fail) => {
    const child = spawn(existsSync(bin) ? bin : tool, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000);
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? done() : fail(new Error(`${tool} 실패: ${error || `종료 코드 ${code}`}`)); });
  });
}

async function fingerprint(root: string, key: string) {
  if (!CAPTURE.test(key) && !['database.dump', 'config.env'].includes(key)) throw new Error('허용되지 않은 백업 파일 경로');
  let path = root;
  for (const part of key.split('/')) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('백업에 심볼릭 링크를 사용할 수 없습니다');
  }
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`파일이 아닙니다: ${key}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { key, bytes: info.size, sha256: hash.digest('hex') };
}

export async function verifyBackup(directory: string): Promise<Manifest> {
  const root = resolve(directory);
  if ((await lstat(root)).isSymbolicLink() || (await lstat(join(root, 'manifest.json'))).isSymbolicLink()) throw new Error('백업에 심볼릭 링크를 사용할 수 없습니다');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
  const keys = new Set(manifest.files.map((f) => f.key));
  if (!keys.has('database.dump') || keys.size !== manifest.files.length) throw new Error('백업 파일 목록이 올바르지 않습니다');
  for (const file of manifest.files) {
    const actual = await fingerprint(root, file.key);
    if (file.bytes !== actual.bytes || file.sha256 !== actual.sha256) throw new Error(`백업 무결성 검사 실패: ${file.key}`);
  }
  await pg('pg_restore', ['--list', join(root, 'database.dump')]);
  return manifest;
}

async function retain(root: string, keep: number, kind: z.infer<typeof backupKind>) {
  const names: string[] = [];
  for (const f of await readdir(root, { withFileTypes: true })) {
    if (!f.isDirectory() || !NAME.test(f.name)) continue;
    try {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(join(root, f.name, 'manifest.json'), 'utf8')));
      if (manifest.kind === kind) names.push(f.name);
    } catch {
      // 읽을 수 없는 백업은 지우지 않는다. 한 폴더의 손상이 나머지 보존 정리를 막지 않는다.
      console.warn(`백업 보존 제외: ${f.name}의 manifest를 읽을 수 없습니다. 별도 확인이 필요합니다.`);
    }
  }
  names.sort();
  // 야간·수동·배포 전 백업은 서로 밀어내지 않는다. 종류를 모르는 구버전과 .dump는 보존한다.
  for (const name of names.slice(0, Math.max(0, names.length - keep))) await rm(join(root, name), { recursive: true });
}

async function privateTree(root: string) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error('백업에 심볼릭 링크를 사용할 수 없습니다');
  const mode = info.isDirectory() ? 0o700 : 0o600;
  // CIFS의 고정 file_mode/dir_mode도 실제 권한이 맞으면 사용할 수 있다.
  if ((info.mode & 0o777) !== mode) await chmod(root, mode);
  if (((await lstat(root)).mode & 0o777) !== mode) throw new Error('백업 저장소에서 비공개 파일 권한을 설정할 수 없습니다');
  if (info.isDirectory()) for (const name of await readdir(root)) await privateTree(join(root, name));
}

export async function createBackup(options: { databaseUrl: string; dataDir: string; backupDir: string; envFile?: string; mirrorDir?: string; keep?: number; kind?: z.infer<typeof backupKind> }) {
  const root = resolve(options.backupDir);
  const keep = options.keep ?? 14;
  const kind = backupKind.parse(options.kind ?? 'manual');
  if (!Number.isInteger(keep) || keep < 1) throw new Error('보존 개수는 1 이상이어야 합니다');
  const data = resolve(options.dataDir);
  if (root === data || root.startsWith(join(data, 'captures') + sep) || root === join(data, 'captures')) throw new Error('백업은 캡처 저장소 밖에 두어야 합니다');
  const mirror = options.mirrorDir ? resolve(options.mirrorDir) : null;
  if (mirror === root) throw new Error('외부 백업 폴더는 로컬 백업 폴더와 달라야 합니다');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const name = `geomsupin-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  const partial = join(root, `.incomplete-${randomUUID()}`);
  const destination = join(root, name);
  await mkdir(partial, { mode: 0o700 });
  const sql = connect(options.databaseUrl, 1);
  try {
    // 요청 쓰기·삭제를 잠깐 대기시키고, 같은 MVCC 스냅샷으로 DB와 캡처 목록을 묶는다.
    const manifest = await sql.begin('isolation level repeatable read', async (tx) => {
      await tx`set local lock_timeout = '10s'`;
      await tx`lock table requests in share mode`;
      const [snapshot] = await tx<{ snapshot: string }[]>`select pg_export_snapshot() as snapshot`;
      // 배포 전 백업은 아직 새 마이그레이션을 적용하지 않은 DB를 읽을 수 있다.
      const [columns] = await tx<{ has_proposal: boolean }[]>`
        select exists (
          select 1 from pg_attribute where attrelid = 'requests'::regclass and attname = 'proposal_key' and not attisdropped
        ) as has_proposal`;
      const proposal = columns?.has_proposal ? tx`proposal_key` : tx`null::text as proposal_key`;
      const rows = await tx<{ screenshot_key: string | null; thumb_key: string | null; proposal_key: string | null }[]>`
        select screenshot_key, thumb_key, ${proposal} from requests`;
      const files: Manifest['files'] = [];
      for (const key of new Set(rows.flatMap((r) => [r.screenshot_key, r.thumb_key, r.proposal_key]).filter((k): k is string => !!k))) {
        await fingerprint(data, key);
        await mkdir(dirname(join(partial, key)), { recursive: true, mode: 0o700 });
        await copyFile(join(data, key), join(partial, key));
        await chmod(join(partial, key), 0o600);
        files.push(await fingerprint(partial, key));
      }
      await pg('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--snapshot', snapshot!.snapshot, '--file', join(partial, 'database.dump')], options.databaseUrl);
      await chmod(join(partial, 'database.dump'), 0o600);
      files.push(await fingerprint(partial, 'database.dump'));
      if (options.envFile) {
        await copyFile(options.envFile, join(partial, 'config.env'));
        await chmod(join(partial, 'config.env'), 0o600);
        files.push(await fingerprint(partial, 'config.env'));
      }
      return { format: 1 as const, kind, createdAt: new Date().toISOString(), requests: rows.length, files };
    });
    await writeFile(join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await verifyBackup(partial);
    await rename(partial, destination);
    // 외부 저장소가 끊기거나 권한 검사가 실패해도 로컬 백업·보존 정리는 완료한다.
    await retain(root, keep, kind);
    if (mirror) {
      if (!(await lstat(mirror)).isDirectory()) throw new Error('외부 백업 폴더가 준비되지 않았습니다');
      const staging = join(mirror, `.incomplete-${randomUUID()}`);
      try {
        await cp(destination, staging, { recursive: true, errorOnExist: true, force: false });
        await privateTree(staging);
        await verifyBackup(staging);
        await rename(staging, join(mirror, name));
        await retain(mirror, keep, kind);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    return { directory: destination, manifest, mirrored: mirror ? join(mirror, name) : null };
  } finally { await sql.end({ timeout: 2 }); await rm(partial, { recursive: true, force: true }); }
}

/** 빈 DB와 빈 데이터 폴더로만 복구한다. 기존 운영 데이터를 덮어쓰지 않는다. */
export async function restoreBackup(options: { backupDir: string; databaseUrl: string; dataDir: string }) {
  const backup = resolve(options.backupDir);
  const data = resolve(options.dataDir);
  if (data === backup || data.startsWith(backup + sep)) throw new Error('백업 폴더 안에 복구할 수 없습니다');
  const manifest = await verifyBackup(backup);
  await mkdir(data, { recursive: true, mode: 0o700 });
  if ((await readdir(data)).length) throw new Error('복구 대상 데이터 폴더가 비어 있지 않습니다');
  const sql = connect(options.databaseUrl, 1);
  try {
    const [tables] = await sql`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')`;
    if (tables!.n) throw new Error('복구 대상 DB가 비어 있지 않습니다');
    for (const file of manifest.files.filter((f) => CAPTURE.test(f.key))) {
      await mkdir(dirname(join(data, file.key)), { recursive: true, mode: 0o700 });
      await copyFile(join(backup, file.key), join(data, file.key));
      await chmod(join(data, file.key), 0o600);
    }
    if (manifest.files.some((f) => f.key === 'config.env')) {
      await copyFile(join(backup, 'config.env'), join(data, 'recovered.env'));
      await chmod(join(data, 'recovered.env'), 0o600);
    }
    await pg('pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', join(backup, 'database.dump')], options.databaseUrl);
    const [count] = await sql`select count(*)::int as n from requests`;
    if (count!.n !== manifest.requests) throw new Error('복구된 요청 수가 백업과 다릅니다');
    return { requests: count!.n as number, captures: manifest.files.filter((f) => CAPTURE.test(f.key)).length };
  } finally { await sql.end({ timeout: 2 }); }
}
