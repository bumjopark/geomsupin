// 서버·관리 화면·위젯이 함께 쓰는 값.
export const STATUSES = ['접수', '진행', '완료', '재발생', '보류'] as const;
export type Status = (typeof STATUSES)[number];
export const OPEN_STATUSES: readonly Status[] = ['접수', '진행', '재발생'];

export const KINDS = ['수정', '추가', '문의', '버그'] as const;
export type Kind = (typeof KINDS)[number];

export const PRIORITIES = ['긴급', '높음', '보통', '낮음'] as const;

const SENSITIVE_QUERY = /token$|^token(?:value|id|key|hash)$|password|passwd|passphrase|secret|credential|signature|^oauth|^saml|^xamz|^xgoog|^(?:gpreview|code|authcode|authorizationcode|auth|authorization|bearer|jwt|session|sessionid|sessionkey|sessionstate|sid|csrf|xsrf|apikey|accesskey|authkey|googleaccessid|sig|keypairid|policy|codeverifier)$/i;

function safeQuery(query: string): string {
  const params = new URLSearchParams(query);
  const keys = Array.from(params.keys(), key => ({ key, normalized: key.replace(/\[\d*\]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase() }));
  const authFlow = keys.some(({ normalized }) => /^(?:code|authcode|authorizationcode|accesstoken|idtoken|refreshtoken|oauth|saml)/.test(normalized));
  for (const { key, normalized } of keys) {
    if (!SENSITIVE_QUERY.test(normalized) && !(authFlow && normalized === 'state')) continue;
    params.delete(key);
  }
  return params.toString();
}

export function hasUrlCredentials(url: URL): boolean {
  return Boolean(url.username || url.password) || url.searchParams.toString() !== safeQuery(url.search.slice(1));
}

/** Keep ordinary route queries for pin matching while dropping credential parameters. */
export function normalizePageUrl(input: string): string {
  try {
    const u = new URL(input);
    const search = safeQuery(u.search.slice(1));
    let hash = /^#!?\//.test(u.hash) ? u.hash : '';
    const anchor = hash.indexOf('#', 1);
    if (anchor !== -1) hash = hash.slice(0, anchor);
    const question = hash.indexOf('?');
    if (question !== -1) {
      const query = safeQuery(hash.slice(question + 1));
      hash = hash.slice(0, question) + (query ? `?${query}` : '');
    }
    return u.origin + u.pathname + (search ? `?${search}` : '') + hash;
  } catch {
    return input;
  }
}
