import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const schema = z.object({ state: z.enum(['running', 'ok', 'failed']), updatedAt: z.string().datetime(), lastSuccessAt: z.string().datetime().nullable() }).refine(value => value.state !== 'ok' || value.lastSuccessAt !== null);

/** 야간 백업만 기록한다. 수동 성공이 야간 실패나 장기 미실행을 숨기지 않는다. */
export async function recordScheduledBackup(dataDir: string, state: 'running' | 'ok' | 'failed', now = new Date()) {
  const path = join(dataDir, 'backup-status.json');
  let lastSuccessAt: string | null = null;
  try { lastSuccessAt = schema.parse(JSON.parse(await readFile(path, 'utf8'))).lastSuccessAt; } catch { /* 최초 실행 또는 손상 */ }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ state, updatedAt: now.toISOString(), lastSuccessAt: state === 'ok' ? now.toISOString() : lastSuccessAt }) + '\n', { mode: 0o600 });
  await rename(temp, path);
}

export async function scheduledBackupStatus(dataDir: string, now = Date.now()) {
  let status: z.infer<typeof schema>;
  try { status = schema.parse(JSON.parse(await readFile(join(dataDir, 'backup-status.json'), 'utf8'))); }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unknown' : 'failed', lastSuccessAt: null }; }
  let state: string = status.state;
  if (state === 'running' && now - Date.parse(status.updatedAt) > 30 * 60_000) state = 'failed';
  if (state === 'ok' && now - Date.parse(status.lastSuccessAt!) > 36 * 3600_000) state = 'overdue';
  return { state, lastSuccessAt: status.lastSuccessAt };
}
