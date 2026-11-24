import { restoreBackup } from '../server/backup.ts';

try {
  const [backupDir, dataDir] = process.argv.slice(2);
  const databaseUrl = process.env.RESTORE_DATABASE_URL;
  if (!backupDir || !dataDir || !databaseUrl) throw new Error('사용법: RESTORE_DATABASE_URL=<빈 DB 접속 주소> npm run restore -- <백업 폴더> <빈 데이터 폴더>');
  const result = await restoreBackup({ backupDir, dataDir, databaseUrl });
  console.log(`복구 완료: 요청 ${result.requests}건, 캡처 ${result.captures}개. recovered.env가 있으면 DATABASE_URL·DATA_DIR을 새 환경에 맞게 설정하세요.`);
} catch (e) { console.error(e instanceof Error ? e.message : '복구 실패'); process.exitCode = 1; }
