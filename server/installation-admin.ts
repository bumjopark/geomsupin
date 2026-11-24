import { randomUUID } from 'node:crypto';
import type { Sql } from './db.ts';
import { randomToken, sha256 } from './security.ts';

export async function issueAdminLink(sql: Sql, workspaceId?: string, name = '검수핀') {
  const token = randomToken();
  return sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(7302028)`;
    const workspaces = await tx<{ id: string; name: string }[]>`select id, name from workspaces order by created_at, id`;
    let workspace = workspaceId ? workspaces.find(w => w.id === workspaceId) : workspaces[0];
    if (workspaceId && !workspace) throw new Error('지정한 작업공간을 찾을 수 없습니다');
    if (!workspaceId && workspaces.length > 1) throw new Error('작업공간이 여러 개입니다. --list로 확인하고 --workspace <ID>를 지정하세요');
    if (!workspace) {
      [workspace] = await tx<{ id: string; name: string }[]>`insert into workspaces (name) values (${name}) returning id, name`;
      // 기존 관리자 활동과 동일한 작성자 FK를 사용한다.
      const actor = randomUUID();
      await tx`insert into users (id, name) values (${actor}, '설치 관리자')`;
      await tx`insert into members (workspace_id, user_id, role) values (${workspace!.id}, ${actor}, 'owner')`;
    }
    const [owner] = await tx<{ user_id: string }[]>`
      select user_id from members where workspace_id = ${workspace!.id} and role = 'owner' order by created_at, user_id limit 1`;
    if (!owner) throw new Error('작업공간에 소유자 기록이 없습니다');
    await tx`insert into installation_admin_links (workspace_id, actor_id, token_hash, expires_at)
      values (${workspace!.id}, ${owner.user_id}, ${sha256(token)}, now() + interval '15 minutes')
      on conflict (workspace_id) do update set actor_id = excluded.actor_id, token_hash = excluded.token_hash, expires_at = excluded.expires_at`;
    await tx`delete from installation_admin_sessions where workspace_id = ${workspace!.id}`;
    return { token, workspace: workspace! };
  });
}
