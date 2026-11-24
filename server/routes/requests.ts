import type { FastifyInstance } from 'fastify';
import type { ReviewEvents } from '../review-events.ts';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { signedUrl } from '../storage.ts';
import { contentDisposition, httpError } from '../util.ts';
import { KINDS, PRIORITIES, STATUSES, normalizePageUrl, type Status } from '../../shared/constants.ts';
import { normalizeLocale } from '../../shared/locale.ts';
import { ownedSite } from './sites.ts';
import { buildWorkbook, type ExportRow } from '../excel.ts';
import { commentBody, commentQuery, loadComments, statusSentence } from '../comments.ts';

interface ReqRow {
  id: string;
  site_id: string;
  no: number;
  round_no: number;
  reviewer_name: string;
  page_url: string;
  page_title: string;
  selector: string;
  text_hint: string;
  viewport_w: number | null;
  viewport_h: number | null;
  dpr: number | null;
  browser: string;
  os: string;
  screenshot_key: string | null;
  thumb_key: string | null;
  proposal_key: string | null;
  capture_notes: Record<string, unknown>;
  kind: string;
  priority: string;
  body: string;
  as_is: string | null;
  to_be: string | null;
  status: Status;
  assignee1: string;
  assignee2: string;
  resolution_note: string;
  created_at: Date;
  updated_at: Date;
  updated_by: string;
  resolved_at: Date | null;
  comment_count: number;
}

const listQuery = z.object({
  status: z.string().optional(),
  page: z.string().optional(),
  assignee: z.string().optional(),
  q: z.string().max(100).optional(),
  round: z.coerce.number().int().positive().optional(),
  kind: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

const patchSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  kind: z.enum(KINDS).optional(),
  assignee1: z.string().trim().max(40).optional(),
  assignee2: z.string().trim().max(40).optional(),
  resolutionNote: z.string().max(2000).optional(),
});

function requestView(ctx: AppContext, r: ReqRow, detail: boolean) {
  const cfg = ctx.config;
  const thumbUrl = r.thumb_key ? signedUrl(cfg.publicUrl, cfg.authSecret, r.thumb_key, cfg.fileUrlTtlShort) : null;
  const base = {
    id: r.id,
    no: r.no,
    roundNo: r.round_no,
    kind: r.kind,
    priority: r.priority,
    status: r.status,
    body: r.body,
    asIs: r.as_is,
    toBe: r.to_be,
    pageUrl: normalizePageUrl(r.page_url),
    pageTitle: r.page_title,
    browser: r.browser,
    os: r.os,
    viewportW: r.viewport_w,
    viewportH: r.viewport_h,
    reviewerName: r.reviewer_name,
    assignee1: r.assignee1,
    assignee2: r.assignee2,
    resolutionNote: r.resolution_note,
    captureNotes: r.capture_notes,
    thumbUrl,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    commentCount: r.comment_count,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
  if (!detail) return base;
  return {
    ...base,
    selector: r.selector,
    textHint: r.text_hint,
    dpr: r.dpr,
    screenshotUrl: r.screenshot_key ? signedUrl(cfg.publicUrl, cfg.authSecret, r.screenshot_key, cfg.fileUrlTtlShort) : null,
    proposalUrl: r.proposal_key ? signedUrl(cfg.publicUrl, cfg.authSecret, r.proposal_key, cfg.fileUrlTtlShort) : null,
  };
}

const SELECT = (ctx: AppContext) => ctx.sql`
  r.id, r.site_id, r.no, ro.no as round_no, r.reviewer_name, r.page_url, r.page_title, r.selector, r.text_hint,
  r.viewport_w, r.viewport_h, r.dpr, r.browser, r.os,
  r.screenshot_key, r.thumb_key, r.proposal_key, r.capture_notes, r.kind, r.priority, r.body, r.as_is, r.to_be, r.status,
  r.assignee1, r.assignee2, r.resolution_note, r.created_at, r.updated_at, r.updated_by, r.resolved_at,
  (select count(*)::int from comments c where c.request_id = r.id and c.author_type <> 'system') as comment_count`;

type Filters = z.infer<typeof listQuery>;

function whereClause(ctx: AppContext, siteId: string, f: Filters) {
  const sql = ctx.sql;
  const conds = [sql`r.site_id = ${siteId}`];
  const statuses = (f.status ?? '').split(',').filter((s) => (STATUSES as readonly string[]).includes(s));
  if (statuses.length) conds.push(sql`r.status in ${sql(statuses)}`);
  if (f.page) conds.push(sql`r.page_url = ${normalizePageUrl(f.page)}`);
  if (f.assignee) conds.push(sql`(r.assignee1 = ${f.assignee} or r.assignee2 = ${f.assignee})`);
  if (f.round) conds.push(sql`ro.no = ${f.round}`);
  const kinds = (f.kind ?? '').split(',').filter((s) => (KINDS as readonly string[]).includes(s));
  if (kinds.length) conds.push(sql`r.kind in ${sql(kinds)}`);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    conds.push(sql`(r.body ilike ${like} or r.reviewer_name ilike ${like} or r.page_url ilike ${like} or r.resolution_note ilike ${like})`);
  }
  return conds.reduce((a, b) => sql`${a} and ${b}`);
}

async function loadRequest(ctx: AppContext, workspaceId: string, id: string): Promise<ReqRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpError(404, 'not_found', '요청을 찾을 수 없습니다');
  const rows = await ctx.sql<ReqRow[]>`
    select ${SELECT(ctx)} from requests r
    join rounds ro on ro.id = r.round_id
    join sites s on s.id = r.site_id
    where r.id = ${id} and s.workspace_id = ${workspaceId}`;
  const r = rows[0];
  if (!r) throw httpError(404, 'not_found', '요청을 찾을 수 없습니다');
  return r;
}

export function requestRoutes(ctx: AppContext, events: ReviewEvents) {
  return async (app: FastifyInstance) => {
    // 사이트별 요청 목록 + 필터 선택지
    app.get('/sites/:id/requests', async (req) => {
      const site = await ownedSite(ctx, req.auth!.workspaceId, (req.params as { id: string }).id);
      const f = listQuery.parse(req.query);
      const where = whereClause(ctx, site.id, f);
      const rows = await ctx.sql<ReqRow[]>`
        select ${SELECT(ctx)} from requests r join rounds ro on ro.id = r.round_id
        where ${where} order by r.no desc limit ${f.limit} offset ${f.offset}`;
      const total = (await ctx.sql<{ total: number }[]>`select count(*)::int as total from requests r join rounds ro on ro.id = r.round_id where ${where}`)[0]?.total ?? 0;

      const counts = await ctx.sql<{ status: string; n: number }[]>`select status, count(*)::int as n from requests where site_id = ${site.id} group by status`;
      const pages = await ctx.sql<{ page_url: string; n: number }[]>`select page_url, count(*)::int as n from requests where site_id = ${site.id} group by page_url order by n desc limit 100`;
      const assignees = await ctx.sql<{ name: string }[]>`
        select distinct name from (select assignee1 as name from requests where site_id = ${site.id} union select assignee2 from requests where site_id = ${site.id}) t where name <> '' order by name`;
      const rounds = await ctx.sql<{ no: number; status: string }[]>`select no, status from rounds where site_id = ${site.id} order by no`;

      return {
        requests: rows.map((r) => requestView(ctx, r, false)),
        total,
        counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        pages: pages.map((p) => ({ url: normalizePageUrl(p.page_url), count: p.n })),
        assignees: assignees.map((a) => a.name),
        rounds,
      };
    });

    const commentsOf = (requestId: string) => loadComments(ctx.sql, requestId);

    app.get('/requests/:id', async (req) => {
      const r = await loadRequest(ctx, req.auth!.workspaceId, (req.params as { id: string }).id);
      return { request: { ...requestView(ctx, r, true), ...await commentsOf(r.id) } };
    });

    app.get('/requests/:id/comments', async (req) => {
      const r = await loadRequest(ctx, req.auth!.workspaceId, (req.params as { id: string }).id);
      return loadComments(ctx.sql, r.id, undefined, commentQuery.parse(req.query).before);
    });

    // 담당자(에이전시)도 같은 댓글창에서 함께 이야기한다.
    app.post('/requests/:id/comments', async (req) => {
      const r = await loadRequest(ctx, req.auth!.workspaceId, (req.params as { id: string }).id);
      const b = commentBody.parse(req.body);
      const inserted = await ctx.sql.begin(async (tx) => {
        const locked = await tx`select id from requests where id = ${r.id} for update`;
        if (!locked.length) throw httpError(404, 'not_found', '요청을 찾을 수 없어요');
        const inserted = await tx`insert into comments (request_id, author_type, author_id, author_name, body, mutation_id) values (${r.id}, 'agency', ${req.auth!.userId}, ${req.auth!.name}, ${b.body}, ${b.mutationId ?? null}) on conflict (request_id, author_type, author_id, mutation_id) do nothing returning id`;
        if (inserted.length) await tx`update requests set updated_at = clock_timestamp() where id = ${r.id}`;
        return inserted.length > 0;
      });
      if (inserted) events.publish(r.site_id);
      const fresh = await loadRequest(ctx, req.auth!.workspaceId, r.id);
      return { request: { ...requestView(ctx, fresh, true), ...await commentsOf(r.id) } };
    });

    app.patch('/requests/:id', async (req) => {
      const owned = await loadRequest(ctx, req.auth!.workspaceId, (req.params as { id: string }).id);
      const b = patchSchema.parse(req.body);
      await ctx.sql.begin(async (tx) => {
        const [cur] = await tx<ReqRow[]>`select * from requests where id = ${owned.id} for update`;
        if (!cur) throw httpError(404, 'not_found', '요청을 찾을 수 없습니다');
        const status = b.status ?? cur.status;
        // 상태 비교도 잠금 안에서 한다. 두 사람이 동시에 해결해도 기록은 한 번만 남는다.
        let resolvedAt: Date | null = cur.resolved_at;
        if (b.status && b.status !== cur.status) {
          if (b.status === '완료') resolvedAt = new Date();
          else if (['접수', '진행', '재발생'].includes(b.status)) resolvedAt = null;
        }
        await tx`
          update requests set
            status = ${status},
            priority = ${b.priority ?? cur.priority},
            kind = ${b.kind ?? cur.kind},
            assignee1 = ${b.assignee1 ?? cur.assignee1},
            assignee2 = ${b.assignee2 ?? cur.assignee2},
            resolution_note = ${b.resolutionNote ?? cur.resolution_note},
            resolved_at = ${resolvedAt},
            updated_at = clock_timestamp(),
            updated_by = coalesce(nullif(${b.status && b.status !== cur.status ? `${req.auth!.name}(담당자)` : ''}, ''), updated_by)
          where id = ${cur.id}`;
        if (b.status && b.status !== cur.status) {
          await tx`insert into comments (request_id, author_type, author_id, author_name, body, created_at) values (${cur.id}, 'system', ${req.auth!.userId}, ${`${req.auth!.name}(담당자)`}, ${statusSentence(b.status)}, clock_timestamp())`;
        }
      });
      events.publish(owned.site_id);
      const r = await loadRequest(ctx, req.auth!.workspaceId, owned.id);
      return { request: { ...requestView(ctx, r, true), ...await commentsOf(r.id) } };
    });

    app.delete('/requests/:id', async (req) => {
      const r = await loadRequest(ctx, req.auth!.workspaceId, (req.params as { id: string }).id);
      await ctx.sql`delete from requests where id = ${r.id}`;
      events.publish(r.site_id);
      if (r.screenshot_key) await ctx.storage.delete(r.screenshot_key).catch(() => {});
      if (r.thumb_key) await ctx.storage.delete(r.thumb_key).catch(() => {});
      if (r.proposal_key) await ctx.storage.delete(r.proposal_key).catch(() => {});
      return { ok: true };
    });

    // 엑셀 내보내기 (목록과 같은 필터)
    app.get('/sites/:id/export.xlsx', async (req, reply) => {
      const site = await ownedSite(ctx, req.auth!.workspaceId, (req.params as { id: string }).id);
      const locale = normalizeLocale((req.query as { lang?: unknown }).lang);
      const f = listQuery.parse({ ...(req.query as object), limit: 500 });
      const where = whereClause(ctx, site.id, f);
      const rows = await ctx.sql<ReqRow[]>`
        select ${SELECT(ctx)} from requests r join rounds ro on ro.id = r.round_id
        where ${where} order by r.no asc limit 501`;
      if (rows.length > 500) throw httpError(400, 'export_limit', locale === 'en'
        ? 'Export up to 500 requests at a time. Filter by status, page, or search term.'
        : '엑셀은 한 번에 500건까지 받을 수 있어요. 상태·페이지·검색 조건으로 나눠 주세요');
      const cfg = ctx.config;
      const exportRows: ExportRow[] = [];
      for (const r of rows) {
        exportRows.push({
          no: r.no,
          roundNo: r.round_no,
          reviewerName: r.reviewer_name,
          createdAt: r.created_at,
          kind: r.kind,
          priority: r.priority,
          pageUrl: normalizePageUrl(r.page_url),
          pageTitle: r.page_title,
          browser: r.browser,
          os: r.os,
          viewportW: r.viewport_w,
          viewportH: r.viewport_h,
          body: r.body,
          asIs: r.as_is,
          toBe: r.to_be,
          assignee1: r.assignee1,
          assignee2: r.assignee2,
          status: r.status,
          resolvedAt: r.resolved_at,
          resolutionNote: r.resolution_note,
          thumb: r.thumb_key ? await ctx.storage.read(r.thumb_key) : null,
          // 엑셀은 며칠 뒤에도 열리므로 원본 링크는 긴 만료(기본 30일)의 서명 주소다.
          originalUrl: r.screenshot_key ? signedUrl(cfg.publicUrl, cfg.authSecret, r.screenshot_key, cfg.fileUrlTtlLong) : null,
        });
      }
      const buf = await buildWorkbook({
        rows: exportRows,
        locale,
        footerText: `${locale === 'en' ? 'Made with Geomsupin' : '이 요청서는 검수핀으로 만들었습니다'} · ${cfg.publicUrl}`,
      });
      const d = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replaceAll('-', '');
      const filename = `${locale === 'en' ? 'Review_Requests' : '수정요청서'}_${site.name}_${d}.xlsx`;
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', contentDisposition(filename))
        .header('Cache-Control', 'no-store');
      return reply.send(buf);
    });
  };
}
