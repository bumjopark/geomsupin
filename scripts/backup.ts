import { recordScheduledBackup } from '../server/backup-status.ts';
import { join } from 'node:path';
import { backupKind, createBackup, verifyBackup } from '../server/backup.ts';
import { loadConfig, ROOT } from '../server/config.ts';

let scheduledDataDir: string | undefined;
try {
  if (process.argv[2] === '--verify') {
    if (!process.argv[3]) throw new Error('검사할 백업 폴더가 필요합니다');
    const result = await verifyBackup(process.argv[3]);
    console.log(`검증 완료: 요청 ${result.requests}건, 파일 ${result.files.length}개`);
  } else {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--kind')) throw new Error('사용법: npm run backup -- [--kind scheduled|manual|deployment] 또는 --verify <폴더>');
    const kind = backupKind.parse(args[1] ?? 'manual');
    const config = loadConfig();
    if (kind === 'scheduled') { scheduledDataDir = config.dataDir; await recordScheduledBackup(config.dataDir, 'running'); }
    const result = await createBackup({ databaseUrl: config.databaseUrl, dataDir: config.dataDir,
      backupDir: process.env.BACKUP_DIR || join(config.dataDir, 'backups'), envFile: process.env.GP_ENV_FILE || join(ROOT, '.env'),
      mirrorDir: process.env.BACKUP_MIRROR_DIR || undefined, kind });
    if (scheduledDataDir) await recordScheduledBackup(scheduledDataDir, 'ok');
    console.log(`통합 백업 완료: ${result.directory} (요청 ${result.manifest.requests}건, 파일 ${result.manifest.files.length}개)`);
    if (result.mirrored) console.log(`외부 복사 완료: ${result.mirrored}`);
  }
} catch (e) {
  if (scheduledDataDir) await recordScheduledBackup(scheduledDataDir, 'failed').catch(() => console.error('백업 실패 상태 기록도 실패했습니다. 데이터 폴더와 디스크를 확인하세요.'));
  console.error(e instanceof Error ? e.message : '백업 실패'); process.exitCode = 1;
}
