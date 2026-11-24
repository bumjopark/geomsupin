const COLORS = ['#ff7a59', '#f5a524', '#3ccf91', '#35b6e6', '#7c8cff', '#c77dff', '#ff6f9c', '#7cc242'];

/** 위젯과 관리 화면에서 같은 이름은 같은 글자·색으로 표시한다. */
export function avatarAppearance(name: string) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const initial = [...name.replace(/\(담당자\)$/, '')].find((ch) => /[\p{L}\p{N}]/u.test(ch)) ?? '?';
  return { initial: initial.toUpperCase(), color: COLORS[hash % COLORS.length]! };
}
