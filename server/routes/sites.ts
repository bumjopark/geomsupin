import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.ts';
import { randomToken } from '../security.ts';
import { httpError } from '../util.ts';
import { OPEN_STATUSES } from '../../shared/constants.ts';
import { TARGET_URL_MAX, parseTargetUrl, readTargetUrl, reviewProtocolIssue } from '../../shared/target-url.ts';
import type { ReviewEvents } from '../review-events.ts';

interface SiteRow {
  id: string;
  workspace_id: string;
  name: string;
  widget_key: string;
  preview_url: string;
  preview_id: string | null;
  status: 'active' | 'done';
  created_at: Date;
}
interface LinkRow {
  id: string;
  token: string;
  label: string;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

const previewUrlSchema = z.string().max(TARGET_URL_MAX * 2, '주소가 너무 길어요').transform((value, ctx) => {
  const r = parseTargetUrl(value);
  if (!r.ok) { ctx.addIssue({ code: 'custom', message: r.message }); return z.NEVER; }
  return r.url;
});
const createSchema = z.object({
  name: z.string().trim().min(1, '프로젝트 이름을 입력해 주세요').max(60),
});
const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  status: z.enum(['active', 'done']).optional(),
  previewUrl: previewUrlSchema.optional(),
});
const linkCreateSchema = z.object({
  label: z.string().trim().max(60).default(''),
  expiresAt: z.string().datetime().optional(),
});
const linkPatchSchema = z.object({
  label: z.string().trim().max(60).optional(),
  revoked: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

async function createSiteRecord(ctx: AppContext, workspaceId: string, input: { name: string }) {
  const key = `gpk_${randomToken(18)}`;
  return ctx.sql.begin(async (tx) => {
    const [site] = await tx<SiteRow[]>`insert into sites (workspace_id, name, widget_key) values (${workspaceId}, ${input.name}, ${key}) returning *`;
    await tx`insert into rounds (site_id, no) values (${site!.id}, 1)`;
    await tx`insert into review_links (site_id, token, label) values (${site!.id}, ${randomToken(24)}, '기본 링크')`;
    return site!;
  });
}

async function ownedSite(ctx: AppContext, workspaceId: string, id: string): Promise<SiteRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpError(404, 'not_found', '프로젝트를 찾을 수 없습니다');
  const rows = await ctx.sql<SiteRow[]>`select * from sites where id = ${id} and workspace_id = ${workspaceId}`;
  const s = rows[0];
  if (!s) throw httpError(404, 'not_found', '프로젝트를 찾을 수 없습니다');
  return s;
}
export { ownedSite };

export function sitePreview(config: AppContext['config'], row: { preview_url: string; preview_id: string | null }) {
  const url = readTargetUrl(row.preview_url);
  if (!url || !row.preview_id || reviewTargetIssue(config, url)) return undefined;
  return { url, id: row.preview_id };
}

function reviewTargetIssue(config: AppContext['config'], url: string): string | undefined {
  const target = new URL(url);
  const app = new URL(config.publicOrigin);
  const protocolIssue = reviewProtocolIssue(app.protocol, target.protocol);
  if (protocolIssue) return protocolIssue;
  // 이 출처는 CSP frame-src의 단일 호스트 소스로도 쓰인다.
  const validHost = /^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])$/i.test(target.hostname);
  if (!validHost || target.origin === app.origin || config.allowedHosts.has(target.host)) {
    return '검수핀과 다른 출처의 사이트 주소를 입력해 주세요.';
  }
}

function publicSite(s: SiteRow, ctx: AppContext) {
  return { id: s.id, name: s.name, status: s.status, widgetKey: s.widget_key, preview: sitePreview(ctx.config, s), createdAt: s.created_at };
}

function publicLink(l: LinkRow, ctx: AppContext) {
  const expired = l.expires_at ? l.expires_at.getTime() < Date.now() : false;
  return {
    id: l.id,
    label: l.label,
    // 같이 일하는 사람에게 보내는 검수 초대 주소
    shareUrl: `${ctx.config.publicUrl}/r/${l.token}`,
    expiresAt: l.expires_at,
    revokedAt: l.revoked_at,
    active: !l.revoked_at && !expired,
    createdAt: l.created_at,
  };
}

async function siteDetail(ctx: AppContext, s: SiteRow) {
  const links = await ctx.sql<LinkRow[]>`select id, token, label, expires_at, revoked_at, created_at from review_links where site_id = ${s.id} order by created_at asc`;
  return { ...publicSite(s, ctx), links: links.map((l) => publicLink(l, ctx)) };
}

export function siteRoutes(ctx: AppContext, events: ReviewEvents) {
  return async (app: FastifyInstance) => {
    app.get('/', async (req) => {
      const rows = await ctx.sql<(SiteRow & { open_count: number; total_count: number; round_no: number })[]>`
        select s.*,
          (select count(*)::int from requests r where r.site_id = s.id and r.status in ${ctx.sql(OPEN_STATUSES as unknown as string[])}) as open_count,
          (select count(*)::int from requests r where r.site_id = s.id) as total_count,
          coalesce((select max(no) from rounds ro where ro.site_id = s.id and ro.status = 'open'), 1) as round_no
        from sites s where s.workspace_id = ${req.auth!.workspaceId}
        order by s.created_at desc`;
      return { sites: rows.map((r) => ({ ...publicSite(r, ctx), openCount: r.open_count, totalCount: r.total_count, roundNo: r.round_no })) };
    });

    app.post('/', async (req) => {
      const body = createSchema.parse(req.body);
      const s = await createSiteRecord(ctx, req.auth!.workspaceId, body);
      return { site: await siteDetail(ctx, s) };
    });

    app.get('/:id', async (req) => {
      const s = await ownedSite(ctx, req.auth!.workspaceId, (req.params as { id: string }).id);
      return { site: await siteDetail(ctx, s) };
    });

    app.patch('/:id', async (req) => {
      const id = (req.params as { id: string }).id;
      const s = await ownedSite(ctx, req.auth!.workspaceId, id);
      const b = patchSchema.parse(req.body);
      const targetIssue = b.previewUrl ? reviewTargetIssue(ctx.config, b.previewUrl) : undefined;
      if (targetIssue) throw httpError(400, 'invalid_preview_url', targetIssue);
      const previewUrl = b.previewUrl ?? null;
      const [u] = await ctx.sql<SiteRow[]>`
        update sites set name = coalesce(${b.name ?? null}, name), status = coalesce(${b.status ?? null}, status),
          preview_id = case when ${previewUrl}::text is null or preview_url = ${previewUrl} then preview_id when ${previewUrl} = '' then null else ${randomUUID()}::uuid end,
          preview_url = coalesce(${previewUrl}, preview_url)
        where id = ${s.id} returning *`;
      if (b.status !== undefined || b.previewUrl !== undefined) events.publish(s.id);
      return { site: await siteDetail(ctx, u!) };
    });

    app.delete('/:id', async (req) => {
      const s = await ownedSite(ctx, req.auth!.workspaceId, (req.params as { id: string }).id);
      const files = await ctx.sql.begin(async tx => {
        // 새 핀 번호를 발급하는 트랜잭션과 같은 순서로 잠근 뒤 파일 목록을 확정한다.
        await tx`select id from sites where id = ${s.id} for update`;
        const rows = await tx<{ screenshot_key: string | null; thumb_key: string | null; proposal_key: string | null }[]>`select screenshot_key, thumb_key, proposal_key from requests where site_id = ${s.id}`;
        await tx`delete from sites where id = ${s.id}`;
        return rows;
      });
      events.publish(s.id);
      for (const f of files) {
        if (f.screenshot_key) await ctx.storage.delete(f.screenshot_key).catch(() => {});
        if (f.thumb_key) await ctx.storage.delete(f.thumb_key).catch(() => {});
        if (f.proposal_key) await ctx.storage.delete(f.proposal_key).catch(() => {});
      }
      return { ok: true };
    });

    // ── 검수 링크 ──
    app.post('/:id/links', async (req) => {
      const s = await ownedSite(ctx, req.auth!.workspaceId, (req.params as { id: string }).id);
      const b = linkCreateSchema.parse(req.body);
      await ctx.sql`insert into review_links (site_id, token, label, expires_at) values (${s.id}, ${randomToken(24)}, ${b.label}, ${b.expiresAt ?? null})`;
      return { site: await siteDetail(ctx, s) };
    });

    app.patch('/:id/links/:linkId', async (req) => {
      const p = req.params as { id: string; linkId: string };
      const s = await ownedSite(ctx, req.auth!.workspaceId, p.id);
      const b = linkPatchSchema.parse(req.body);
      const cur = (await ctx.sql<LinkRow[]>`select * from review_links where id = ${p.linkId} and site_id = ${s.id}`)[0];
      if (!cur) throw httpError(404, 'not_found', '링크를 찾을 수 없습니다');
      const revokedAt = b.revoked === undefined ? cur.revoked_at : b.revoked ? cur.revoked_at ?? new Date() : null;
      const expires = b.expiresAt === undefined ? cur.expires_at : b.expiresAt === null ? null : new Date(b.expiresAt);
      await ctx.sql`update review_links set label = ${b.label ?? cur.label}, revoked_at = ${revokedAt}, expires_at = ${expires} where id = ${cur.id}`;
      if (b.revoked !== undefined || b.expiresAt !== undefined) events.publish(s.id);
      return { site: await siteDetail(ctx, s) };
    });
  };
}
