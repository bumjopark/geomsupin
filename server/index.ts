import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { connect, migrate } from './db.ts';
import { LocalStorage } from './storage.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
mkdirSync(config.capturesDir, { recursive: true, mode: 0o700 });

const sql = connect(config.databaseUrl);
const applied = await migrate(sql);
const ctx = { config, sql, storage: new LocalStorage(config.dataDir) };
const app = await buildApp(ctx);
if (applied.length) app.log.info({ applied }, 'migrations applied');

await app.listen({ port: config.port, host: config.host });
app.log.info(`geomsupin listening on ${config.host}:${config.port} (${config.publicUrl})`);

let closing = false;
const shutdown = async (sig: string) => {
  if (closing) return;
  closing = true;
  app.log.info(`${sig}: shutting down`);
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
