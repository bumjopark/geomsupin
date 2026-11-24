import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordScheduledBackup, scheduledBackupStatus } from '../server/backup-status.ts';

it('야간 백업의 실패·복구·장기 미실행·프로세스 중단을 구분한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gp-backup-status-'));
  const now = new Date('2026-10-06T00:00:00Z');
  try {
    expect((await scheduledBackupStatus(dir)).state).toBe('unknown');
    await recordScheduledBackup(dir, 'ok', now);
    expect((await scheduledBackupStatus(dir, +now + 37 * 3600_000)).state).toBe('overdue');
    await recordScheduledBackup(dir, 'failed', now);
    expect(await scheduledBackupStatus(dir, +now)).toEqual({ state: 'failed', lastSuccessAt: now.toISOString() });
    await recordScheduledBackup(dir, 'running', now);
    expect((await scheduledBackupStatus(dir, +now)).state).toBe('running');
    expect((await scheduledBackupStatus(dir, +now + 31 * 60_000)).state).toBe('failed');
    await recordScheduledBackup(dir, 'ok', now);
    expect((await scheduledBackupStatus(dir, +now)).state).toBe('ok');
    await writeFile(join(dir, 'backup-status.json'), '{broken');
    expect((await scheduledBackupStatus(dir, +now)).state).toBe('failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
