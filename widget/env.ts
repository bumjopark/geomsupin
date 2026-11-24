// 위젯이 쓰는 순수 함수들: 브라우저·OS 감지, 요소 선택자, 텍스트 힌트.
import { touchesReviewMask } from './privacy.ts';

interface EnvInfo {
  browser: string;
  os: string;
}

interface UAData {
  brands?: { brand: string; version: string }[];
  platform?: string;
}

const major = (v: string | undefined) => (v ? v.split('.')[0] : '');

/** 브라우저 이름·버전과 OS 를 사람이 읽을 수 있게. 인앱 브라우저(카카오톡·네이버)를 따로 구분한다. */
export function detectEnv(ua = navigator.userAgent, uaData: UAData | undefined = (navigator as unknown as { userAgentData?: UAData }).userAgentData): EnvInfo {
  let browser = '';
  const m = (re: RegExp) => re.exec(ua);
  let r: RegExpExecArray | null;
  if ((r = m(/KAKAOTALK\/([\d.]+)/i))) browser = `카카오톡 인앱 ${major(r[1])}`;
  else if (/NAVER\(inapp/i.test(ua)) browser = '네이버 인앱';
  else if ((r = m(/Whale\/([\d.]+)/))) browser = `Whale ${major(r[1])}`;
  else if ((r = m(/SamsungBrowser\/([\d.]+)/))) browser = `삼성 인터넷 ${major(r[1])}`;
  else if ((r = m(/EdgA?\/([\d.]+)/))) browser = `Edge ${major(r[1])}`;
  else if ((r = m(/OPR\/([\d.]+)/))) browser = `Opera ${major(r[1])}`;
  else if ((r = m(/CriOS\/([\d.]+)/))) browser = `Chrome(iOS) ${major(r[1])}`;
  else if ((r = m(/FxiOS\/([\d.]+)/))) browser = `Firefox(iOS) ${major(r[1])}`;
  else if ((r = m(/Firefox\/([\d.]+)/))) browser = `Firefox ${major(r[1])}`;
  else if ((r = m(/Chrome\/([\d.]+)/))) browser = `Chrome ${major(r[1])}`;
  else if ((r = m(/Version\/([\d.]+).*Safari/))) browser = `Safari ${major(r[1])}`;
  else browser = 'Unknown';
  // userAgentData 가 있으면 브랜드 이름이 더 정확하다(Chrome 계열 UA 는 축소돼 있다)
  const brand = uaData?.brands?.find((b) => !/not.?a.?brand|chromium/i.test(b.brand));
  if (brand && /^Chrome |^Edge /.test(browser) === false && /Chrome/.test(ua) && !/Edg|OPR|Whale|Samsung/.test(ua)) browser = `${brand.brand} ${major(brand.version)}`;

  let os = '';
  if ((r = m(/(?:iPhone|iPad|iPod).*? OS ([\d_]+)/))) os = `iOS ${major(r[1]!.replace(/_/g, '.'))}`;
  else if ((r = m(/Android ([\d.]+)/))) os = `Android ${major(r[1])}`;
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  else os = uaData?.platform || 'Unknown';
  return { browser: browser.slice(0, 60), os: os.slice(0, 60) };
}

/** PC / 태블릿 / 모바일 구분. 요청을 남긴 화면 너비로 분류한다. */
export function deviceClass(width: number): 'mobile' | 'tablet' | 'desktop' {
  return width < 768 ? 'mobile' : width < 1100 ? 'tablet' : 'desktop';
}
export const deviceLabel = { mobile: '모바일', tablet: '태블릿', desktop: 'PC' } as const;

// ─────────────────────────── 선택자 ───────────────────────────

const HASHY = /(?:^|[-_])(?:[a-z0-9]{5,}_[a-z0-9]{4,}|[A-Za-z]+[0-9]{3,}|[0-9a-f]{6,})$|^(?:css|sc|jsx|svelte|astro|_)[-_]?[a-z0-9]{4,}$|[0-9]{4,}/i;

const isStableToken = (t: string) => /^[A-Za-z][\w-]{1,40}$/.test(t) && !HASHY.test(t);
const esc = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1'));

function matchesOnly(sel: string, el: Element, root: ParentNode = document): boolean {
  try {
    const found = root.querySelectorAll(sel);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

function segment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  for (const attr of ['data-testid', 'data-test', 'data-qa']) {
    const value = el.getAttribute(attr);
    if (value && /^[\w:-]{1,60}$/.test(value)) return `${tag}[${attr}="${value}"]`;
  }
  const classes = Array.from(el.classList).filter(isStableToken).slice(0, 2);
  const cls = classes.map((c) => '.' + esc(c)).join('');
  const parent = el.parentElement;
  let nth = '';
  if (parent) {
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (same.length > 1) nth = `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return `${tag}${cls}${nth}`;
}

/** 페이지가 바뀌어도 다시 찾을 수 있는, 짧고 안정적인 CSS 선택자. */
export function buildSelector(el: Element): string {
  if (touchesReviewMask(el)) return positionalSelector(el);
  const root = el.getRootNode();
  if (root instanceof ShadowRoot) return `${buildSelector(root.host)} >>> ${localSelector(el, root)}`;
  return localSelector(el, document);
}

/** 가림 영역에 닿는 선택자에는 페이지가 지은 ID, 클래스, 데이터 값을 담지 않는다. */
function positionalSelector(el: Element, within?: ParentNode): string {
  const parts: string[] = [];
  for (let current: Element | null = el; current;) {
    const parent: ParentNode | null = current.parentNode;
    if (!parent) break;
    parts.unshift(`:nth-child(${Array.from(parent.children).indexOf(current) + 1})`);
    if (parent instanceof ShadowRoot) {
      const local = parts.join(' > ');
      return parent === within ? local : `${positionalSelector(parent.host)} >>> ${local}`;
    }
    if (parent instanceof Document) {
      parts[0] = 'html';
      return parts.join(' > ');
    }
    current = parent instanceof Element ? parent : null;
  }
  return '';
}

function localSelector(el: Element, root: ParentNode): string {
  if (el === document.documentElement) return 'html';
  if (el === document.body) return 'body';
  if (el.id && isStableToken(el.id)) {
    const s = `#${esc(el.id)}`;
    if (matchesOnly(s, el, root)) return s;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (cur !== el && touchesReviewMask(cur)) return positionalSelector(el, root);
    if (cur.id && isStableToken(cur.id) && matchesOnly(`#${esc(cur.id)}`, cur, root)) {
      parts.unshift(`#${esc(cur.id)}`);
      break;
    }
    parts.unshift(segment(cur));
    const candidate = parts.join(' > ');
    // 앞부분이 충분히 유일하면 거기서 멈춘다.
    if (matchesOnly(candidate, el, root)) return candidate;
    cur = cur.parentElement;
  }
  const full = parts.join(' > ');
  return root instanceof ShadowRoot || full.startsWith('#') ? full : `body > ${full}`;
}

/** 요소를 알아보는 데 도움이 되는 짧은 글자 */
export function textHint(el: Element): string {
  if (touchesReviewMask(el)) return '';
  const h = el as HTMLElement;
  const raw = (h.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim();
  return raw.replace(/\s+/g, ' ').slice(0, 60);
}

export function findBySelector(selector: string): Element | null {
  if (!selector) return null;
  try {
    let root: ParentNode = document;
    const parts = selector.split(' >>> ');
    for (const [index, part] of parts.entries()) {
      const found: Element | null = root.querySelector(part);
      if (index === parts.length - 1) return found;
      if (!found?.shadowRoot) return null;
      root = found.shadowRoot;
    }
    return null;
  } catch {
    return null;
  }
}
