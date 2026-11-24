import { z } from 'zod';
import type { Sql } from './db.ts';
import type { Status } from '../shared/constants.ts';

export const statusSentence = (s: Status) => ({ 접수: '접수 상태로 되돌렸어요', 진행: '진행 중으로 바꿨어요', 완료: '완료로 표시했어요 ✅', 재발생: '다시 열었어요 (재발생)', 보류: '보류로 바꿨어요' } as const)[s];

export const commentQuery = z.object({ before: z.string().uuid().optional() });
export const mutationId = z.string().regex(/^[a-f0-9]{32}$/).optional();
export const commentBody = z.object({ body: z.string().trim().min(1, '댓글을 입력해 주세요').max(1000), mutationId });

/** 최신 대화부터 읽는다. 커서는 DB의 원래 시각·ID를 사용해 마이크로초 정밀도를 보존한다. */
export async function loadComments(sql: Sql, requestId: string, reviewerId?: string, before?: string) {
  const rows = await sql<{ id: string; author_type: string; author_id: string | null; author_name: string; body: string; created_at: Date }[]>`
    select id, author_type, author_id, author_name, body, created_at from comments
    where request_id = ${requestId}
      ${before ? sql`and (created_at, id) < (select created_at, id from comments where id = ${before} and request_id = ${requestId})` : sql``}
    order by created_at desc, id desc limit 301`;
  const more = rows.length > 300;
  const comments = rows.slice(0, 300).reverse().map((c) => ({
    id: c.id, type: c.author_type, author: c.author_name || '손님', body: c.body, createdAt: c.created_at,
    mine: c.author_type === 'reviewer' && c.author_id === reviewerId,
  }));
  return { comments, commentsBefore: more ? comments[0]!.id : null };
}
