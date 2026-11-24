// 초대 주소는 연결된 미리보기를 연다.
// 이 화면이 부르는 공개 API 가 아래 GET /api/share/:token 이다. 로그인도 비밀번호도 필요 없다 — 링크를 아는 사람이 곧 함께 일하는 사람이다.
// 닫힌 링크가 계속 열리지 않도록 응답은 절대 캐시하지 않는다(Cloudflare 가 다른 캐시 지시를 늘려 버린다).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { clientIp, httpError } from '../util.ts';
import { sitePreview } from './sites.ts';

type ShareState = 'ok' | 'revoked' | 'expired' | 'done';
const TOKEN = /^[A-Za-z0-9_-]{16,80}$/;

export async function loadShare(ctx: AppContext, token: string) {
  if (!TOKEN.test(token)) return null;
  const [r] = await ctx.sql<{
    name: string; status: string; widget_key: string;
    preview_url: string; preview_id: string | null; revoked_at: Date | null; expires_at: Date | null;
  }[]>`
    select s.name, s.status, s.widget_key, s.preview_url, s.preview_id, l.revoked_at, l.expires_at
    from review_links l join sites s on s.id = l.site_id where l.token = ${token}`;
  if (!r) return null;
  const state: ShareState = r.revoked_at ? 'revoked' : r.expires_at && r.expires_at.getTime() < Date.now() ? 'expired' : r.status === 'done' ? 'done' : 'ok';
  if (state !== 'ok') return { state, project: r.name };
  const preview = sitePreview(ctx.config, r);
  if (!preview) return { state: 'unconnected' as const, project: r.name };
  return { state, project: r.name, widgetKey: r.widget_key, base: ctx.config.publicUrl, preview };
}

export function shareRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get('/api/share/:token', {
      // 같은 공용 IP 의 직원들이 초대 링크를 한꺼번에 열어도 막히지 않게 넉넉히 둔다
      config: { rateLimit: { max: 600, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => `share|${clientIp(r)}` } },
    }, async (req, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      const { token } = req.params as { token: string };
      const share = await loadShare(ctx, token);
      if (!share) throw httpError(404, 'not_found', '링크를 찾을 수 없어요. 주소가 잘리지 않았는지 확인해 주세요');
      return share;
    });
  };
}
