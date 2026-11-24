// 위젯 API는 관리자 쿠키와 분리한다. 프로젝트 키, 검수 세션, 연결한 스테이징의 출처를 확인한다.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { randomToken, sha256 } from '../security.ts';
import { clientIp, clip, errorBody, httpError } from '../util.ts';
import { makeErrorHandler } from '../errors.ts';
import { fetchPublicImage, ProxyError } from '../imageproxy.ts';
import { decodeDataUrl, ImageError, processCapture } from '../images.ts';
import { newCaptureKey, signedUrl } from '../storage.ts';
import { KINDS, STATUSES, normalizePageUrl, type Status } from '../../shared/constants.ts';
import { commentBody, commentQuery, loadComments, mutationId, statusSentence } from '../comments.ts';
import { sitePreview } from './sites.ts';
import { streamReviewEvents, type ReviewEvents } from '../review-events.ts';

interface SiteInfo {
  id: string;
  name: string;
  preview_url: string;
  preview_id: string | null;
}
interface WidgetAuth {
  site: SiteInfo;
  sessionId: string;
  reviewerId: string;
  reviewerName: string;
  expiresAt: number;
  pageOrigin: string;
}

const ALLOW_HEADERS = 'Content-Type, Authorization, X-GP-Key';

const sessionSchema = z.object({
  token: z.string().min(10).max(200),
  pid: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  previewId: z.uuid(),
});

interface BoardRow {
  id: string; no: number; body: string; status: Status; kind: string;
  page_url: string; page_title: string; selector: string; text_hint: string;
  offset_x: number | null; offset_y: number | null; viewport_w: number | null; browser: string; os: string;
  as_is: string | null; to_be: string | null;
  screenshot_key: string | null; thumb_key: string | null; proposal_key: string | null;
  created_at: Date; updated_at: Date; resolved_at: Date | null; updated_by: string;
  assignee1: string; resolution_note: string;
  reviewer_id: string | null; author_name: string; comment_count: number; last_by: string | null; last_text: string | null;
}
const BOARD_COLS = (sql: import('../db.ts').Sql) => sql`
  r.id, r.no, r.body, r.status, r.kind, r.page_url, r.page_title, r.selector, r.text_hint, r.offset_x, r.offset_y, r.viewport_w, r.browser, r.os,
  r.as_is, r.to_be, r.screenshot_key, r.thumb_key, r.proposal_key, r.created_at, r.updated_at, r.resolved_at, r.updated_by, r.assignee1, r.resolution_note, r.reviewer_id,
  coalesce(nullif(rv.name, ''), r.reviewer_name) as author_name,
  (select count(*)::int from comments c where c.request_id = r.id and c.author_type <> 'system') as comment_count,
  (select c.author_name from comments c where c.request_id = r.id and c.author_type <> 'system' order by c.created_at desc limit 1) as last_by,
  (select left(c.body, 80) from comments c where c.request_id = r.id and c.author_type <> 'system' order by c.created_at desc limit 1) as last_text`;

const nameSchema = z.string().trim().min(1, '이름을 입력해 주세요').max(30, '이름은 30자까지예요');
const displayName = (n: string) => n || '손님';

const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const createSchema = z.object({
  mutationId,
  pageUrl: z.string().url().max(2000),
  pageTitle: z.string().max(200).default(''),
  selector: z.string().max(600).default(''),
  textHint: z.string().max(120).default(''),
  offsetX: num(-1, 2).nullish(),
  offsetY: num(-1, 2).nullish(),
  pageX: num(-100000, 100000).nullish(),
  pageY: num(-100000, 100000).nullish(),
  viewportW: num(100, 20000),
  viewportH: num(100, 20000),
  scrollY: num(-100000, 1000000).nullish(),
  dpr: num(0.1, 10).nullish(),
  browser: z.string().max(60).default(''),
  os: z.string().max(60).default(''),
  name: z.string().trim().max(30).optional(),
  body: z.string().trim().min(1, '내용을 입력해 주세요').max(2000),
  asIs: z.string().trim().max(1000).nullish(),
  toBe: z.string().trim().max(1000).nullish(),
  kind: z.enum(KINDS).default('수정'),
  screenshot: z.string().max(9_000_000).nullish(),
  proposalScreenshot: z.string().max(4_000_100).nullish(),
  captureNotes: z.object({ images: z.number().int().min(0).max(9999).optional(), iframes: z.number().int().min(0).max(999).optional(), fonts: z.number().int().min(0).max(999).optional(), failed: z.boolean().optional() }).partial().default({}),
});

export function widgetRoutes(ctx: AppContext, events: ReviewEvents) {
  const { sql, config } = ctx;

  async function resolveSite(req: FastifyRequest): Promise<SiteInfo> {
    const key = req.headers['x-gp-key'];
    if (typeof key !== 'string' || !/^gpk_[A-Za-z0-9_-]{10,60}$/.test(key)) throw httpError(400, 'bad_key', '위젯 키가 올바르지 않습니다');
    const rows = await sql<SiteInfo[]>`select id, name, preview_url, preview_id from sites where widget_key = ${key} and status = 'active'`;
    const s = rows[0];
    if (!s) throw httpError(404, 'unknown_key', '알 수 없는 위젯 키입니다');
    return s;
  }

  async function authenticate(req: FastifyRequest, reply?: FastifyReply): Promise<WidgetAuth> {
    const site = await resolveSite(req);
    const preview = sitePreview(config, site);
    const pageOrigin = preview ? new URL(preview.url).origin : undefined;
    if (!preview || !pageOrigin || req.headers.origin !== pageOrigin) {
      throw httpError(401, 'session_invalid', '미리보기 연결이 종료되었어요');
    }
    if (reply) reply.header('Access-Control-Allow-Origin', pageOrigin).header('Vary', 'Origin');
    const h = req.headers.authorization;
    const token = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token) throw httpError(401, 'no_session', '검수 세션이 없습니다');
    const sessionId = sha256(token);
    const rows = await sql<{ reviewer_id: string; name: string; revoked_at: Date | null; link_expires: Date | null; session_expires: Date }[]>`
      select ws.reviewer_id, r.name, l.revoked_at, l.expires_at as link_expires, ws.expires_at as session_expires
      from widget_sessions ws
      join reviewers r on r.id = ws.reviewer_id
      join review_links l on l.id = ws.link_id
      where ws.id = ${sessionId} and ws.site_id = ${site.id} and ws.preview_id = ${preview.id} and ws.expires_at > now()`;
    const s = rows[0];
    const expiresAt = s ? Math.min(s.session_expires.getTime(), s.link_expires?.getTime() ?? Infinity) : 0;
    if (!s || s.revoked_at || expiresAt <= Date.now()) throw httpError(401, 'session_invalid', '검수 링크가 종료되었거나 세션이 만료되었습니다');
    return { site, sessionId, reviewerId: s.reviewer_id, reviewerName: s.name, expiresAt, pageOrigin };
  }

  const roundOf = async (siteId: string) => {
    const open = await sql<{ id: string; no: number }[]>`select id, no from rounds where site_id = ${siteId} and status = 'open' order by no desc limit 1`;
    if (open[0]) return open[0];
    const next = (await sql<{ next: number }[]>`select coalesce(max(no), 0) + 1 as next from rounds where site_id = ${siteId}`)[0]!.next;
    const [r] = await sql<{ id: string; no: number }[]>`insert into rounds (site_id, no) values (${siteId}, ${next}) returning id, no`;
    return r!;
  };

  // ── 공유 보드 보기 ──
  async function boardRow(siteId: string, id: string): Promise<BoardRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpError(404, 'not_found', '요청을 찾을 수 없어요');
    const rows = await sql<BoardRow[]>`
      select ${BOARD_COLS(sql)} from requests r left join reviewers rv on rv.id = r.reviewer_id
      where r.id = ${id} and r.site_id = ${siteId}`;
    const r = rows[0];
    if (!r) throw httpError(404, 'not_found', '요청을 찾을 수 없어요(지워졌을 수 있어요)');
    return r;
  }

  const signed = (key: string | null, auth: WidgetAuth) =>
    key ? signedUrl(config.publicUrl, config.authSecret, key, config.fileUrlTtlShort, auth.sessionId) : null;

  function boardView(r: BoardRow, a: WidgetAuth) {
    return {
      id: r.id, no: r.no, body: r.body, status: r.status, kind: r.kind,
      pageUrl: normalizePageUrl(r.page_url), pageTitle: r.page_title, selector: r.selector, textHint: r.text_hint,
      offsetX: r.offset_x, offsetY: r.offset_y, viewportW: r.viewport_w,
      thumbUrl: signed(r.thumb_key, a),
      createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by, resolvedAt: r.resolved_at,
      assignee: r.assignee1, resolutionNote: r.resolution_note,
      author: displayName(r.author_name), mine: r.reviewer_id === a.reviewerId,
      commentCount: r.comment_count,
      // 마지막 댓글을 쓴 사람과 앞부분(알림에 "누가 무슨 말을 했는지" 보여 주려고)
      lastBy: r.last_by ? displayName(r.last_by) : null, lastText: r.last_text,
    };
  }

  async function detailOf(a: WidgetAuth, id: string) {
    const r = await boardRow(a.site.id, id);
    return {
      ...boardView(r, a),
      asIs: r.as_is, toBe: r.to_be, browser: r.browser, os: r.os,
      screenshotUrl: signed(r.screenshot_key, a),
      proposalUrl: signed(r.proposal_key, a),
      ...await loadComments(sql, r.id, a.reviewerId),
    };
  }

  return async (app: FastifyInstance) => {
    // 초대 링크에 연결된 미리보기용 세션을 발급한다.
    const sessionOptions = {
      config: { rateLimit: { max: 1500, timeWindow: '10 minutes', keyGenerator: (r: FastifyRequest) => clientIp(r) } },
    };
    const exchangeSession = (bookmark = false) => async (req: FastifyRequest, reply: FastifyReply) => {
      if (!bookmark && req.headers.origin !== config.publicOrigin) {
        throw httpError(403, 'preview_unavailable', '검수핀에서 초대 링크를 열어 주세요');
      }
      const site = await resolveSite(req);
      const preview = sitePreview(config, site);
      if (bookmark) {
        const origin = preview && new URL(preview.url).origin;
        if (!origin || req.headers.origin !== origin) {
          return reply.code(403).send(errorBody('preview_unavailable', '연결된 스테이징에서 북마크를 눌러 주세요'));
        }
        reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
      }
      const b = sessionSchema.parse(req.body);
      if (!preview || b.previewId !== preview.id) throw httpError(403, 'preview_unavailable', '미리보기 연결을 확인해 주세요');
      const [link] = await sql<{ id: string }[]>`
        select id from review_links where token = ${b.token} and site_id = ${site.id}
          and revoked_at is null and (expires_at is null or expires_at > now())`;
      if (!link) throw httpError(404, 'link_invalid', '유효하지 않거나 닫힌 링크예요');

      const session = randomToken();
      const reviewer = await sql.begin(async tx => {
        const [person] = await tx<{ id: string; name: string }[]>`
          insert into reviewers (site_id, link_id, name, pid) values (${site.id}, ${link.id}, '', ${b.pid})
          on conflict (site_id, pid) where pid is not null do update set last_seen_at = now()
          returning id, name`;
        await tx`insert into widget_sessions (id, site_id, link_id, reviewer_id, expires_at, preview_id)
          values (${sha256(session)}, ${site.id}, ${link.id}, ${person!.id}, now() + interval '2 hours', ${b.previewId})`;
        return person!;
      });
      return { session, reviewer };
    };
    app.post('/session', sessionOptions, exchangeSession());
    app.post('/bookmark-session', sessionOptions, exchangeSession(true));

    // 이름을 정하거나 고친다.
    app.patch('/reviewer', async (req, reply) => {
      const a = await authenticate(req, reply);
      const b = z.object({ name: nameSchema }).parse(req.body);
      const [r] = await sql<{ id: string; name: string }[]>`update reviewers set name = ${b.name}, last_seen_at = now() where id = ${a.reviewerId} returning id, name`;
      events.publish(a.site.id);
      return { reviewer: r };
    });

    // 요청 남기기
    app.post('/requests', {
      bodyLimit: 10 * 1024 * 1024,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (r: FastifyRequest) => `${clientIp(r)}|${String(r.headers.authorization ?? '').slice(-16)}`,
        },
      },
    }, async (req, reply) => {
      const a = await authenticate(req, reply);
      const b = createSchema.parse(req.body);
      if (b.proposalScreenshot && (!b.screenshot || !b.asIs || !b.toBe)) {
        throw httpError(400, 'invalid_proposal', '연결된 미리보기에서 현재 화면과 위치 변경 제안을 함께 저장해 주세요');
      }
      // 이름은 첫 요청을 남길 때 받는다(링크로 들어올 때는 묻지 않는다).
      if (b.name && b.name !== a.reviewerName) {
        await sql`update reviewers set name = ${b.name}, last_seen_at = now() where id = ${a.reviewerId}`;
        a.reviewerName = b.name;
      }
      if (!a.reviewerName) throw httpError(400, 'name_required', '이름을 알려 주세요');

      let pageOrigin = '';
      try { pageOrigin = new URL(b.pageUrl).origin; } catch { /* zod 가 이미 검증 */ }
      if (pageOrigin !== a.pageOrigin) throw httpError(400, 'page_mismatch', '요청 주소가 현재 사이트와 다릅니다');

      const responseOf = (r: { id: string; no: number; status: string; created_at: Date }) => ({ request: { id: r.id, no: r.no, status: r.status, createdAt: r.created_at } });
      if (b.mutationId) {
        const [existing] = await sql<{ id: string; no: number; status: string; created_at: Date }[]>`select id, no, status, created_at from requests where reviewer_id = ${a.reviewerId} and mutation_id = ${b.mutationId}`;
        if (existing) return responseOf(existing);
      }

      const n = (await sql<{ n: number }[]>`select count(*)::int as n from requests where site_id = ${a.site.id} and created_at > now() - interval '1 day'`)[0]!.n;
      if (n >= 3000) throw httpError(429, 'daily_limit', '하루 요청 한도를 넘었습니다');

      let fullKey: string | null = null;
      let thumbKey: string | null = null;
      let proposalKey: string | null = null;
      const cleanup = async () => {
        for (const key of [fullKey, thumbKey, proposalKey]) if (key) await ctx.storage.delete(key).catch(() => {});
      };
      let created;
      let reused = false;
      try {
        if (b.screenshot) {
          const processed = await processCapture(decodeDataUrl(b.screenshot));
          fullKey = newCaptureKey('full', 'webp');
          thumbKey = newCaptureKey('thumb', 'jpg');
          await ctx.storage.put(fullKey, processed.full);
          await ctx.storage.put(thumbKey, processed.thumb);
        }
        if (b.proposalScreenshot) {
          const processed = await processCapture(decodeDataUrl(b.proposalScreenshot));
          proposalKey = newCaptureKey('proposal', 'webp');
          await ctx.storage.put(proposalKey, processed.full);
        }
        const round = await roundOf(a.site.id);
        created = await sql.begin(async (tx) => {
          // 같은 프로젝트의 번호 발급과 재시도 판정을 직렬화한다.
          const [site] = await tx`select id from sites where id = ${a.site.id} and status = 'active' for update`;
          if (!site) throw httpError(404, 'unknown_key', '검수가 종료된 프로젝트입니다');
          if (b.mutationId) {
            const [existing] = await tx<{ id: string; no: number; status: string; created_at: Date }[]>`select id, no, status, created_at from requests where reviewer_id = ${a.reviewerId} and mutation_id = ${b.mutationId}`;
            if (existing) { reused = true; return existing; }
          }
          const [seq] = await tx<{ request_seq: number }[]>`update sites set request_seq = request_seq + 1 where id = ${a.site.id} returning request_seq`;
          const [row] = await tx<{ id: string; no: number; status: string; created_at: Date }[]>`
            insert into requests (
              site_id, round_id, no, reviewer_id, reviewer_name, page_url, page_title, selector, text_hint,
              offset_x, offset_y, page_x, page_y, viewport_w, viewport_h, scroll_y, dpr, browser, os,
              screenshot_key, thumb_key, proposal_key, capture_notes, kind, body, as_is, to_be, mutation_id
            ) values (
              ${a.site.id}, ${round.id}, ${seq!.request_seq}, ${a.reviewerId}, ${a.reviewerName}, ${normalizePageUrl(b.pageUrl)}, ${clip(b.pageTitle, 200)}, ${b.selector}, ${b.textHint},
              ${b.offsetX ?? null}, ${b.offsetY ?? null}, ${b.pageX == null ? null : Math.round(b.pageX)}, ${b.pageY == null ? null : Math.round(b.pageY)},
              ${Math.round(b.viewportW)}, ${Math.round(b.viewportH)}, ${b.scrollY == null ? null : Math.round(b.scrollY)}, ${b.dpr ?? null}, ${b.browser}, ${b.os},
              ${fullKey}, ${thumbKey}, ${proposalKey}, ${sql.json(b.captureNotes)}, ${b.kind}, ${b.body}, ${b.asIs || null}, ${b.toBe || null}, ${b.mutationId ?? null}
            ) returning id, no, status, created_at`;
          return row!;
        });
      } catch (e) {
        await cleanup();
        if (e instanceof ImageError) throw httpError(400, 'bad_image', e.message);
        throw e;
      }
      if (reused) await cleanup();
      else events.publish(a.site.id);
      return responseOf(created);
    });

    // Preflight에는 프로젝트 키가 없으므로 출처 등록 여부를 보고, 실제 요청에서 프로젝트까지 검증한다.
    app.options('/*', async (req, reply) => {
      const origin = req.headers.origin;
      reply.header('Vary', 'Origin');
      if (!origin) return reply.code(403).send();
      const known = await sql`select 1 from sites where preview_id is not null and substring(preview_url from '^https?://[^/?#]+') = ${origin} limit 1`;
      if (!known.length) return reply.code(403).send();
      reply.header('Access-Control-Allow-Origin', origin);
      if (req.headers['access-control-request-private-network'] === 'true') reply.header('Access-Control-Allow-Private-Network', 'true');
      return reply
        .header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
        .header('Access-Control-Allow-Headers', ALLOW_HEADERS)
        .header('Access-Control-Max-Age', '600')
        .code(204)
        .send();
    });

    app.get('/events', {
      exposeHeadRoute: false,
      config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => `${clientIp(r)}|${String(r.headers.authorization ?? '').slice(-16)}` } },
    }, async (req, reply) => {
      const a = await authenticate(req, reply);
      return streamReviewEvents(reply, events, a.site.id, a.expiresAt, async () => (await authenticate(req)).expiresAt);
    });

    // 이 사이트의 모든 요청(링크를 받은 모두가 함께 본다)
    app.get('/requests', async (req, reply) => {
      const a = await authenticate(req, reply);
      // 밀리초로 반올림한 최종 시각은 빠른 동시 변경과 이름 변경을 놓친다. 모든 행의 원래 시각·표시 이름을 버전에 넣는다.
      const { v, before } = z.object({ v: z.string().max(60).optional(), before: z.coerce.number().int().positive().optional() }).parse(req.query);
      const [ver] = await sql<{ version: string }[]>`
        select md5(coalesce(string_agg(r.id::text || ':' || r.updated_at::text || ':' || coalesce(rv.name, ''), ',' order by r.id), '')) as version
        from requests r left join reviewers rv on rv.id = r.reviewer_id where r.site_id = ${a.site.id}`;
      const version = ver!.version;
      if (!before && v === version) return { unchanged: true, version, now: new Date() };
      const rows = await sql<BoardRow[]>`
        select ${BOARD_COLS(sql)} from requests r left join reviewers rv on rv.id = r.reviewer_id
        where r.site_id = ${a.site.id}
          ${before ? sql`and r.no < ${before}` : sql``}
        order by r.no desc limit 501`;
      const page = rows.slice(0, 500);
      return { requests: page.map((r) => boardView(r, a)), nextBefore: rows.length > 500 ? page.at(-1)!.no : null, version, now: new Date() };
    });

    // 요청 하나: 본문 + 댓글 + 큰 캡처
    app.get('/requests/:id', async (req, reply) => {
      const a = await authenticate(req, reply);
      return { request: await detailOf(a, (req.params as { id: string }).id) };
    });

    app.get('/requests/:id/comments', async (req, reply) => {
      const a = await authenticate(req, reply);
      const r = await boardRow(a.site.id, (req.params as { id: string }).id);
      return loadComments(sql, r.id, a.reviewerId, commentQuery.parse(req.query).before);
    });

    // 상태 바꾸기(누구나) · 내 요청 내용 고치기(본인만)
    app.patch('/requests/:id', {
      config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => `${clientIp(r)}|${String(r.headers.authorization ?? '').slice(-16)}` } },
    }, async (req, reply) => {
      const a = await authenticate(req, reply);
      const id = (req.params as { id: string }).id;
      const b = z.object({ status: z.enum(STATUSES).optional(), body: z.string().trim().min(1, '내용을 입력해 주세요').max(2000).optional() }).parse(req.body);
      const cur = await boardRow(a.site.id, id);
      if (b.body !== undefined && cur.reviewer_id !== a.reviewerId) throw httpError(403, 'not_yours', '내가 남긴 요청만 고칠 수 있어요');
      if (b.status !== undefined && !a.reviewerName) throw httpError(400, 'name_required', '이름을 알려 주세요. 누가 바꿨는지 함께 보는 분들께 보여 줘요');
      const actor = displayName(a.reviewerName);
      await sql.begin(async (tx) => {
        const [fresh] = await tx<{ status: Status; body: string; resolved_at: Date | null }[]>`select status, body, resolved_at from requests where id = ${cur.id} for update`;
        if (!fresh) throw httpError(404, 'not_found', '요청을 찾을 수 없어요');
        const statusChanged = b.status !== undefined && b.status !== fresh.status;
        let resolvedAt = fresh.resolved_at;
        if (statusChanged) resolvedAt = b.status === '완료' ? new Date() : ['접수', '진행', '재발생'].includes(b.status!) ? null : fresh.resolved_at;
        await tx`update requests set status = ${b.status ?? fresh.status}, body = ${b.body ?? fresh.body}, resolved_at = ${resolvedAt}, updated_at = clock_timestamp(), updated_by = ${actor} where id = ${cur.id}`;
        if (statusChanged) await tx`insert into comments (request_id, author_type, author_id, author_name, body, created_at) values (${cur.id}, 'system', ${a.reviewerId}, ${actor}, ${statusSentence(b.status!)}, clock_timestamp())`;
      });
      events.publish(a.site.id);
      return { request: await detailOf(a, id) };
    });

    // 내가 남긴 요청 지우기
    app.delete('/requests/:id', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => `${clientIp(r)}|${String(r.headers.authorization ?? '').slice(-16)}` } },
    }, async (req, reply) => {
      const a = await authenticate(req, reply);
      const cur = await boardRow(a.site.id, (req.params as { id: string }).id);
      if (cur.reviewer_id !== a.reviewerId) throw httpError(403, 'not_yours', '내가 남긴 요청만 지울 수 있어요');
      await sql`delete from requests where id = ${cur.id}`;
      events.publish(a.site.id);
      if (cur.screenshot_key) await ctx.storage.delete(cur.screenshot_key).catch(() => {});
      if (cur.thumb_key) await ctx.storage.delete(cur.thumb_key).catch(() => {});
      if (cur.proposal_key) await ctx.storage.delete(cur.proposal_key).catch(() => {});
      return { ok: true };
    });

    // 댓글 남기기(링크를 받은 누구나)
    app.post('/requests/:id/comments', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => `${clientIp(r)}|${String(r.headers.authorization ?? '').slice(-16)}` } },
    }, async (req, reply) => {
      const a = await authenticate(req, reply);
      const id = (req.params as { id: string }).id;
      const b = commentBody.parse(req.body);
      const cur = await boardRow(a.site.id, id);
      if (!a.reviewerName) throw httpError(400, 'name_required', '이름을 알려 주세요. 누가 남겼는지 함께 보는 분들께 보여 줘요');
      const inserted = await sql.begin(async (tx) => {
        const locked = await tx`select id from requests where id = ${cur.id} for update`;
        if (!locked.length) throw httpError(404, 'not_found', '요청을 찾을 수 없어요');
        const inserted = await tx`insert into comments (request_id, author_type, author_id, author_name, body, mutation_id) values (${cur.id}, 'reviewer', ${a.reviewerId}, ${displayName(a.reviewerName)}, ${b.body}, ${b.mutationId ?? null}) on conflict (request_id, author_type, author_id, mutation_id) do nothing returning id`;
        if (inserted.length) await tx`update requests set updated_at = clock_timestamp() where id = ${cur.id}`;
        return inserted.length > 0;
      });
      if (inserted) events.publish(a.site.id);
      return { request: await detailOf(a, id) };
    });

    // 이미지 프록시: CORS 를 열어 두지 않은 사이트의 이미지를 캡처에 담기 위해 서버가 대신 받아 준다(공개 이미지 주소만).
    app.get('/img', {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: '1 minute',
          keyGenerator: (r: FastifyRequest) => `img|${clientIp(r)}|${String(r.headers.authorization ?? '').slice(-16)}`,
        },
      },
    }, async (req, reply) => {
      if (!config.imageProxyEnabled) throw httpError(404, 'proxy_disabled', '이미지 프록시가 꺼져 있습니다');
      await authenticate(req, reply);
      const q = z.object({ u: z.string().max(2000) }).parse(req.query);
      try {
        const r = await fetchPublicImage(q.u, { referer: `${String(req.headers.origin)}/`, allowPrivate: config.imageProxyAllowPrivate });
        return reply
          .header('Content-Type', r.contentType)
          .header('Cache-Control', 'private, max-age=300')
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .send(r.body);
      } catch (e) {
        if (e instanceof ProxyError) throw httpError(e.status >= 400 && e.status < 600 ? e.status : 502, e.code, e.message);
        throw e;
      }
    });

    app.setErrorHandler(makeErrorHandler({ cors: true }));
  };
}
