import { loadEnvFile } from '../shared/env-file.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const bool = (d: boolean) => z.preprocess((v) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())), z.boolean());

const schema = z.object({
  PORT: z.coerce.number().int().default(8200),
  HOST: z.string().default('127.0.0.1'),
  PUBLIC_URL: z.string().url(),
  ALLOWED_HOSTS: z.string().default(''),
  DATABASE_URL: z.string().min(1),
  DATA_DIR: z.string().default('./data'),
  AUTH_SECRET: z.string().min(32),
  /** 빌드 결과(관리 화면·위젯) 폴더. 라이브 서비스를 건드리지 않고 다른 폴더에서 시험할 때 바꾼다 */
  DIST_DIR: z.string().default('dist'),
  /** 이미지 프록시(/api/w/img) 사용 여부. false 면 위젯은 프록시 없이 캡처하고 CORS 없는 이미지는 사선 무늬로 남는다 */
  IMAGE_PROXY_ENABLED: bool(true),
  /** 시험 전용: 이미지 프록시가 내부 주소도 받게 한다. 공개 서버에서는 절대 켜지 않는다 */
  IMAGE_PROXY_ALLOW_PRIVATE: bool(false),
  /** 파일 서명 주소의 기본 만료(초) — 엑셀에 들어가는 원본 링크 */
  FILE_URL_TTL_LONG: z.coerce.number().default(30 * 24 * 3600),
  /** 관리 화면에서 보는 이미지의 만료(초) */
  FILE_URL_TTL_SHORT: z.coerce.number().default(3600),
});

export type Config = ReturnType<typeof buildConfig>;

export function buildConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  const publicUrl = new URL(c.PUBLIC_URL);
  const dataDir = resolve(ROOT, c.DATA_DIR);
  const hosts = new Set(
    c.ALLOWED_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).concat(publicUrl.host.toLowerCase()),
  );
  return {
    port: c.PORT,
    host: c.HOST,
    publicUrl: c.PUBLIC_URL.replace(/\/$/, ''),
    publicOrigin: publicUrl.origin,
    secureCookies: publicUrl.protocol === 'https:',
    allowedHosts: hosts,
    databaseUrl: c.DATABASE_URL,
    dataDir,
    capturesDir: join(dataDir, 'captures'),
    authSecret: c.AUTH_SECRET,
    imageProxyEnabled: c.IMAGE_PROXY_ENABLED,
    imageProxyAllowPrivate: c.IMAGE_PROXY_ALLOW_PRIVATE,
    fileUrlTtlLong: c.FILE_URL_TTL_LONG,
    fileUrlTtlShort: c.FILE_URL_TTL_SHORT,
    distDir: resolve(ROOT, c.DIST_DIR),
  };
}

export function loadConfig() {
  loadEnvFile(process.env.GP_ENV_FILE || join(ROOT, '.env'));
  return buildConfig();
}
