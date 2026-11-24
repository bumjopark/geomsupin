import { scheduledBackupStatus } from './backup-status.ts';
import Fastify, { LogController, type FastifyInstance, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AppContext } from './context.ts';
import { makeErrorHandler } from './errors.ts';
import { errorBody } from './util.ts';
import { verifyFileSig } from './security.ts';
import { managementRoutes, requireAuth } from './routes/auth.ts';
import { siteRoutes } from './routes/sites.ts';
import { requestRoutes } from './routes/requests.ts';
import { widgetRoutes } from './routes/widget.ts';
import { loadShare, shareRoutes } from './routes/share.ts';
import { ReviewEvents } from './review-events.ts';

const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const { config } = ctx;
  // 초대 주소와 서명된 파일 주소가 서비스 로그에 남지 않게 한다.
  const app = Fastify({
    logger: opts.logger === false ? false : { level: 'info' },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  const reviewEvents = new ReviewEvents();
  app.addHook('preClose', async () => reviewEvents.close());

  // 본문 없이 JSON 콘텐츠 유형을 보내는 클라이언트도 처리한다.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch (e) { (e as { statusCode?: number }).statusCode = 400; done(e as Error, undefined); }
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false, keyGenerator: (r) => r.ip });

  // 허용되지 않은 Host 는 거절한다(터널 뒤에서도 우리 도메인만 받는다).
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!config.allowedHosts.has(host)) return reply.code(421).send(errorBody('bad_host', 'Unknown host'));
  });

  const adminOrigins = new Set<string>([config.publicOrigin]);
  for (const h of config.allowedHosts) { adminOrigins.add(`http://${h}`); adminOrigins.add(`https://${h}`); }

  // 관리 쿠키의 SameSite=Strict와 함께 쓰기 요청의 출처도 확인한다.
  app.addHook('onRequest', async (req, reply) => {
    if (!/^(POST|PATCH|PUT|DELETE)$/.test(req.method)) return;
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/w/')) return;
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    const bad = (typeof origin === 'string' && !adminOrigins.has(origin)) || (typeof fetchSite === 'string' && !['same-origin', 'none'].includes(fetchSite));
    if (bad) return reply.code(403).send(errorBody('csrf', '허용되지 않은 요청입니다'));
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    // API 응답은 Cloudflare·브라우저가 캐시하지 않는다.
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store');
    if (!reply.hasHeader('Referrer-Policy') && !req.url.startsWith('/api/w/') && !/^\/w\.js(?:\?|$)/.test(req.url)) reply.header('Referrer-Policy', 'same-origin');
    return undefined;
  });

  app.setErrorHandler(makeErrorHandler({ cors: false }));

  app.get('/healthz', async () => {
    await ctx.sql`select 1`;
    return { ok: true };
  });

  // ── 에이전시 API (쿠키 인증) ──
  await app.register(managementRoutes(ctx), { prefix: '/api/manage' });
  await app.register(async (api) => {
    api.addHook('preHandler', requireAuth(ctx));
    api.get('/operations/backup', () => scheduledBackupStatus(config.dataDir));
    await api.register(siteRoutes(ctx, reviewEvents), { prefix: '/sites' });
    await api.register(requestRoutes(ctx, reviewEvents));
  }, { prefix: '/api' });

  // ── 짧은 공유 링크 ──
  await app.register(shareRoutes(ctx));

  // ── 위젯 API (쿠키 미사용, 사이트별 CORS) ──
  await app.register(widgetRoutes(ctx, reviewEvents), { prefix: '/api/w' });

  // ── 파일: 만료되는 서명 주소로만 연다 ──
  const KEY_RE = /^captures\/\d{4}\/\d{2}\/[0-9a-f-]{36}-(?:full|thumb|proposal)\.(?:webp|jpg)$/;
  app.get('/files/*', async (req, reply) => {
    const key = decodeURIComponent((req.params as { '*': string })['*']);
    const q = req.query as { exp?: string; sig?: string };
    if (!KEY_RE.test(key) || !verifyFileSig(config.authSecret, key, Number(q.exp), String(q.sig ?? ''))) {
      return reply.code(403).send(errorBody('forbidden', '만료되었거나 올바르지 않은 주소입니다'));
    }
    const f = await ctx.storage.get(key);
    if (!f) return reply.code(404).send(errorBody('not_found', '파일을 찾을 수 없습니다'));
    return reply
      .header('Content-Type', key.endsWith('.webp') ? 'image/webp' : 'image/jpeg')
      .header('Content-Length', f.size)
      .header('Cache-Control', 'private, max-age=600')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      // 위젯이 고객 스테이징(다른 사이트) 화면 안에 캡처 미리보기를 보여 주므로 다른 사이트의 <img> 도 허용한다. 접근 통제는 서명·만료 주소가 한다.
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(f.stream);
  });

  // ── 위젯 파일 (고객 사이트가 다른 origin 에서 불러온다) ──
  // 본체·캡처는 파일명에 내용 해시가 있어 영구 캐시하고, 바뀌는 로더(w.js)는 매번 재검증(ETag)한다.
  // (Cloudflare 는 max-age 와 no-cache 를 Browser Cache TTL 로 늘려 버리므로, 갱신이 몇 시간씩 안 퍼진다. no-store 만 존중한다.)
  const widgetDir = join(config.distDir, 'widget');
  const etagOf = (buf: Buffer) => `"${createHash('sha1').update(buf).digest('base64url').slice(0, 20)}"`;
  const sendWidget = (name: string, immutable: boolean) => async (req: { headers: Record<string, unknown> }, reply: FastifyReply) => {
    const p = join(widgetDir, name);
    if (!existsSync(p)) return reply.code(404).send(errorBody('not_built', '위젯 파일을 찾을 수 없습니다'));
    const body = readFileSync(p);
    const etag = etagOf(body);
    reply
      .header('Content-Type', 'text/javascript; charset=utf-8')
      .header('Access-Control-Allow-Origin', '*')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('ETag', etag)
      // 로더는 no-store: Cloudflare 는 no-cache 도 Browser Cache TTL(기본 4시간)로 바꿔 버리지만 no-store 는 존중한다. 1KB 라 매번 받아도 부담이 없다.
      .header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-store');
    if (!immutable && req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send(body);
  };
  app.get('/w.js', sendWidget('w.js', false));
  app.get('/:file(^w-(?:core|capture)\\.[0-9a-f]{10}\\.js$)', async (req, reply) => sendWidget((req.params as { file: string }).file, true)(req, reply));

  // ── 관리 화면(SPA) ──
  const adminDir = join(config.distDir, 'admin');
  const assetsDir = join(adminDir, 'assets');
  if (existsSync(assetsDir)) {
    await app.register(fastifyStatic, {
      root: assetsDir,
      prefix: '/assets/',
      wildcard: false,
      index: false,
      setHeaders: reply => { reply.header('Cache-Control', 'public, max-age=31536000, immutable'); },
    });
  }
  const tutorialDir = join(adminDir, 'tutorial');
  if (existsSync(tutorialDir)) {
    await app.register(fastifyStatic, {
      root: tutorialDir,
      prefix: '/tutorial/',
      decorateReply: false,
      wildcard: false,
      index: false,
      maxAge: 0,
    });
  }
  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?', 1)[0]!;
    if (path.startsWith('/api/') || path.startsWith('/files/')) return reply.code(404).send(errorBody('not_found', '찾을 수 없습니다'));
    const index = join(adminDir, 'index.html');
    if (req.method !== 'GET' || !existsSync(index) || (path !== '/' && !/^\/(?:sites|r)(?:\/|$)/.test(path))) return reply.code(404).send('not found');
    const token = /^\/r\/([A-Za-z0-9_-]{16,80})\/?$/.exec(path)?.[1];
    const preview = token ? (await loadShare(ctx, token))?.preview : undefined;
    const csp = preview ? `${ADMIN_CSP}; frame-src ${new URL(preview.url).origin}` : ADMIN_CSP;
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', csp)
      .header('X-Frame-Options', 'DENY')
      .send(readFileSync(index));
  });

  return app;
}
