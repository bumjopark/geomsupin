import { modalDialogs, pageRoots } from './page-dom.ts';
// 화면 캡처 모듈. 위젯이 요청을 작성할 때 해시가 붙은 캡처 번들을 불러온다.
// modern-screenshot 위에 한국 사이트에서 자주 깨지는 세 가지를 직접 보정한다:
//   1) 교차 출처 CSS 안의 웹폰트(@font-face)  2) sticky/fixed 요소의 스크롤 위치  3) 개인정보 가림
import { domToCanvas, type Options as ScreenshotOptions } from 'modern-screenshot';
import { blobToDataUrl } from '../shared/browser.ts';
import { hasUrlCredentials } from '../shared/constants.ts';
import { STYLE_PROPS } from './style-props.ts';
import type { PositionMove } from './position-proposal.ts';
import { isInReviewMask, MASK_ATTRIBUTE } from './privacy.ts';

export interface CaptureNotes {
  /** CORS 때문에 캡처에서 빠진 이미지 수 */
  images: number;
  /** 캡처에 못 담는 다른 도메인 iframe 수 */
  iframes: number;
  /** 웹폰트 삽입에 실패한 수 */
  fonts: number;
  /** 캡처가 실패해 화면 없이 남긴 경우 */
  failed?: boolean;
}

export interface CaptureResult {
  blob: Blob | null;
  notes: CaptureNotes;
}

export interface CaptureOptions {
  /** 뷰포트 기준 클릭 좌표. 캡처에 핀을 그린다 */
  pin?: { x: number; y: number };
  /** 핀이 가리키는 요소의 뷰포트 기준 사각형. 캡처에 빨간 박스로 그린다 */
  target?: { x: number; y: number; w: number; h: number } | null;
  /** 캡처 제한 시간(ms) */
  maxMs?: number;
  /** CORS 를 열지 않은 사이트의 이미지를 서버가 대신 받아 오게 하는 프록시 */
  proxy?: { base: string; key: string; session: string };
  /** 렌더링용 복제본의 두 형제 요소에만 순서 변경을 적용한다. */
  move?: PositionMove;
}

const WIDGET_ATTR = 'data-gp-widget';
const FIX_ATTR = 'data-gp-fix';
const PRUNE_ATTR = 'data-gp-prune';
const FRAME_ATTR = 'data-gp-frame';
const LAYER_ATTR = 'data-gp-layer';
const MOVE_ATTR = 'data-gp-capture-move';
// 캡처하지 못한 자리(다른 도메인 이미지·프레임)는 사선 무늬로 표시해, 빈 페이지가 아니라 "캡처 불가 영역"임을 알아보게 한다.
const HATCH_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='100%' height='100%'><defs><pattern id='p' width='14' height='14' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'><rect width='14' height='14' fill='#f1f5f9'/><rect width='7' height='14' fill='#e2e8f0'/></pattern></defs><rect width='100%' height='100%' fill='url(#p)'/></svg>";
const PLACEHOLDER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(HATCH_SVG)}`;
const HATCH_CSS = 'repeating-linear-gradient(135deg, #f1f5f9 0 8px, #e2e8f0 8px 16px)';

// ─────────────────────────── 웹폰트 ───────────────────────────

const dataUrlCache = new Map<string, Promise<string>>();

function fontToDataUrl(url: string): Promise<string> {
  let p = dataUrlCache.get(url);
  if (!p) {
    p = fetch(url, { mode: 'cors', credentials: 'omit' }).then(async (res) => {
      if (!res.ok) throw new Error('font ' + res.status);
      const blob = await res.blob();
      if (blob.size > 8 * 1024 * 1024) throw new Error('font too large');
      return blobToDataUrl(blob);
    });
    dataUrlCache.set(url, p);
  }
  return p;
}

interface FaceRule { family: string; weight: string; style: string; range: string; src: string; base: string }

const norm = (s: string) => s.replace(/["']/g, '').trim();
const normRange = (s: string) => (s || 'U+0-10FFFF').replace(/\s+/g, '').toUpperCase();

function faceFromRule(rule: CSSFontFaceRule, base: string): FaceRule {
  const st = rule.style;
  return {
    family: norm(st.getPropertyValue('font-family')),
    weight: st.getPropertyValue('font-weight').trim() || 'normal',
    style: st.getPropertyValue('font-style').trim() || 'normal',
    range: normRange(st.getPropertyValue('unicode-range')),
    src: st.getPropertyValue('src'),
    base,
  };
}

async function collectFromRules(rules: CSSRuleList, base: string, out: FaceRule[], depth: number): Promise<void> {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSFontFaceRule) {
      out.push(faceFromRule(rule, base));
    } else if (rule instanceof CSSImportRule && depth < 3) {
      const imp = rule;
      const href = imp.href;
      try {
        if (imp.styleSheet && imp.styleSheet.cssRules) await collectFromRules(imp.styleSheet.cssRules, href, out, depth + 1);
        else throw new Error('blocked');
      } catch {
        await collectFromUrl(href, out, depth + 1);
      }
    } else if (rule instanceof CSSGroupingRule) {
      await collectFromRules(rule.cssRules, base, out, depth);
    }
  }
}

/** 교차 출처라서 cssRules 를 못 읽는 스타일시트는 CORS fetch 로 직접 받아 브라우저 파서로 읽는다. */
async function collectFromUrl(href: string, out: FaceRule[], depth: number): Promise<void> {
  if (depth > 3) return;
  const res = await fetch(href, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error('css ' + res.status);
  const text = await res.text();
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text.replace(/@import[^;]+;/g, ''));
  await collectFromRules(sheet.cssRules, href, out, depth);
  for (const m of text.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/g)) {
    try { await collectFromUrl(new URL(m[1]!, href).href, out, depth + 1); } catch { /* 무시 */ }
  }
}

function pickSrc(src: string, base: string): string | null {
  const entries = Array.from(src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)(?:\s*format\(\s*['"]?([^'")]+)['"]?\s*\))?/g));
  if (!entries.length) return null;
  const rank = (f?: string) => (f === 'woff2' ? 0 : f === 'woff' ? 1 : f === 'truetype' || f === 'opentype' ? 2 : 3);
  const best = entries.map((m) => ({ url: m[2]!, fmt: m[3] })).sort((a, b) => rank(a.fmt) - rank(b.fmt))[0]!;
  if (best.url.startsWith('data:')) return best.url;
  try { return new URL(best.url, base).href; } catch { return null; }
}

/** 지금 페이지가 실제로 쓰고 있는(loaded) 폰트만 골라 data URL 로 인라인한 @font-face CSS 를 만든다. */
async function buildFontCss(): Promise<{ css: string; failed: number }> {
  const loaded = Array.from(document.fonts).filter((f) => f.status === 'loaded');
  if (!loaded.length) return { css: '', failed: 0 };
  const key = (fam: string, w: string, s: string, r: string) => `${norm(fam)}|${w}|${s}|${normRange(r)}`;
  const want = new Set(loaded.map((f) => key(f.family, f.weight || 'normal', f.style || 'normal', f.unicodeRange)));

  const faces: FaceRule[] = [];
  let failed = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      await collectFromRules(sheet.cssRules, sheet.href || location.href, faces, 0);
    } catch {
      if (sheet.href) {
        try { await collectFromUrl(sheet.href, faces, 0); } catch { failed++; }
      }
    }
  }
  const seen = new Set<string>();
  const parts = await Promise.all(
    faces.map(async (f) => {
      const k = key(f.family, f.weight, f.style, f.range);
      if (!want.has(k) || seen.has(k)) return '';
      seen.add(k);
      const url = pickSrc(f.src, f.base);
      if (!url) return '';
      try {
        const data = url.startsWith('data:') ? url : await fontToDataUrl(url);
        const range = f.range === 'U+0-10FFFF' ? '' : `unicode-range:${f.range};`;
        return `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:${f.style};${range}src:url(${data});}`;
      } catch {
        failed++;
        return '';
      }
    }),
  );
  return { css: parts.filter(Boolean).join('\n'), failed };
}

// ─────────────────── sticky / fixed 요소 보정 ───────────────────

interface Fix { id: string; sticky: boolean; top: number; left: number; w: number; h: number }

interface Scan {
  fixes: Fix[];
  layers: { id: string; rect: DOMRect; backdrop: string }[];
  /** 화면 밖에만 있는 큰 덩어리: 자식은 복제하지 않고 크기만 남긴 빈 상자로 둔다(속도) */
  pruned: Set<Element>;
  /** 화면 밖에만 있는 이미지 주소: 내려받아 인라인하지 않고 빈 자리로 둔다(속도) */
  offscreen: Set<string>;
  cleanup: () => void;
}

const establishesBlock = (cs: CSSStyleDeclaration) =>
  cs.position !== 'static' || (cs.transform && cs.transform !== 'none') || (cs.filter && cs.filter !== 'none') || (cs.perspective && cs.perspective !== 'none') || /transform|filter/.test(cs.willChange) || /paint|layout/.test(cs.contain);

/**
 * 스크롤된 화면을 복제본에 그대로 옮기면(translate) sticky/fixed 요소가 문서 기준 위치로 돌아가 버린다.
 * 지금 화면에서의 실제 위치를 재서 복제본에서 그 자리에 놓는다.
 *  - fixed  : 문서 흐름 밖이므로 absolute 로 바꿔 그 자리에 고정
 *  - sticky : 흐름 안에 자리를 차지하므로 relative 로 바꿔 "원래 자리 → 지금 자리" 차이만큼만 옮김
 */
function scanPage(): Scan {
  const fixes: Fix[] = [];
  const layers: Scan['layers'] = [];
  const marked: Element[] = [];
  const seenVisible = new Set<string>();
  const seenHidden = new Set<string>();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const MARGIN = 120;
  const inView = (r: DOMRect) => r.bottom > -MARGIN && r.top < vh + MARGIN && r.right > -MARGIN && r.left < vw + MARGIN;
  const note = (url: string | null | undefined, visible: boolean) => {
    if (!url || url.startsWith('data:')) return;
    (visible ? seenVisible : seenHidden).add(url);
  };
  let n = 0;
  const roots = pageRoots();
  const dialogs = modalDialogs(roots);
  const top = roots.map(root => root.querySelector(`[${WIDGET_ATTR}]`)?.closest('dialog')).find(Boolean);
  dialogs.sort((a, b) => a === top ? 1 : b === top ? -1 : 0);
  for (const dialog of dialogs) {
    const id = `m${layers.length}`;
    // 실제 top layer는 조상 transform/overflow의 영향을 받지 않는다. 복제본도 루트로 옮긴다.
    // 변형 전 상자를 재고 원래 transform을 복사해야 translate/scale을 두 번 적용하지 않는다.
    const previous = dialog.getAttribute('style');
    let rect: DOMRect;
    try {
      for (const property of ['transition', 'transform', 'translate', 'rotate', 'scale']) dialog.style.setProperty(property, 'none', 'important');
      rect = dialog.getBoundingClientRect();
    } finally { if (previous === null) dialog.removeAttribute('style'); else dialog.setAttribute('style', previous); }
    const backdrop = getComputedStyle(dialog, '::backdrop');
    const backdropCss = STYLE_PROPS.map(p => `${p}:${backdrop.getPropertyValue(p)};`).join('');
    dialog.setAttribute(LAYER_ATTR, id);
    layers.push({ id, rect, backdrop: backdropCss });
  }
  document.querySelectorAll('body *').forEach((el) => {
    if ((el as HTMLElement).closest(`[${WIDGET_ATTR}]`)) return;
    const cs = getComputedStyle(el);
    if (cs.display !== 'none') {
      // 화면 밖 이미지를 건너뛰는 판단은 "그 주소를 쓰는 모든 요소가 화면 밖일 때"만 성립한다.
      // 이미지를 쓰는 요소 종류를 빠뜨리면 보이는 이미지를 지우게 되므로, 알려진 종류를 모두 훑는다.
      const tag = el.tagName;
      if (tag === 'IMG') {
        const img = el as HTMLImageElement;
        note(img.currentSrc || img.src, inView(el.getBoundingClientRect()));
      } else if (tag === 'VIDEO') {
        note((el as HTMLVideoElement).poster, inView(el.getBoundingClientRect()));
      } else if (tag === 'INPUT' && (el as HTMLInputElement).type === 'image') {
        note((el as HTMLInputElement).src, inView(el.getBoundingClientRect()));
      } else if (tag === 'image' || tag === 'IMAGE') {
        note(el.getAttribute('href') || el.getAttribute('xlink:href'), inView(el.getBoundingClientRect()));
      }
      const bg = cs.backgroundImage;
      if (bg && bg !== 'none' && bg.includes('url(')) {
        const visible = inView(el.getBoundingClientRect());
        for (const m of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) note(m[1], visible);
      }
    }
    if ((cs.position !== 'fixed' && cs.position !== 'sticky') || cs.display === 'none' || el.hasAttribute(LAYER_ATTR)) return;
    const r = el.getBoundingClientRect();
    const id = 'f' + n++;
    if (cs.position === 'sticky') {
      // 같은 작업 안에서 잠깐 relative 로 바꿔 "붙지 않았을 때의 원래 자리"를 잰다(그리기 전에 되돌리므로 화면은 안 변한다).
      const html = el as HTMLElement;
      const prev = html.getAttribute('style');
      html.style.setProperty('position', 'relative', 'important');
      for (const k of ['top', 'left', 'right', 'bottom']) html.style.setProperty(k, 'auto', 'important');
      const natural = html.getBoundingClientRect();
      if (prev === null) html.removeAttribute('style'); else html.setAttribute('style', prev);
      el.setAttribute(FIX_ATTR, id);
      marked.push(el);
      fixes.push({ id, sticky: true, top: r.top - natural.top, left: r.left - natural.left, w: r.width, h: r.height });
      return;
    }
    let anc: Element | null = el.parentElement;
    while (anc && anc !== document.body && anc !== document.documentElement && !establishesBlock(getComputedStyle(anc))) anc = anc.parentElement;
    let base = { top: 0, left: 0 };
    let bt = 0;
    let bl = 0;
    if (anc && anc !== document.body && anc !== document.documentElement) {
      const a = anc.getBoundingClientRect();
      const acs = getComputedStyle(anc);
      base = { top: a.top, left: a.left };
      bt = parseFloat(acs.borderTopWidth) || 0;
      bl = parseFloat(acs.borderLeftWidth) || 0;
    } else {
      const root = document.documentElement.getBoundingClientRect();
      base = { top: root.top, left: root.left };
    }
    el.setAttribute(FIX_ATTR, id);
    marked.push(el);
    fixes.push({ id, sticky: false, top: r.top - base.top - bt, left: r.left - base.left - bl, w: r.width, h: r.height });
  });
  const frames: Element[] = [];
  document.querySelectorAll('iframe').forEach((f) => {
    if (f.closest(`[${WIDGET_ATTR}]`)) return;
    let cross = false;
    try { cross = !f.contentDocument; } catch { cross = true; }
    const r = f.getBoundingClientRect();
    if (!cross || r.width < 1 || r.height < 1) return;
    f.setAttribute(FRAME_ATTR, `${r.width},${r.height}`);
    frames.push(f);
  });
  const pruned = pruneOffscreen(vw, vh);
  const offscreen = new Set<string>();
  for (const u of seenHidden) if (!seenVisible.has(u)) offscreen.add(u);
  return {
    fixes,
    layers,
    pruned,
    offscreen,
    cleanup: () => {
      marked.forEach((e) => e.removeAttribute(FIX_ATTR));
      dialogs.forEach((e) => e.removeAttribute(LAYER_ATTR));
      pruned.forEach((e) => e.removeAttribute(PRUNE_ATTR));
      frames.forEach((e) => e.removeAttribute(FRAME_ATTR));
    },
  };
}

const BOXY = new Set(['block', 'flex', 'grid', 'table', 'list-item', 'flow-root', 'inline-block', 'inline-flex', 'inline-grid', 'table-cell']);

/**
 * 화면(뷰포트) 밖에만 있는 덩어리를 찾아 표시한다. 복제 비용은 대부분 노드 수에 비례하는데, 스크롤 아래쪽이 대부분이라
 * 이걸 줄이는 게 가장 효과가 크다. 레이아웃이 밀리지 않도록 덩어리 자체는 복제하되 크기를 고정하고 자식만 뺀다.
 * 보수적으로: fixed/sticky 를 품었거나, 넘쳐 나온 자식이 화면에 닿거나, 크기가 0 이거나, 인라인이면 건드리지 않는다.
 */
function pruneOffscreen(vw: number, vh: number): Set<Element> {
  const M = 240;
  const out = new Set<Element>();
  const canPrune = (el: Element, cs: CSSStyleDeclaration): boolean => {
    if (!el.firstElementChild) return false;
    if (cs.position === 'fixed' || cs.position === 'sticky' || !BOXY.has(cs.display)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const right = r.left + Math.max(r.width, el.scrollWidth);
    const bottom = r.top + Math.max(r.height, el.scrollHeight);
    const away = bottom < -M || r.top > vh + M || right < -M || r.left > vw + M;
    if (!away) return false;
    return !el.querySelector(`[${FIX_ATTR}], [${LAYER_ATTR}], input[type="password"], [${MASK_ATTRIBUTE}], [${WIDGET_ATTR}]`);
  };
  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      if (el.hasAttribute(WIDGET_ATTR) || el.tagName === 'GP-WIDGET') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      if (canPrune(el, cs)) {
        const r = el.getBoundingClientRect();
        el.setAttribute(PRUNE_ATTR, `${r.width},${r.height}`);
        out.add(el);
        continue;
      }
      walk(el);
    }
  };
  if (document.body) walk(document.body);
  return out;
}

function restoreLayers(root: Node, layers: Scan['layers']) {
  if (!(root instanceof Element)) return;
  for (const [index, layer] of layers.entries()) {
    const modal = root.querySelector<HTMLElement>(`[${LAYER_ATTR}="${layer.id}"]`);
    if (!modal) continue;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = layer.backdrop;
    const position = (el: HTMLElement, rect: { left: number; top: number; width: number; height: number }, z: number) => {
      for (const [property, value] of Object.entries({ position: 'absolute', left: `${rect.left + window.scrollX}px`, top: `${rect.top + window.scrollY}px`, width: `${rect.width}px`, height: `${rect.height}px`, right: 'auto', bottom: 'auto', margin: '0', 'box-sizing': 'border-box', 'max-width': 'none', 'max-height': 'none', 'z-index': String(z) })) el.style.setProperty(property, value, 'important');
    };
    position(backdrop, { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }, 2147483000 + index * 2);
    position(modal, layer.rect, 2147483001 + index * 2);
    root.append(backdrop, modal);
  }
}

function applyFixes(root: Node, fixes: Fix[]) {
  if (!(root instanceof Element)) return;
  for (const f of fixes) {
    const el = root.querySelector(`[${FIX_ATTR}="${f.id}"]`) as HTMLElement | null;
    if (!el) continue;
    const s = el.style;
    s.right = 'auto';
    s.bottom = 'auto';
    s.top = f.top + 'px';
    s.left = f.left + 'px';
    if (f.sticky) {
      s.position = 'relative';
    } else {
      s.position = 'absolute';
      s.width = f.w + 'px';
      s.height = f.h + 'px';
      s.margin = '0';
      s.boxSizing = 'border-box';
    }
  }
}

/**
 * 실제 브라우저에서 html/body 의 overflow 는 뷰포트로 전파돼 내용을 자르지 않는다. 그런데 복제본에서는 body 가 진짜 상자가 되어,
 * 높이가 고정된 사이트(예: body{height:900px;overflow:auto}, 무신사)에서는 첫 화면 아래 내용이 전부 잘려 나간다.
 */
function unclipRoot(clone: Node) {
  if (!(clone instanceof HTMLElement)) return;
  // SVG 안의 html은 실제 문서 루트와 달리 body의 위쪽 margin과 합쳐질 수 있다.
  // 그 결과 fixed/top-layer와 캡처 핀 좌표가 기본 body margin(8px)만큼 어긋난다.
  if (clone.tagName === 'HTML' && (!clone.style.display || clone.style.display === 'block')) clone.style.setProperty('display', 'flow-root', 'important');
  const targets: HTMLElement[] = [clone];
  for (const c of Array.from(clone.children)) if (c.tagName === 'BODY') targets.push(c as HTMLElement);
  for (const el of targets) {
    el.style.setProperty('overflow', 'visible', 'important');
    el.style.setProperty('max-height', 'none', 'important');
  }
  // restoreScrollPosition 은 문서 스크롤(html 의 scrollTop)도 자식에게 translate 로 적용한다. 우리는 이미 루트 전체를 옮기므로
  // 두 번 밀리지 않게 html 의 자식에 들어간 그 값만 되돌린다(안쪽 스크롤 영역의 복원은 그대로 둔다).
  const sx = window.scrollX;
  const sy = window.scrollY;
  if (sx || sy) {
    for (const c of Array.from(clone.children)) {
      if (!(c instanceof HTMLElement)) continue;
      const m = new DOMMatrix(c.style.transform || 'none');
      m.e += sx;
      m.f += sy;
      c.style.transform = m.isIdentity ? '' : m.toString();
    }
  }
}

/**
 * 다른 도메인 iframe 은 내용을 못 담는다. SVG 이미지 안에서는 iframe 요소가 배경·테두리까지 아예 그려지지 않으므로,
 * 같은 크기의 사선 무늬 div 로 바꿔 "캡처 불가 영역"임을 알아보게 한다.
 */
function hatchFrames(clone: Node) {
  if (!(clone instanceof Element)) return;
  clone.querySelectorAll<HTMLElement>(`iframe[${FRAME_ATTR}]`).forEach((f) => {
    const [w, h] = (f.getAttribute(FRAME_ATTR) ?? '').split(',');
    if (!w || !h) return;
    const d = f.ownerDocument.createElement('div');
    d.className = f.className;
    d.setAttribute('style', f.getAttribute('style') ?? '');
    const st = d.style;
    st.setProperty('display', f.style.display && f.style.display !== 'inline' ? f.style.display : 'inline-block', 'important');
    st.setProperty('box-sizing', 'border-box', 'important');
    st.setProperty('width', `${w}px`, 'important');
    st.setProperty('height', `${h}px`, 'important');
    st.setProperty('background', HATCH_CSS, 'important');
    st.setProperty('border', '1px dashed #94a3b8', 'important');
    st.setProperty('vertical-align', 'bottom', 'important');
    f.replaceWith(d);
  });
}

// ─────────────────────────── 개인정보 가림 ───────────────────────────

const MASK_LAYOUT = [
  'display', 'position', 'top', 'left', 'right', 'bottom', 'z-index',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'float', 'clear', 'vertical-align', 'align-self', 'justify-self', 'order', 'grid-area',
  'transform', 'transform-origin', 'translate', 'rotate', 'scale',
];

/** 그려지는 미디어나 가상 요소까지 담기지 않도록 가림 영역을 복제 시작 전에 대체한다. */
function createMaskedClone(node: Node): Node | undefined {
  const owner = node.ownerDocument;
  if (!owner || !isInReviewMask(node)) return undefined;
  // 슬롯에 할당된 텍스트는 라이브러리가 슬롯을 건너뛰고 복제한다.
  if (node.nodeType !== Node.ELEMENT_NODE) return owner.createTextNode('');

  const element = node as Element;
  const css = owner.defaultView?.getComputedStyle(element);
  const parent = (element as SVGElement).ownerSVGElement;
  if (parent) {
    const rect = owner.createElementNS(parent.namespaceURI, 'rect');
    rect.setAttribute('fill', '#9aa0a6');
    try {
      const { x, y, width, height } = (element as SVGGraphicsElement).getBBox();
      for (const [key, value] of Object.entries({ x, y, width, height })) rect.setAttribute(key, String(value));
      const transform = element.getAttribute('transform');
      if (transform) rect.setAttribute('transform', transform);
    } catch { /* 그릴 상자를 구할 수 없어도 원본 내용은 담지 않는다. */ }
    return rect;
  }

  const box = owner.createElement('div');
  const rect = element.getBoundingClientRect();
  const width = (element as HTMLElement).offsetWidth || rect.width;
  const height = (element as HTMLElement).offsetHeight || rect.height;
  for (const name of MASK_LAYOUT) {
    const value = css?.getPropertyValue(name);
    if (value) box.style.setProperty(name, value);
  }
  if (css?.display === 'inline' || css?.display === 'contents') box.style.display = 'inline-block';
  box.style.boxSizing = 'border-box';
  box.style.width = box.style.minWidth = box.style.maxWidth = `${width}px`;
  box.style.height = box.style.minHeight = box.style.maxHeight = `${height}px`;
  box.style.flex = '0 0 auto';
  box.style.backgroundColor = '#9aa0a6';
  for (const name of [FIX_ATTR, LAYER_ATTR]) {
    const value = element.getAttribute(name);
    if (value !== null) box.setAttribute(name, value);
  }
  return box;
}

// ─────────────────────────── 캡처 ───────────────────────────

const isWidgetNode = (n: Node) => n instanceof Element && (n.hasAttribute(WIDGET_ATTR) || n.tagName === 'GP-WIDGET');

function pageBackground(): string {
  for (const el of [document.body, document.documentElement]) {
    const c = getComputedStyle(el).backgroundColor;
    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
  }
  return '#ffffff';
}

const corsBlocked = new Set<string>();

function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(t));
}

/**
 * 캡처에 넣을 이미지·CSS 자원을 data URL 로 받아 온다.
 *  1) 화면 밖에만 있는 것은 건너뛴다  2) 직접 받기(CORS 를 연 사이트)  3) 안 되면 서버 프록시(CORS 를 안 연 CDN)
 *  모두 실패하면 빈 자리로 두고, 빠진 이미지 수를 센다.
 */
async function fetchAsset(url: string, offscreen: Set<string>, proxy: CaptureOptions['proxy'], notes: CaptureNotes): Promise<string> {
  if (offscreen.has(url)) return PLACEHOLDER;
  if (!/^https?:/i.test(url)) return PLACEHOLDER;
  let asset: URL;
  try { asset = new URL(url); } catch { return PLACEHOLDER; }
  const origin = asset.origin;

  // 한 CDN 이 CORS 를 안 열었으면 같은 CDN 의 다른 자원은 바로 프록시로 간다.
  if (!corsBlocked.has(origin)) {
    try {
      const r = await fetchWithTimeout(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' }, 4000);
      if (r.ok) {
        const b = await r.blob();
        if (b.size <= 8 * 1024 * 1024) return await blobToDataUrl(b);
      }
    } catch {
      corsBlocked.add(origin);
    }
  }
  if (proxy && !hasUrlCredentials(asset)) {
    asset.hash = '';
    try {
      const r = await fetchWithTimeout(`${proxy.base}/api/w/img?u=${encodeURIComponent(asset.href)}`, { mode: 'cors', credentials: 'omit', headers: { 'X-GP-Key': proxy.key, Authorization: `Bearer ${proxy.session}` } }, 7000);
      if (r.ok) return await blobToDataUrl(await r.blob());
    } catch { /* 아래에서 빈 자리로 */ }
  }
  notes.images++;
  return PLACEHOLDER;
}

function drawPin(ctx: CanvasRenderingContext2D, opts: CaptureOptions) {
  if (opts.target) {
    const t = opts.target;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#e11d48';
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(t.x, t.y, t.w, t.h);
    ctx.restore();
  }
  if (opts.pin) {
    const { x, y } = opts.pin;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#e11d48';
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/webp', 0.86));
}

export async function captureViewport(opts: CaptureOptions = {}): Promise<CaptureResult> {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const notes: CaptureNotes = { images: 0, iframes: 0, fonts: 0 };

  document.querySelectorAll('iframe').forEach((f) => {
    try { void f.contentDocument?.body; if (!f.contentDocument) notes.iframes++; } catch { notes.iframes++; }
  });

  const marks = scanPage();
  const move = opts.move;
  const previous = move ? [move.target.getAttribute(MOVE_ATTR), move.reference.getAttribute(MOVE_ATTR)] : [];
  try {
    if (move) {
      if (!move.target.isConnected || !move.target.parentElement || move.target.parentElement !== move.reference.parentElement) throw new Error('move target changed');
      move.target.setAttribute(MOVE_ATTR, 'target');
      move.reference.setAttribute(MOVE_ATTR, 'reference');
    }
    const run = async () => {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
      const font = await buildFontCss().catch(() => ({ css: '', failed: 1 }));
      notes.fonts = font.failed;
      const options: ScreenshotOptions & { createMaskedClone: typeof createMaskedClone } = {
        createMaskedClone,
        width: vw,
        height: vh,
        scale: 1,
        // 느린 이미지·미디어는 기다리지 않고 빈 자리로 둔다(기본 30초는 캡처 전체를 붙잡는다).
        timeout: 5000,
        includeStyleProperties: STYLE_PROPS,
        backgroundColor: pageBackground(),
        // display:none 은 화면에 안 나오고 레이아웃에도 영향이 없으니 복제하지 않는다(head 도 여기 포함).
        filter: (n) => {
          if (isWidgetNode(n)) return false;
          if (n instanceof Element && getComputedStyle(n).display === 'none') return false;
          const p = n.parentNode;
          return !(p instanceof Element && marks.pruned.has(p));
        },
        onCloneEachNode: (c) => {
          if (!(c instanceof HTMLElement)) return;
          const v = c.getAttribute(PRUNE_ATTR);
          if (!v) return;
          const [w, h] = v.split(',');
          c.removeAttribute(PRUNE_ATTR);
          const st = c.style;
          st.boxSizing = 'border-box';
          st.width = `${w}px`;
          st.height = `${h}px`;
          st.minWidth = st.maxWidth = `${w}px`;
          st.minHeight = st.maxHeight = `${h}px`;
          st.flex = '0 0 auto';
          st.overflow = 'hidden';
        },
        fetchFn: (url: string) => fetchAsset(url, marks.offscreen, opts.proxy, notes),
        style: { transform: `translate(${-sx}px, ${-sy}px)`, transformOrigin: '0 0' } as Partial<CSSStyleDeclaration>,
        // 우리가 로드된 폰트를 직접 모아 넘긴다. 넘길 게 없을 때 라이브러리 기본 경로를 타면, 임시 문서에 <style> 을 만들어 .sheet 를 읽다가
        // 엄격한 CSP(style-src 에 unsafe-inline 없음)에서 null 이 되어 캡처 전체가 실패한다. 그래서 기본 경로는 쓰지 않는다.
        font: font.css ? { cssText: font.css } : false,
        // 안쪽 스크롤 영역(목록·캐러셀 등)이 스크롤된 위치 그대로 그린다.
        features: { restoreScrollPosition: true },
        onCloneNode: (clone) => {
          if (move) {
            if (!(clone instanceof Element)) throw new Error('move clone root missing');
            const target = clone.querySelector(`[${MOVE_ATTR}="target"]`);
            const reference = clone.querySelector(`[${MOVE_ATTR}="reference"]`);
            if (!target || !reference || target.parentNode !== reference.parentNode) throw new Error('move clone target missing');
            if (move.side === 'before') reference.before(target);
            else reference.after(target);
          }
          unclipRoot(clone);
          applyFixes(clone, marks.fixes);
          restoreLayers(clone, marks.layers);
          hatchFrames(clone);
        },
        fetch: {
          requestInit: { cache: 'force-cache' },
          placeholderImage: () => { notes.images++; return PLACEHOLDER; },
        },
      };
      const canvas = await domToCanvas(document.documentElement, options);
      const ctx = canvas.getContext('2d');
      if (ctx) drawPin(ctx, opts);
      return canvas;
    };
    const canvas = await Promise.race([
      run(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('capture timeout')), opts.maxMs ?? 15000)),
    ]);
    const blob = await toBlob(canvas);
    return { blob, notes };
  } catch (e) {
    console.warn('[geomsupin] capture failed', e);
    return { blob: null, notes: { ...notes, failed: true } };
  } finally {
    marks.cleanup();
    if (move) {
      [move.target, move.reference].forEach((el, i) => {
        const value = previous[i];
        if (value === null || value === undefined) el.removeAttribute(MOVE_ATTR);
        else el.setAttribute(MOVE_ATTR, value);
      });
    }
  }
}
