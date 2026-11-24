// 스테이징 주소는 HTTP(S) 주소와 경로만 받으며 주소에 계정 정보를 넣을 수 없다.
// 표준 형태(퍼센트 인코딩 뒤)의 길이 기준이다. 한글은 글자당 9자로 늘어나므로 입력한 길이만 재면 저장 뒤 읽을 때 거절된다.
export const TARGET_URL_MAX = 2000;

type TargetUrlResult = { ok: true; url: string } | { ok: false; message: string };

/** 입력한 주소를 검사해 표준 형태로 돌려준다. 빈 값은 "지움"으로 ok('') 이다. */
export function parseTargetUrl(raw: string): TargetUrlResult {
  const text = raw.trim();
  if (!text) return { ok: true, url: '' };
  const tooLong = { ok: false as const, message: `주소가 너무 길어요. 줄여서 입력해 주세요 (한글이 들어가면 실제 길이는 더 길어져요)` };
  if (text.length > TARGET_URL_MAX) return tooLong;
  const hint = 'http:// 또는 https:// 로 시작하는 주소를 입력해 주세요 (예: http://staging.example.com)';
  if (/\s/.test(text)) return { ok: false, message: hint };
  let u: URL;
  try { u = new URL(text); } catch { return { ok: false, message: hint }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, message: hint };
  if (!u.hostname) return { ok: false, message: hint };
  if (u.username || u.password) return { ok: false, message: '주소에 아이디·비밀번호를 넣을 수 없어요. 초대받은 모두에게 보이는 주소예요' };
  if (u.href.length > TARGET_URL_MAX) return tooLong; // 저장·조회에서 쓰는 표준 형태로 다시 잰다
  return { ok: true, url: u.href };
}

/** 저장돼 있던 값을 화면·링크에 내보내기 전에 한 번 더 거른다. 안전하지 않으면 ''(없음). */
export function readTargetUrl(raw: string | null | undefined): string {
  const r = parseTargetUrl(raw ?? '');
  return r.ok ? r.url : '';
}

/** 화면에 보여 줄 짧은 이름: 호스트와 경로(한글 경로는 읽히게 풀고, 길면 줄인다). 전체 주소는 링크가 가진다. */
export function targetUrlLabel(url: string, max = 80): string {
  let label = url;
  try {
    const u = new URL(url);
    let path = u.pathname === '/' ? '' : u.pathname;
    try { path = decodeURI(path); } catch { /* 풀 수 없으면 그대로 */ }
    label = u.host + path;
  } catch { /* 주소가 아니면 그대로 */ }
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}
