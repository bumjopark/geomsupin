import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext, AuthCtx } from '../context.ts';
import { randomToken, sha256 } from '../security.ts';
import { clientIp, httpError } from '../util.ts';

const COOKIE = 'gp_install_session';
const SESSION_DAYS = 30;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

async function loadAuth(ctx: AppContext, req: FastifyRequest): Promise<AuthCtx | null> {
  const token = req.cookies[COOKIE];
  if (!token || !TOKEN.test(token)) return null;
  const [row] = await ctx.sql<{ user_id: string; name: string; workspace_id: string; workspace_name: string }[]>`
    select u.id as user_id, u.name, w.id as workspace_id, w.name as workspace_name
    from installation_admin_sessions s
    join members m on m.workspace_id = s.workspace_id and m.user_id = s.actor_id and m.role = 'owner'
    join users u on u.id = s.actor_id
    join workspaces w on w.id = s.workspace_id
    where s.token_hash = ${sha256(token)} and s.expires_at > now()`;
  return row ? { userId: row.user_id, name: row.name, workspaceId: row.workspace_id, workspaceName: row.workspace_name } : null;
}

export function requireAuth(ctx: AppContext) {
  return async (req: FastifyRequest) => {
    const auth = await loadAuth(ctx, req);
    if (!auth) throw httpError(401, 'unauthorized', '설치자의 관리 링크가 필요합니다');
    req.auth = auth;
  };
}

export function managementRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.post('/exchange', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => clientIp(req) } },
    }, async (req, reply) => {
      if (req.headers.origin !== ctx.config.publicOrigin) throw httpError(403, 'invalid_origin', '검수핀 주소에서 관리 링크를 열어 주세요');
      const { token } = z.object({ token: z.string().regex(TOKEN) }).parse(req.body);
      const session = randomToken();
      const exchanged = await ctx.sql.begin(async tx => {
        const [link] = await tx<{ workspace_id: string; actor_id: string }[]>`
          update installation_admin_links l set token_hash = null
          where l.token_hash = ${sha256(token)} and l.expires_at > now()
            and exists (select 1 from members m where m.workspace_id = l.workspace_id and m.user_id = l.actor_id and m.role = 'owner')
          returning l.workspace_id, l.actor_id`;
        if (!link) return false;
        await tx`delete from installation_admin_sessions where expires_at <= now() or token_hash = ${sha256(req.cookies[COOKIE] ?? '')}`;
        await tx`insert into installation_admin_sessions (token_hash, workspace_id, actor_id, expires_at)
          values (${sha256(session)}, ${link.workspace_id}, ${link.actor_id}, now() + ${SESSION_DAYS + ' days'}::interval)`;
        return true;
      });
      if (!exchanged) throw httpError(401, 'invalid_management_link', '관리 링크가 만료됐거나 이미 사용됐어요');
      reply.setCookie(COOKIE, session, { httpOnly: true, secure: ctx.config.secureCookies, sameSite: 'strict', path: '/', maxAge: SESSION_DAYS * 86400 });
      return { ok: true };
    });

    app.get('/session', async (req) => {
      const auth = await loadAuth(ctx, req);
      return { user: auth ? { id: auth.userId, name: auth.name, workspace: { id: auth.workspaceId, name: auth.workspaceName } } : null };
    });

    app.delete('/session', async (req, reply) => {
      const token = req.cookies[COOKIE];
      if (token && TOKEN.test(token)) await ctx.sql`delete from installation_admin_sessions where token_hash = ${sha256(token)}`;
      reply.clearCookie(COOKIE, { path: '/', secure: ctx.config.secureCookies, sameSite: 'strict', httpOnly: true });
      return { ok: true };
    });
  };
}
