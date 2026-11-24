// 서버·관리 화면·위젯이 함께 쓰는 값.
export const STATUSES = ['접수', '진행', '완료', '재발생', '보류'] as const;
export type Status = (typeof STATUSES)[number];
export const OPEN_STATUSES: readonly Status[] = ['접수', '진행', '재발생'];

export const KINDS = ['수정', '추가', '문의', '버그'] as const;
export type Kind = (typeof KINDS)[number];

export const PRIORITIES = ['긴급', '높음', '보통', '낮음'] as const;

/** 이전 포맷의 검수 토큰을 페이지 주소에 다시 기록하지 않는다. */
const REVIEW_PARAM = 'gp_review';

/** 페이지 주소를 요청 비교용으로 정규화한다: 검수 토큰과 해시(SPA 해시 라우트 제외)를 뗀다. */
export function normalizePageUrl(input: string): string {
  try {
    const u = new URL(input);
    u.searchParams.delete(REVIEW_PARAM);
    const keepHash = /^#!?\//.test(u.hash);
    return u.origin + u.pathname + (u.search || '') + (keepHash ? u.hash : '');
  } catch {
    return input;
  }
}
