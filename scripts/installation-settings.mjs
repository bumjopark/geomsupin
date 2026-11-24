import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../shared/env-file.mjs';

export function readInstallation(root) {
  const env = {};
  loadEnvFile(join(root, '.env'), env);
  const externalDatabase = env.GP_DATABASE_MODE
    ? env.GP_DATABASE_MODE === 'external'
    : Boolean(env.DATABASE_URL) && !existsSync(join(root, 'data', 'postgres', 'PG_VERSION'));
  return { env, externalDatabase };
}
