// 연결된 스테이징 페이지 안에 핀과 대화를 표시한다.
import { blobToDataUrl } from '../shared/browser.ts';
import { avatarAppearance } from '../shared/avatar.ts';
import { h, clear } from './dom.ts';
import { CSS_TEXT } from './styles.ts';
import { buildSelector, detectEnv, deviceClass, deviceLabel, findBySelector, textHint } from './env.ts';
import { KINDS, normalizePageUrl, type Kind } from '../shared/constants.ts';
import type { CaptureNotes, CaptureOptions, CaptureResult } from './capture.ts';
import { mergeComments } from '../shared/comments.ts';
import { fetchJson, pendingMutation } from '../shared/network.ts';
import { mountHost } from './host.ts';
import { isolatePointerEvents } from './events.ts';
import { positionMoves, startPositionDrag, type PositionMove } from './position-proposal.ts';
import { followReviewEvents } from './review-events.ts';
import { touchesReviewMask } from './privacy.ts';
import { EN_REVIEW_TERMS, normalizeLocale, reviewTerm, type Locale } from '../shared/locale.ts';
import { systemComment, widgetApiError, widgetText, type WidgetLabel } from './locale.ts';

interface Boot {
  key: string;
  base: string;
  capture: string;
  session: string;
  reviewer: Reviewer;
  locale?: Locale;
  matchesBookmark?: (key: string, previewId: string, pid: string, token: string, locale?: Locale) => boolean;
  notify: (type: 'active' | 'unavailable') => void;
}
declare global {
  interface Window {
    __gpBoot?: Boot;
    __gpCapture?: { captureViewport: (o?: CaptureOptions) => Promise<CaptureResult> };
  }
}

interface Reviewer { id: string; name: string }
interface Req {
  id: string;
  no: number;
  body: string;
  status: string;
  kind: string;
  pageUrl: string;
  pageTitle: string;
  selector: string;
  textHint: string;
  offsetX: number | null;
  offsetY: number | null;
  viewportW: number | null;
  thumbUrl: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  resolvedAt: string | null;
  resolutionNote: string;
  author: string;
  mine: boolean;
  commentCount: number;
  lastBy: string | null;
  lastText: string | null;
}
interface Comment { id: string; type: 'reviewer' | 'agency' | 'system'; author: string; body: string; createdAt: string; mine: boolean }
interface Detail extends Req { asIs: string | null; toBe: string | null; browser: string; os: string; screenshotUrl: string | null; proposalUrl: string | null; comments: Comment[]; commentsBefore: string | null }

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const WIDGET_TAG = 'gp-widget';
const POLL_MS = 6_000;
/** 대화창이 열려 있는 동안 새 댓글을 받아 오는 간격 */
const THREAD_POLL_MS = 3_000;
const MAX_PROPOSAL_CAPTURE_BYTES = 3_000_000;
const KIND_EMOJI: Record<string, string> = { 수정: '✏️', 추가: '➕', 문의: '❓', 버그: '🐞' };
const STATUS_LABEL: Record<string, string> = { 접수: '접수', 진행: '고치는 중', 완료: '완료', 재발생: '다시 열림', 보류: '보류' };

const EN_DEVICE = { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop' } as const;
const enAgo = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
const enDay = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

function start(boot: Boot) {
  const { key, base, notify } = boot;
  const locale = normalizeLocale(boot.locale);
  const en = locale === 'en';
  const uiText = (label: WidgetLabel) => widgetText(locale, label);
  const statuses: Readonly<Record<string, string>> = en ? EN_REVIEW_TERMS : STATUS_LABEL;
  const devices = en ? EN_DEVICE : deviceLabel;
  const nameFor = (name: string, mine: boolean) => mine ? `${name} (${en ? 'me' : '나'})` : name;
  const kindLabel = (kind: string) => reviewTerm(kind, locale);
  const API = `${base}/api/w`;
  const openKey = `gp:open:${key}`;
  const memory = new Map<string, string>();
  const tab = {
    get(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return memory.get('s:' + k) ?? null; } },
    set(k: string, v: string) { try { sessionStorage.setItem(k, v); } catch { memory.set('s:' + k, v); } },
    del(k: string) { try { sessionStorage.removeItem(k); } catch { memory.delete('s:' + k); } },
  };

  // ── API ──
  let session = boot.session;
  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetchJson(API + path, {
      method: init.method ?? 'GET',
      mode: 'cors',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        'X-GP-Key': key,
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }).catch((error: unknown) => {
      if (!en) throw error;
      const timedOut = error instanceof Error && !error.cause;
      throw new Error(timedOut ? 'The server took too long to respond. Try again.' : 'Could not connect to the server. Check your connection and try again.', { cause: error });
    });
    const { response: res, data } = response;
    if (!res.ok) {
      const code = data?.error?.code ?? 'error';
      if (code === 'unknown_key' || code === 'bad_key') projectGone = true;
      throw new ApiError(res.status, code, widgetApiError(locale, code, data?.error?.message, '요청을 처리하지 못했어요'));
    }
    return data as T;
  }
  // 프로젝트가 종료됐거나 지워지면 위젯 키가 더는 통하지 않는다(unknown_key). 링크가 닫힌 것과 구분해서 알려 준다.
  let projectGone = false;
  const isEnded = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.code === 'link_invalid' || e.code === 'unknown_key' || e.code === 'bad_key');

  // ── 상태 ──
  let reviewer: Reviewer | null = boot.reviewer;
  let requests: Req[] = [];
  let mode: 'boot' | 'ended' | 'idle' | 'pin' | 'compose' = 'boot';
  let panelOpen = false;
  let filter: 'page' | 'all' | 'mine' = 'all';
  let filterChosen = false;
  let hideDone = false;
  let unread = 0;

  // ── 호스트(Shadow DOM) ──
  document.querySelectorAll(WIDGET_TAG).forEach((n) => n.remove());
  const host = document.createElement(WIDGET_TAG);
  host.setAttribute('data-gp-widget', '');
  host.lang = locale;
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;width:auto!important;height:auto!important;overflow:visible!important;z-index:2147483647!important;pointer-events:none!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  const root = h('div', { class: 'root' });
  // style-src 에 'unsafe-inline' 이 없는 엄격한 사이트에서는 <style> 태그가 무시된다. 생성한 스타일시트(adoptedStyleSheets)는 그 검사를 받지 않는다.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_TEXT);
    shadow.adoptedStyleSheets = [sheet];
    shadow.append(root);
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    shadow.append(style, root);
  }

  const layerMarkers = h('div');
  const hilite = h('div', { class: 'hilite' }, h('span', { class: 'tag' }));
  const overlay = h('div'); // 배너·팝오버·모달
  root.append(layerMarkers, hilite, overlay);

  const isWidget = (n: EventTarget | null) => n instanceof Node && (n === host || host.contains(n) || (n as Element).getRootNode?.() === shadow);

  const mounting = mountHost(host, shadow);

  // focus-trap 류 라이브러리가 document 캡처에서 위젯 입력의 포커스를 빼앗지 않도록 먼저 차단한다.
  for (const ev of ['focus', 'focusin'] as const) window.addEventListener(ev, e => {
    const target = e.composedPath()[0];
    if (isWidget(target ?? null)) {
      e.stopPropagation();
      if (ev === 'focusin' && target instanceof HTMLElement) mounting.recoverFocus(target);
    }
  }, true);

  // 사이트의 단축키·클릭 처리가 위젯 안의 입력과 클릭에 끼어들지 않게 한다.
  //  - 키: 사이트가 문서 맨 앞(캡처 단계)에서 글자 키를 가로채도 입력창에 글을 쓸 수 있도록, 위젯 안에서 일어난 키 이벤트는 window 에서 먼저 받아
  //    우리 핸들러(onKey)로 처리하고 사이트에는 넘기지 않는다(글자가 입력되는 기본 동작은 그대로다).
  //  - 클릭·포인터: 사이트의 "바깥을 누르면 닫힘" 같은 처리가 핀을 꽂는 중에 모달·드롭다운을 닫지 않도록, 위젯 안의 이벤트는 window 캡처에서 받아 ShadowRoot 내부에만 전달한다.
  const keyHandlers = new WeakMap<EventTarget, (e: KeyboardEvent) => void>();
  const onKey = (el: HTMLElement, fn: (e: KeyboardEvent) => void) => { keyHandlers.set(el, fn); };
  for (const ev of ['keydown', 'keyup', 'keypress'] as const) {
    window.addEventListener(ev, (e) => {
      const target = e.composedPath()[0] ?? null;
      if (!isWidget(target)) return;
      // 위젯에서 Esc를 눌렀을 때 사이트의 네이티브 모달까지 닫히지 않게 한다.
      if (ev === 'keydown' && e.key === 'Escape') e.preventDefault();
      if (ev === 'keydown' && target) keyHandlers.get(target)?.(e as KeyboardEvent);
      e.stopPropagation();
    }, true);
  }
  isolatePointerEvents(isWidget);

  // ── 작은 도우미 ──
  let toastTimer = 0;
  function toast(msg: string, ms = 3200, onClick?: () => void) {
    root.querySelectorAll('.toast').forEach((n) => n.remove());
    const t = h('div', { class: `toast${onClick ? ' act' : ''}`, role: onClick ? 'button' : 'status' }, msg);
    if (onClick) t.addEventListener('click', () => { t.remove(); onClick(); });
    root.append(t);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t.remove(), ms);
  }

  function ago(iso: string): string {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return uiText('방금 전');
    if (s < 3600) return en ? enAgo.format(-Math.round(s / 60), 'minute') : `${Math.round(s / 60)}분 전`;
    if (s < 86400) return en ? enAgo.format(-Math.round(s / 3600), 'hour') : `${Math.round(s / 3600)}시간 전`;
    if (s < 86400 * 7) return en ? enAgo.format(-Math.round(s / 86400), 'day') : `${Math.round(s / 86400)}일 전`;
    const d = new Date(iso);
    return en ? enDay.format(d) : `${d.getMonth() + 1}월 ${d.getDate()}일`;
  }

  function avatar(name: string, size = '') {
    const { initial, color } = avatarAppearance(name);
    const el = h('span', { class: `av${size ? ' ' + size : ''}`, 'aria-hidden': 'true' }, initial);
    el.style.background = color;
    return el;
  }

  /** "김디자인 님" / 담당자는 "담당자 흐름 님" */
  const who = (name: string) => {
    const team = name.endsWith('(담당자)');
    return en ? team ? `${name.slice(0, -5)} (team)` : name : team ? `담당자 ${name.slice(0, -5)} 님` : `${name} 님`;
  };
  const pathOf = (u: string) => { try { const x = new URL(u); return (x.pathname + x.search).slice(0, 40) || '/'; } catch { return u.slice(0, 40); } };
  const pageIsCurrent = (r: Req) => r.pageUrl === normalizePageUrl(location.href);
  const myName = () => reviewer?.name || '';

  /** 댓글·상태 변경처럼 이름이 보이는 행동을 처음 할 때 한 번만 이름을 받는다(가입 아님). */
  function askName(edit = false): Promise<boolean> {
    if (!edit && myName()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const input = h('input', { type: 'text', maxLength: 30, placeholder: uiText('예: 김디자인'), autocomplete: 'name', 'aria-label': uiText('내 별명') });
      input.value = myName();
      const err = h('div', { class: 'err' });
      const close = (ok: boolean) => { box.remove(); resolve(ok); };
      const go = async () => {
        if (save.disabled) return;
        const name = input.value.trim();
        if (!name) { err.textContent = uiText('별명을 입력해 주세요'); input.focus(); return; }
        save.disabled = true;
        try {
          const r = await call<{ reviewer: Reviewer }>('/reviewer', { method: 'PATCH', body: { name } });
          if (reviewer) reviewer.name = r.reviewer.name;
          close(true);
          if (panelOpen) renderPanel();
        } catch (e) {
          err.textContent = e instanceof Error ? e.message : uiText('별명을 저장하지 못했어요');
          save.disabled = false;
        }
      };
      const title = edit ? uiText('별명 바꾸기') : uiText('별명을 알려 주세요');
      const save = h('button', { class: 'btn primary', type: 'button', on: { click: () => void go() } }, edit ? uiText('저장') : uiText('확인'));
      const box = h('div', { class: 'modal-wrap', on: { click: (e: MouseEvent) => { if (e.target === box) close(false); } } },
        h('div', { class: 'modal card', role: 'dialog', 'aria-label': title },
          h('div', { class: 'big', 'aria-hidden': 'true' }, '👋'),
          h('h3', null, title),
          h('div', { class: 'muted' }, uiText('댓글과 변경 기록에 이름이 함께 보여요. 가입은 필요 없어요.')),
          input, err,
          h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => close(false) } }, uiText('취소')), save)));
      onKey(input, (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); void go(); }
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
      });
      overlay.append(box);
      window.setTimeout(() => input.focus(), 30);
    });
  }

  async function authenticate() {
    mode = 'idle';
    clear(overlay);
    renderBar();
    await refresh();
    if (session) stopLive = followReviewEvents(`${API}/events`, key, session, queueLiveSync);
    const openId = tab.get(openKey);
    const reopen = openId ? requests.find((x) => x.id === openId) : undefined;
    if (openId) { tab.del(openKey); if (reopen && pageIsCurrent(reopen)) window.setTimeout(() => { syncMarkers(); openThread(openId); pulse(openId); }, 400); }
  }

  // ─────────────────────────── 하단 막대 ───────────────────────────
  const bar = h('div', { class: 'bar right hide' });
  root.append(bar);
  function renderBar() {
    clear(bar);
    bar.classList.toggle('hide', !session || mode === 'pin' || mode === 'compose' || mode === 'ended' || mode === 'boot');
    if (!session) return;
    bar.append(
      h('button', { class: 'pill primary', type: 'button', on: { click: () => enterPin() } }, h('span', { 'aria-hidden': 'true' }, '📍'), uiText('요청 남기기')),
      h('button', { class: 'pill ghost', type: 'button', 'aria-expanded': String(panelOpen), on: { click: () => togglePanel() } },
        h('span', { 'aria-hidden': 'true' }, '💬'), uiText('모두의 요청'), h('span', { class: 'count' }, String(requests.length)), unread ? h('span', { class: 'dot', title: uiText('새 소식이 있어요') }) : null),
    );
  }

  // ─────────────────────────── 모두의 요청(목록·상세) ───────────────────────────
  const panel = h('div', { class: 'panel card hide right', role: 'dialog', 'aria-label': uiText('모두의 요청') });
  root.append(panel);

  /** 다시 그리지 않고 "방금 전/3분 전" 글자만 새로 계산한다 */
  function retime() {
    panel.querySelectorAll<HTMLElement>('[data-at]').forEach((el) => { const t = ago(el.dataset.at!); if (el.textContent !== t) el.textContent = t; });
  }

  function visibleList(): Req[] {
    let list = requests;
    if (filter === 'page') list = list.filter(pageIsCurrent);
    else if (filter === 'mine') list = list.filter((r) => r.mine);
    if (hideDone) list = list.filter((r) => r.status !== '완료');
    return list;
  }

  function statusChip(status: string) { return h('span', { class: `st ${status}` }, statuses[status] ?? status); }

  function renderPanel() {
    if (!panelOpen) return;
    const keepScroll = panel.querySelector('.list')?.scrollTop ?? 0;
    // 주기적으로 목록을 새로 받아도 바뀐 게 없으면 다시 그리지 않는다(썸네일이 깜빡이지 않게). "n분 전" 글자만 제자리에서 갱신한다.
    const sig = [filter, hideDone, myName(), normalizePageUrl(location.href), visibleList().map((r) => `${r.id}:${r.author}:${r.status}:${r.updatedAt}:${r.commentCount}:${r.thumbUrl ?? ''}`).join('|'), requests.length].join('~');
    if (panel.dataset.sig === sig) { retime(); return; }
    panel.dataset.sig = sig;
    clear(panel);
    const here = requests.filter(pageIsCurrent).length;
    const mine = requests.filter((r) => r.mine).length;
    const tabBtn = (id: typeof filter, label: string, n: number) =>
      h('button', { class: 'tabx', type: 'button', 'aria-pressed': String(filter === id), on: { click: () => { filter = id; filterChosen = true; renderPanel(); } } }, label, h('span', { class: 'n' }, String(n)));
    const list = h('div', { class: 'list' });
    const shown = visibleList();
    if (!shown.length) {
      list.append(h('div', { class: 'empty' },
        h('div', { class: 'big', 'aria-hidden': 'true' }, requests.length ? '🔍' : '🌱'),
        requests.length ? uiText('조건에 맞는 요청이 없어요.') : uiText('아직 요청이 없어요.'),
        h('br'),
        requests.length ? uiText('다른 탭을 눌러 보세요.') : uiText('“요청 남기기”를 누르고 고칠 곳을 콕 찍어 보세요.')));
    }
    for (const r of shown) {
      const el = r.selector ? findBySelector(r.selector) : null;
      const onThisPage = pageIsCurrent(r);
      const dev = r.viewportW ? deviceClass(r.viewportW) : null;
      list.append(h('button', { class: 'item', type: 'button', on: { click: () => openRequest(r) } },
        avatar(r.author),
        h('div', { class: 'main' },
          h('div', { class: 'meta' },
            h('b', { class: 'who' }, nameFor(r.author, r.mine)),
            h('span', { class: 'time', 'data-at': r.createdAt }, ago(r.createdAt)),
            h('span', { class: 'no' }, `#${r.no}`),
            statusChip(r.status),
          ),
          h('div', { class: 'body' }, r.body),
          h('div', { class: 'sub' },
            r.commentCount ? h('span', null, `💬 ${r.commentCount}`) : null,
            !onThisPage ? h('span', { class: 'tagx' }, pathOf(r.pageUrl)) : null,
            onThisPage && !el ? h('span', { class: 'tagx' }, uiText('위치 못 찾음')) : null,
            dev ? h('span', { class: 'tagx' }, devices[dev]) : null,
          ),
        ),
        r.thumbUrl ? h('img', { class: 'th', src: r.thumbUrl, alt: '', loading: 'lazy', on: { error: (e: Event) => (e.target as HTMLElement).remove() } }) : null,
      ));
    }
    panel.append(
      h('div', { class: 'top' },
        h('h3', null, uiText('모두의 요청')),
        h('div', { class: 'tops' },
          h('button', { class: 'chip', type: 'button', 'aria-pressed': String(hideDone), on: { click: () => { hideDone = !hideDone; renderPanel(); layoutMarkers(); } } }, uiText('완료 숨기기')),
          h('button', { class: 'x', type: 'button', 'aria-label': uiText('닫기'), on: { click: () => togglePanel(false) } }, '✕'))),
      h('div', { class: 'tabs' }, tabBtn('page', uiText('이 페이지'), here), tabBtn('all', uiText('전체'), requests.length), tabBtn('mine', uiText('내 것'), mine)),
      list,
      h('div', { class: 'foot' },
        myName()
          ? h('span', { class: 'me' }, avatar(myName(), 'sm'), en ? myName() : `${myName()} 님`, h('button', { class: 'link', type: 'button', on: { click: () => void renameSelf() } }, uiText('별명 바꾸기')))
          : h('span', { class: 'muted' }, uiText('이름은 처음 요청이나 댓글을 남길 때 물어볼게요')),
      ),
    );
    const l = panel.querySelector('.list');
    if (l) l.scrollTop = keepScroll;
  }

  async function renameSelf() {
    if (!await askName(true)) return;
    await refresh();
    toast(uiText('별명을 바꿨어요'));
  }

  function togglePanel(open = !panelOpen) {
    panelOpen = open;
    panel.classList.toggle('hide', !open);
    if (open) {
      unread = 0;
      if (!filterChosen) { filter = requests.some(pageIsCurrent) ? 'page' : 'all'; }
      closeThread();
      delete panel.dataset.sig;
      renderPanel();
      void refresh();
    }
    renderBar();
  }

  function openRequest(r: Req) {
    togglePanel(false);
    if (!pageIsCurrent(r)) { openThread(r.id); return; }
    const el = r.selector ? findBySelector(r.selector) : null;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.setTimeout(() => { syncMarkers(); openThread(r.id); pulse(r.id); }, el ? 450 : 0);
  }

  function pulse(id: string) {
    layoutMarkers();
    const m = markerEls.get(id);
    if (m) { m.classList.remove('pulse'); void m.offsetWidth; m.classList.add('pulse'); }
  }

  // ── 대화(핀에 붙는 말풍선) ──
  // 한 지점(핀)에 여러 사람이 댓글을 주고받는다. 핀을 누르면 그 자리에 대화창이 열리고,
  // 열려 있는 동안은 짧은 간격(THREAD_POLL_MS)으로 새 댓글을 받아 와서 채팅처럼 이어진다.
  interface ThreadState {
    id: string;
    el: HTMLElement;
    head: HTMLElement;
    more: HTMLElement;
    scroll: HTMLElement;
    msgs: HTMLElement;
    newer: HTMLButtonElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
    sig: string;
    shot: string | null;
    moreOpen: boolean;
    editing: boolean;
    editInput: HTMLTextAreaElement | null;
    olderLoaded: boolean;
    loadingOlder: boolean;
    confirmDelete: boolean;
    msgCount: number;
  }
  let thread: ThreadState | null = null;
  let detail: Detail | null = null;
  let detailSeq = 0;
  let threadTimer = 0;
  /** 보내지 않고 닫은 답글 초안(요청 id 별). 대화창을 닫았다 열어도 쓰던 글이 남는다 */
  const drafts = new Map<string, string>();
  const replyMutations = new Map<string, ReturnType<typeof pendingMutation>>();

  /** 화면에 보이는 것이 하나라도 바뀌면 달라지는 값. 같으면 다시 그리지 않는다(캡처 이미지가 깜빡이지 않게). */
  const threadSig = (d: Detail) => [d.author, d.status, d.updatedAt, d.body, d.resolutionNote, d.comments.map((c) => c.id).join(',')].join('|');

  function acceptDetail(t: ThreadState, next: Detail) {
    if (detail?.id === next.id && t.olderLoaded) {
      next = { ...next, comments: mergeComments(detail.comments, next.comments), commentsBefore: detail.commentsBefore };
    }
    return next;
  }

  function openThread(id: string) {
    closeThread();
    if (!replyMutations.has(id)) replyMutations.set(id, pendingMutation());
    const mutation = replyMutations.get(id)!;
    const input = h('textarea', { placeholder: uiText('답글을 남겨 보세요'), rows: 1, maxLength: 1000, 'aria-label': uiText('댓글') });
    const send = h('button', { class: 'btn primary sm', type: 'button' }, uiText('보내기'));
    const head = h('div', { class: 'thead' });
    const more = h('div', { class: 'tmore hide' });
    const msgs = h('div', { class: 'thread' });
    const scroll = h('div', { class: 'tscroll' }, msgs);
    const newer = h('button', { class: 'newer hide', type: 'button' }, uiText('새 댓글 ↓'));
    const el = h('div', { class: 'tpop card', role: 'dialog', 'aria-label': uiText('대화') }, head, more, scroll, newer, h('div', { class: 'compose' }, input, send));
    const t: ThreadState = { id, el, head, more, scroll, msgs, newer, input, send, sig: '', shot: null, moreOpen: false, editing: false, editInput: null, olderLoaded: false, loadingOlder: false, confirmDelete: false, msgCount: 0 };
    thread = t;
    detail = null;
    tab.set(openKey, id); // 같은 탭에서 새로고침하면 대화를 다시 연다.
    const draft = drafts.get(id);
    if (draft) { input.value = draft; window.setTimeout(() => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 110)}px`; }, 0); }

    const submit = async () => {
      const submitted = input.value;
      const text = submitted.trim();
      if (!text || send.disabled) return;
      send.disabled = true;
      try {
        if (!(await askName())) return;
        detailSeq++;
        const r = await call<{ request: Detail }>(`/requests/${id}/comments`, { method: 'POST', body: mutation.body({ body: text }) });
        mutation.done();
        // 전송을 기다리는 사이 쓴 다음 답글은 지우지 않는다.
        if (input.value === submitted) { input.value = ''; input.style.height = ''; }
        if (drafts.get(id) === submitted) drafts.delete(id);
        if (thread !== t) return;
        detail = acceptDetail(t, r.request);
        t.sig = threadSig(detail);
        remember(detail);
        paintThread(true);
        void refresh();
      } catch (e) {
        if (isEnded(e)) { endSession(); return; }
        toast(e instanceof Error ? e.message : uiText('댓글을 남기지 못했어요'));
      } finally { send.disabled = false; }
    };
    send.addEventListener('click', () => void submit());
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 110)}px`; });
    // 한글 조합 중에는 Enter 를 무시한다(조합이 끝날 때 keydown 이 한 번 더 들어와 중복 등록되는 문제).
    onKey(input, (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); closeThread(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
    });
    newer.addEventListener('click', () => { scroll.scrollTop = scroll.scrollHeight; newer.classList.add('hide'); });
    scroll.addEventListener('scroll', () => { if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40) newer.classList.add('hide'); }, { passive: true });

    overlay.append(el);
    // 목록에서 이미 아는 내용으로 먼저 그려 두고, 자세한 내용은 받아 와서 채운다.
    const row = requests.find((r) => r.id === id);
    if (row) {
      head.append(h('span', { class: 'no' }, `#${row.no}`), statusChip(row.status));
      msgs.append(h('div', { class: 'cm first' }, avatar(row.author, 'sm'), h('div', { class: 'cbub' }, h('div', { class: 'dbody' }, row.body))), h('div', { class: 'muted' }, uiText('불러오는 중…')));
    }
    placeThread();
    layoutMarkers();
    void loadThread(id);
    threadTimer = window.setInterval(() => { if (!document.hidden && mode === 'idle' && thread === t) void loadThread(id, true); }, THREAD_POLL_MS);
    window.setTimeout(() => { if (thread === t && !input.value) input.focus({ preventScroll: true }); }, 60);
  }

  function closeThread() {
    if (!thread) return;
    tab.del(openKey);
    window.clearInterval(threadTimer);
    if (thread.input.value.trim()) drafts.set(thread.id, thread.input.value); else drafts.delete(thread.id);
    thread.el.remove();
    thread = null;
    detail = null;
    detailSeq++;
    layoutMarkers();
  }

  async function loadThread(id: string, quiet = false) {
    const my = ++detailSeq;
    const t = thread;
    try {
      const r = await call<{ request: Detail }>(`/requests/${id}`);
      if (my !== detailSeq || !t || thread !== t) return;
      detail = acceptDetail(t, r.request);
      remember(detail);
      const sig = threadSig(detail);
      if (sig !== t.sig) { t.sig = sig; paintThread(); }
    } catch (e) {
      if (my !== detailSeq || !t || thread !== t) return;
      if (isEnded(e)) { endSession(); return; }
      if (e instanceof ApiError && e.status === 404) { toast(uiText('이 요청은 지워졌어요')); closeThread(); void refresh(); return; }
      if (!quiet && !detail) { clear(t.msgs); t.msgs.append(h('div', { class: 'muted' }, uiText('불러오지 못했어요. 잠시 뒤에 다시 열어 주세요.'))); }
    }
  }

  /** 핀 옆에 놓는다. 핀이 화면 밖이면(위치를 못 찾거나 스크롤로 벗어남) 오른쪽 아래에 붙여 둔다. 하단 막대와는 겹치지 않게 한다. */
  function placeThread() {
    if (!thread) return;
    const el = thread.el;
    const m = markerEls.get(thread.id);
    const docked = !m || m.style.display === 'none' || innerWidth < 560;
    el.classList.toggle('dock', docked);
    const barBox = bar.classList.contains('hide') ? null : bar.getBoundingClientRect();
    if (docked) { el.style.left = ''; el.style.top = ''; el.style.maxHeight = ''; return; }
    const x = parseFloat(m.style.left);
    const y = parseFloat(m.style.top);
    const w = Math.min(344, innerWidth - 16);
    let left = x + 22;
    if (left + w > innerWidth - 8) left = Math.max(8, x - w - 22);
    // 막대와 가로로 겹치는 자리면 막대 위까지만 쓴다
    let bottomLimit = innerHeight - 8;
    if (barBox && left < barBox.right && left + w > barBox.left) bottomLimit = barBox.top - 8;
    el.style.maxHeight = `${Math.max(200, Math.min(540, innerHeight * 0.72, bottomLimit - 8))}px`;
    const ph = el.offsetHeight || 380;
    let top = y - 26;
    if (top + ph > bottomLimit) top = bottomLimit - ph;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }

  async function setStatus(status: string) {
    const t = thread;
    if (!detail || !t) return;
    if (!(await askName())) return;
    try {
      detailSeq++;
      const r = await call<{ request: Detail }>(`/requests/${detail.id}`, { method: 'PATCH', body: { status } });
      if (thread !== t) return;
      detail = acceptDetail(t, r.request);
      t.sig = threadSig(detail);
      remember(detail);
      paintThread(true);
      void refresh();
      toast(status === '완료' ? uiText('해결로 표시했어요 ✅ 모두에게 보여요') : status === '재발생' ? uiText('다시 열었어요') : en ? `Status changed to ${statuses[status] ?? status}.` : `${statuses[status] ?? status}(으)로 바꿨어요`);
    } catch (e) {
      if (isEnded(e)) { endSession(); return; }
      toast(e instanceof Error ? e.message : uiText('상태를 바꾸지 못했어요'));
    }
  }

  function paintThread(scrollEnd = false) {
    const t = thread;
    if (!t || !detail || detail.id !== t.id) return;
    const d = detail;
    const { head, more, msgs, scroll } = t;
    const wasAtEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    const prevTop = scroll.scrollTop;
    // 머리·더 보기를 다시 그리면 누른 버튼이 사라져 키보드 포커스가 body 로 떨어진다. 같은 버튼으로 돌려 놓는다.
    const focused = shadow.activeElement as HTMLElement | null;
    const editingFocus = focused === t.editInput && t.editInput !== null;
    const refocus = focused && (head.contains(focused) || more.contains(focused)) ? focused.getAttribute('aria-label') : null;
    clear(head);
    clear(more);
    clear(msgs);

    const done = d.status === '완료';
    // 머리: 번호·상태 / 해결(되돌리기) / 더 보기 / 닫기. 입력창은 다시 만들지 않으므로 쓰던 글이 사라지지 않는다.
    head.append(
      h('span', { class: 'no' }, `#${d.no}`),
      statusChip(d.status),
      h('div', { class: 'status' },
        done
          ? h('button', { class: 'btn warn sm', type: 'button', on: { click: () => void setStatus('재발생') } }, uiText('↩︎ 다시 열기'))
          : h('button', { class: 'btn ok sm', type: 'button', on: { click: () => void setStatus('완료') } }, uiText('✅ 해결'))),
      h('button', { class: 'x', type: 'button', 'aria-label': uiText('더 보기'), 'aria-expanded': String(t.moreOpen), on: { click: () => { t.moreOpen = !t.moreOpen; paintThread(); } } }, '⋯'),
      h('button', { class: 'x', type: 'button', 'aria-label': uiText('닫기'), on: { click: () => closeThread() } }, '✕'),
    );

    // 더 보기: 다른 상태로 바꾸기 · 내 요청 고치기/지우기 · 남긴 환경
    more.classList.toggle('hide', !t.moreOpen);
    if (t.moreOpen) {
      const chips = (['접수', '진행', '보류'] as const).filter((s) => s !== d.status);
      more.append(h('div', { class: 'row' }, h('span', { class: 'muted' }, uiText('상태')), ...chips.map((s) => h('button', { class: 'chip', type: 'button', on: { click: () => void setStatus(s) } }, statuses[s]!))));
      const dev = d.viewportW ? deviceClass(d.viewportW) : null;
      more.append(h('div', { class: 'row' },
        h('span', { class: 'tagx' }, pathOf(d.pageUrl)),
        dev ? h('span', { class: 'tagx' }, en ? `Submitted from ${devices[dev]}` : `${devices[dev]}에서 남김`) : null,
        d.textHint ? h('span', { class: 'tagx hint' }, `“${d.textHint}”`) : null));
      if (d.mine) {
        more.append(t.confirmDelete
          ? h('div', { class: 'danger' }, uiText('이 요청을 지울까요? 캡처와 댓글도 함께 지워져요.'),
            h('button', { class: 'btn danger sm', type: 'button', on: { click: async () => {
              try { await call(`/requests/${d.id}`, { method: 'DELETE' }); toast(uiText('요청을 지웠어요')); closeThread(); await refresh(); }
              catch (e) { toast(e instanceof Error ? e.message : uiText('지우지 못했어요')); }
            } } }, uiText('지우기')),
            h('button', { class: 'btn sm', type: 'button', on: { click: () => { t.confirmDelete = false; paintThread(); } } }, uiText('아니요')))
          : h('div', { class: 'own' },
            h('button', { class: 'link', type: 'button', on: { click: () => { t.editing = true; t.moreOpen = false; paintThread(); } } }, uiText('내용 고치기')),
            h('button', { class: 'link', type: 'button', on: { click: () => { t.confirmDelete = true; paintThread(); } } }, uiText('지우기'))));
      }
    }

    // 첫 말풍선 = 핀을 꽂은 사람의 요청. 캡처 주소는 서명이 매번 달라지므로 처음 받은 것을 계속 쓴다(깜빡임 방지).
    t.shot ??= d.screenshotUrl ?? d.thumbUrl;
    const first = h('div', { class: `cm first${d.mine ? ' mine' : ''}` },
      avatar(d.author, 'sm'),
      h('div', { class: 'cbub' },
        h('div', { class: 'cwho' }, h('b', null, nameFor(d.author, d.mine)), h('span', { class: 'time', 'data-at': d.createdAt }, ago(d.createdAt)), h('span', { class: 'tagx' }, `${KIND_EMOJI[d.kind] ?? ''} ${kindLabel(d.kind)}`)),
        ...(t.editing && d.mine ? [editBox(d, t)] : [h('div', { class: 'dbody' }, d.body)]),
        d.asIs || d.toBe ? h('div', { class: 'astobe' }, d.asIs ? h('div', null, h('small', null, uiText('지금')), d.asIs) : null, d.toBe ? h('div', null, h('small', null, uiText('이렇게')), d.toBe) : null) : null,
        t.shot && d.proposalUrl ? h('div', { class: 'shot-pair', 'aria-label': uiText('위치 변경 전후 비교') },
          h('figure', null, h('figcaption', null, uiText('현재 화면')), shotLink(t.shot, d.screenshotUrl ?? t.shot)),
          h('figure', null, h('figcaption', null, uiText('제안 화면')), shotLink(d.proposalUrl, d.proposalUrl, uiText('제안된 위치의 화면')))) :
          t.shot ? shotLink(t.shot, d.screenshotUrl ?? t.shot) : null,
        d.resolutionNote ? h('div', { class: 'note' }, h('b', null, uiText('담당자 메모 ')), d.resolutionNote) : null));
    msgs.append(first);

    if (d.commentsBefore) msgs.append(h('button', { class: 'btn sm', type: 'button', disabled: t.loadingOlder, on: { click: async () => {
      if (t.loadingOlder || !detail?.commentsBefore) return;
      t.loadingOlder = true;
      try {
        const page = await call<Pick<Detail, 'comments' | 'commentsBefore'>>(`/requests/${t.id}/comments?before=${detail.commentsBefore}`);
        if (thread !== t || !detail) return;
        detail.comments = mergeComments(page.comments, detail.comments);
        detail.commentsBefore = page.commentsBefore;
        t.olderLoaded = true;
        t.sig = threadSig(detail);
      } catch (e) { toast(e instanceof Error ? e.message : uiText('이전 대화를 불러오지 못했어요')); }
      finally { t.loadingOlder = false; if (thread === t) paintThread(); }
    } } }, uiText('이전 대화 보기')));

    // 이어지는 대화(댓글 + 상태 변경 기록)
    let replies = 0;
    for (const c of d.comments) {
      if (c.type === 'system') {
        msgs.append(h('div', { class: 'sys' }, en ? `${who(c.author)} ${systemComment(locale, c.body)}` : `${who(c.author)}이 ${c.body}`, h('span', { 'data-at': c.createdAt }, ago(c.createdAt))));
        continue;
      }
      replies++;
      msgs.append(h('div', { class: `cm${c.mine ? ' mine' : ''}${c.type === 'agency' ? ' agency' : ''}` },
        avatar(c.author, 'sm'),
        h('div', { class: 'cbub' },
          h('div', { class: 'cwho' }, h('b', null, nameFor(c.author, c.mine)), c.type === 'agency' ? h('span', { class: 'badge' }, uiText('담당자')) : null, h('span', { class: 'time', 'data-at': c.createdAt }, ago(c.createdAt))),
          h('div', { class: 'ctext' }, c.body))));
    }
    if (!replies) msgs.append(h('div', { class: 'muted hint0' }, uiText('첫 답글을 남겨 보세요. 같은 핀을 보는 모두에게 바로 보여요.')));

    const grew = replies > t.msgCount && t.msgCount > 0;
    t.msgCount = replies;
    if (scrollEnd || wasAtEnd) { scroll.scrollTop = scroll.scrollHeight; t.newer.classList.add('hide'); }
    else { scroll.scrollTop = prevTop; if (grew) t.newer.classList.remove('hide'); }
    if (refocus) t.el.querySelector<HTMLElement>(`[aria-label="${refocus}"]`)?.focus({ preventScroll: true });
    if (editingFocus) t.editInput?.focus({ preventScroll: true });
    placeThread();
  }

  function editBox(d: Detail, t: ThreadState): HTMLElement {
    const ta = t.editInput ?? h('textarea', { rows: 3, maxLength: 2000, class: 'editta', 'aria-label': uiText('요청 내용 수정') });
    if (!t.editInput) {
      ta.value = d.body;
      t.editInput = ta;
      window.setTimeout(() => ta.focus(), 20);
    }
    return h('div', null, ta, h('div', { class: 'actions' },
      h('button', { class: 'btn sm', type: 'button', on: { click: () => { t.editing = false; t.editInput = null; paintThread(); } } }, uiText('취소')),
      h('button', { class: 'btn primary sm', type: 'button', on: { click: async () => {
        const body = ta.value.trim();
        if (!body) return;
        try {
          detailSeq++;
          const r = await call<{ request: Detail }>(`/requests/${d.id}`, { method: 'PATCH', body: { body } });
          if (thread !== t) return;
          detail = acceptDetail(t, r.request); t.editing = false; t.editInput = null; t.sig = threadSig(detail); remember(detail); paintThread(); void refresh(); toast(uiText('내용을 고쳤어요'));
        } catch (e) { toast(e instanceof Error ? e.message : uiText('고치지 못했어요')); }
      } } }, uiText('저장'))));
  }

  function shotLink(src: string, full: string, alt = uiText('요청 당시 화면')): HTMLElement {
    const img = h('img', { src, alt, loading: 'lazy' });
    img.addEventListener('error', () => { img.replaceWith(h('div', { class: 'muted shotfail' }, uiText('이 사이트에서는 캡처 이미지를 바로 보여 줄 수 없어요. 담당자 화면에서는 볼 수 있어요.'))); });
    return h('button', { class: 'shot shot-button', type: 'button', on: { click: () => {
      const close = h('button', { class: 'btn', type: 'button', on: { click: () => zoom.remove() } }, uiText('닫기'));
      const zoom = h('div', { class: 'modal-wrap shot-zoom', role: 'dialog', 'aria-label': alt, on: { click: (e: Event) => { if (e.target === zoom) zoom.remove(); } } },
        h('div', { class: 'card' }, close, h('img', { src: full, alt })));
      onKey(close, (e) => { if (e.key === 'Escape') zoom.remove(); });
      overlay.append(zoom);
      close.focus();
    } } }, img);
  }

  // ─────────────────────────── 핀 표시 ───────────────────────────
  const markerEls = new Map<string, HTMLElement>();
  let layoutQueued = false;

  function syncMarkers() {
    const want = new Set(requests.filter(pageIsCurrent).map((r) => r.id));
    for (const [id, el] of markerEls) if (!want.has(id)) { el.remove(); markerEls.delete(id); }
    for (const r of requests) {
      if (!want.has(r.id) || markerEls.has(r.id)) continue;
      const m = h('button', { class: 'marker', type: 'button', on: { click: () => (thread?.id === r.id ? closeThread() : openThread(r.id)) } }, h('span', null, String(r.no)));
      markerEls.set(r.id, m);
      layerMarkers.append(m);
    }
    layoutMarkers();
  }

  function layoutMarkers() {
    layoutQueued = false;
    const cw = document.documentElement.clientWidth;
    // 같은 자리에 핀이 겹치면(같은 제목을 두 사람이 가리키는 흔한 일) 나중 핀이 먼저 핀을 덮어 눌러 볼 수 없다.
    // 번호 순서로 놓으면서, 앞 핀과 너무 가까우면 옆으로 조금씩 펼친다.
    const placed: { x: number; y: number }[] = [];
    for (const r of [...requests].sort((a, b) => a.no - b.no)) {
      const m = markerEls.get(r.id);
      if (!m) continue;
      if (hideDone && r.status === '완료') { m.style.display = 'none'; continue; }
      if (r.commentCount) m.setAttribute('data-rc', String(r.commentCount)); else m.removeAttribute('data-rc');
      const otherDevice = Boolean(r.viewportW) && deviceClass(r.viewportW!) !== deviceClass(cw);
      m.className = `marker st-${r.status}${otherDevice ? ' far' : ''}${r.mine ? ' mine' : ''}${m.classList.contains('pulse') ? ' pulse' : ''}${thread?.id === r.id ? ' sel' : ''}`;
      m.title = `#${r.no} ${r.author}: ${r.body.slice(0, 50)}`;
      const el = r.selector ? findBySelector(r.selector) : null;
      if (!el) { m.style.display = 'none'; continue; }
      const rc = el.getBoundingClientRect();
      if (rc.width === 0 && rc.height === 0) { m.style.display = 'none'; continue; }
      const x = rc.left + (r.offsetX ?? 0.5) * rc.width;
      const y = rc.top + (r.offsetY ?? 0.5) * rc.height;
      if (x < -20 || y < -20 || x > innerWidth + 20 || y > innerHeight + 20) { m.style.display = 'none'; continue; }
      let px = x;
      for (let k = 1; k <= 8 && placed.some((q) => Math.hypot(q.x - px, q.y - y) < 22); k++) px = x + k * 20;
      placed.push({ x: px, y });
      m.style.display = '';
      m.style.left = `${px}px`;
      m.style.top = `${y}px`;
    }
    placeThread();
  }
  const queueLayout = () => { if (!layoutQueued) { layoutQueued = true; requestAnimationFrame(layoutMarkers); } };
  window.addEventListener('scroll', queueLayout, { passive: true, capture: true });
  window.addEventListener('resize', queueLayout, { passive: true });
  let moTimer = 0;
  new MutationObserver((muts) => {
    if (muts.every((m) => isWidget(m.target))) return;
    window.clearTimeout(moTimer);
    moTimer = window.setTimeout(queueLayout, 250);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: false });

  // 한 페이지 앱: 주소가 바뀌면 그 페이지의 핀을 다시 그린다.
  const onLocation = () => { for (const ms of [0, 300, 1200]) window.setTimeout(() => { syncMarkers(); if (panelOpen) renderPanel(); }, ms); };
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = orig.apply(this, args);
      window.dispatchEvent(new Event('gp:locationchange'));
      return r;
    } as typeof history.pushState;
  }
  window.addEventListener('gp:locationchange', onLocation);
  window.addEventListener('popstate', onLocation);
  window.addEventListener('hashchange', onLocation);

  // ─────────────────────────── 새로 고침·새 소식 ───────────────────────────
  // 연결된 미리보기는 변경 신호에 맞춰 읽는다. 조회는 연결 장애에도 계속된다.
  const seen = new Map<string, { status: string; comments: number }>();
  let firstLoad = true;
  const remember = (r: Req) => seen.set(r.id, { status: r.status, comments: r.commentCount });
  let refreshing = false;
  let refreshQueued = false;
  let stopLive: (() => void) | undefined;
  let liveTimer: number | undefined;
  let livePending = false;
  let lastRefresh = 0;
  let listVersion = '';
  let lastFull = 0;
  let failures = 0;
  let offline = false;

  function announce(next: Req[], prefix = ''): boolean {
    // 새 요청 > 상태 변경 > 댓글 순으로 보여 준다(화면을 안 보는 사이 여러 일이 쌓였을 때 가장 중요한 것을 먼저)
    const events: { rank: number; text: string; r: Req }[] = [];
    const snippet = (t: string | null) => { const x = (t ?? '').replace(/\s+/g, ' ').trim(); return x.length > 46 ? `${x.slice(0, 46)}…` : x; };
    for (const r of next) {
      const prev = seen.get(r.id);
      if (!prev) { if (!r.mine && !firstLoad) events.push({ rank: 0, text: en ? `${who(r.author)} left request #${r.no}: ${snippet(r.body)}` : `${who(r.author)}이 새 요청 #${r.no}을 남겼어요: ${snippet(r.body)}`, r }); }
      else if (thread?.id === r.id) { /* 열려 있는 대화는 화면에 바로 보인다 */ }
      else if (prev.status !== r.status && r.updatedBy && r.updatedBy !== myName()) events.push({ rank: 1, text: en ? `${who(r.updatedBy)} changed #${r.no} to ${statuses[r.status] ?? r.status}.` : `${who(r.updatedBy)}이 #${r.no}을 ‘${statuses[r.status] ?? r.status}’(으)로 바꿨어요`, r });
      else if (r.commentCount > prev.comments && r.lastBy !== myName()) events.push({ rank: 2, text: `#${r.no} ${r.lastBy ?? uiText('누군가')}: ${snippet(r.lastText) || uiText('새 댓글')}`, r });
      remember(r);
    }
    for (const id of [...seen.keys()]) if (!next.some((r) => r.id === id)) seen.delete(id);
    firstLoad = false;
    if (!events.length) return false;
    events.sort((a, b) => a.rank - b.rank);
    if (!panelOpen) unread += events.length;
    const top = events[0]!;
    toast(prefix + top.text + (events.length > 1 ? en ? ` and ${events.length - 1} more` : ` 외 ${events.length - 1}건` : ''), 6000, () => openRequest(top.r));
    return true;
  }

  function queueLiveSync() {
    if (!session || mode === 'ended') return;
    livePending = true;
    if (mode !== 'idle' || document.hidden || liveTimer !== undefined) return;
    liveTimer = window.setTimeout(() => {
      liveTimer = undefined;
      if (mode !== 'idle' || document.hidden) return;
      livePending = false;
      void refresh(true);
      if (thread) void loadThread(thread.id, true);
    }, 60);
  }

  async function refresh(fromLive = false) {
    if (!session) return;
    if (refreshing) {
      refreshQueued ||= fromLive;
      return;
    }
    refreshing = true;
    try {
      // 바뀐 게 없으면 서버가 본문 없이 알린다. 5분마다는 무조건 새로 받아 캡처 주소(서명)를 갱신한다.
      const full = Date.now() - lastFull > 300_000;
      type BoardPage = { requests?: Req[]; unchanged?: boolean; version: string; nextBefore?: number | null };
      const r = await call<BoardPage>(`/requests?v=${full ? '' : encodeURIComponent(listVersion)}`);
      const next = r.requests ?? [];
      let before = r.nextBefore;
      while (before) {
        const page = await call<BoardPage>(`/requests?before=${before}`);
        next.push(...page.requests ?? []);
        before = page.nextBefore;
      }
      const firstRefresh = !lastRefresh;
      lastRefresh = Date.now();
      if (firstRefresh) notify('active');
      // 응답이 오면(변경이 없어도) 연결이 돌아온 것이다
      failures = 0;
      const recovery = offline ? uiText('다시 연결됐어요 👍') : '';
      offline = false;
      if (r.unchanged) { if (recovery) toast(recovery); if (panelOpen) renderPanel(); return; }
      requests = next;
      listVersion = r.version;
      lastFull = Date.now();
      // 복구와 새 소식이 겹치면 한 알림으로 보여 준다. 서로의 토스트를 지우지 않게 한다.
      const prefix = recovery ? recovery + ' · ' : '';
      const announced = announce(requests, prefix);
      renderBar();
      if (panelOpen) renderPanel();
      if (thread && !requests.some((x) => x.id === thread!.id)) { toast(prefix + uiText('이 요청은 지워졌어요')); closeThread(); }
      else if (recovery && !announced) toast(recovery);
      syncMarkers();
    } catch (e) {
      if (isEnded(e)) endSession();
      // 와이파이·VPN 이 잠깐 끊겨도 조용히 멈춘 것처럼 보이지 않게, 연속으로 실패하면 한 번 알려 준다(돌아오면 자동으로 이어진다).
      else if (++failures >= 2 && !offline) { offline = true; toast(uiText('검수핀 서버와 연결이 끊겼어요. 자동으로 다시 시도하고 있어요'), 5000); }
    } finally {
      refreshing = false;
      if (refreshQueued) {
        refreshQueued = false;
        queueLiveSync();
      }
    }
  }
  window.setInterval(() => { if (!document.hidden && (mode === 'idle')) void refresh(); }, POLL_MS);
  const onBack = () => {
    if (livePending) queueLiveSync();
    else if (!document.hidden && mode === 'idle' && Date.now() - lastRefresh > 2000) void refresh();
  };
  document.addEventListener('visibilitychange', onBack);
  window.addEventListener('focus', onBack);

  function endSession(msg = projectGone ? uiText('이 프로젝트의 검수가 종료됐거나 삭제됐어요. 팀장에게 확인해 주세요.') : uiText('이 링크는 더 이상 쓸 수 없어요. 링크를 보내 준 분께 새 링크를 요청해 주세요.')) {
    stopLive?.();
    stopLive = undefined;
    window.clearTimeout(liveTimer);
    liveTimer = undefined;
    livePending = false;
    notify('unavailable');
    closeThread();
    session = '';
    reviewer = null;
    mode = 'ended';
    panelOpen = false;
    panel.classList.add('hide');
    renderBar();
    clear(overlay);
    overlay.append(h('div', { class: 'modal-wrap' }, h('div', { class: 'modal card' },
      h('div', { class: 'big', 'aria-hidden': 'true' }, '🔒'),
      h('h3', null, uiText('검수가 마무리되었거나 링크가 닫혔어요')),
      h('div', { class: 'muted' }, msg),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', on: { click: () => clear(overlay) } }, uiText('확인'))))));
  }

  // ─────────────────────────── 핀 모드 ───────────────────────────
  let banner: HTMLElement | null = null;

  function pick(x: number, y: number): Element | null {
    let scope: Document | ShadowRoot = document;
    let picked: Element | null = null;
    while (true) {
      const next: Element | undefined = scope.elementsFromPoint(x, y).find(e => !isWidget(e) && e !== picked);
      if (!next) return picked;
      picked = next;
      if (!next.shadowRoot) return next;
      scope = next.shadowRoot;
    }
  }

  function label(el: Element) {
    if (touchesReviewMask(el)) return uiText('가림 영역');
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : '';
    return (tag + id + cls).slice(0, 48);
  }

  // 핀 모드에서는 화면 전체를 덮는 투명 방패가 모든 포인터 입력을 받는다.
  // (다른 도메인 iframe 위의 클릭도 받을 수 있고, 사이트의 클릭·호버 동작이 실행되지 않는다.)
  const shield = h('div', { class: 'shield', 'aria-hidden': 'true' });
  let highlighted: Element | null = null;
  const onMove = (e: MouseEvent) => {
    if (mode !== 'pin') return;
    const el = pick(e.clientX, e.clientY);
    if (!el) { hilite.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(hilite.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    if (highlighted !== el) {
      highlighted = el;
      (hilite.firstElementChild as HTMLElement).textContent = label(el);
    }
  };
  const onClickPin = (e: MouseEvent) => {
    if (mode !== 'pin') return;
    e.preventDefault();
    e.stopPropagation();
    const el = pick(e.clientX, e.clientY);
    if (!el) return;
    leavePin();
    beginCompose(el, e.clientX, e.clientY);
  };
  const onKeyPin = (e: KeyboardEvent) => { if (e.key === 'Escape' && mode === 'pin') { e.preventDefault(); e.stopPropagation(); cancelAll(); } };
  shield.addEventListener('mousemove', onMove);
  shield.addEventListener('click', onClickPin);

  function enterPin() {
    closeThread();
    if (mode !== 'idle') return;
    togglePanel(false);
    void ensureCapture();
    mode = 'pin';
    renderBar();
    banner = h('div', { class: 'banner', role: 'status' }, en ? h('span', null, '👆 Click where a change is needed') : h('span', null, '👆 고칠 곳을 ', h('b', null, '콕 찍어'), ' 주세요'), h('button', { type: 'button', on: { click: () => cancelAll() } }, uiText('취소 (Esc)')));
    overlay.append(shield, banner);
    window.addEventListener('keydown', onKeyPin, true);
  }

  function leavePin() {
    window.removeEventListener('keydown', onKeyPin, true);
    hilite.style.display = 'none';
    highlighted = null;
    shield.remove();
    banner?.remove();
    banner = null;
  }

  let disposeCompose: (() => void) | null = null;
  function cancelAll() {
    disposeCompose?.(); disposeCompose = null;
    if (mode === 'pin') leavePin();
    clear(overlay);
    layerDraft.remove();
    if (mode !== 'ended') mode = 'idle';
    renderBar();
    if (livePending) queueLiveSync();
  }

  // ─────────────────────────── 캡처 ───────────────────────────
  let captureLoad: Promise<boolean> | null = null;
  function ensureCapture(): Promise<boolean> {
    if (window.__gpCapture) return Promise.resolve(true);
    captureLoad ??= new Promise<boolean>((resolve) => {
      const s = document.createElement('script');
      const unavailable = () => { s.remove(); resolve(false); };
      s.onload = () => resolve(Boolean(window.__gpCapture));
      s.onerror = unavailable;
      try {
        s.src = `${base}/${boot.capture}`;
        s.async = true;
        document.head.append(s);
      } catch {
        unavailable();
      }
    });
    return captureLoad;
  }

  // ─────────────────────────── 요청 작성 ───────────────────────────
  const layerDraft = h('div', { class: 'draft' });

  function beginCompose(target: Element, x: number, y: number) {
    const mutation = pendingMutation();
    mode = 'compose';
    renderBar();
    const rect = target.getBoundingClientRect();
    const env = detectEnv();
    const docEl = document.documentElement;
    const big = rect.width * rect.height > innerWidth * innerHeight * 0.85;
    const draft = {
      pageUrl: normalizePageUrl(location.href),
      pageTitle: document.title.slice(0, 200),
      selector: buildSelector(target),
      textHint: textHint(target),
      offsetX: rect.width ? +((x - rect.left) / rect.width).toFixed(4) : null,
      offsetY: rect.height ? +((y - rect.top) / rect.height).toFixed(4) : null,
      pageX: Math.round(x + scrollX),
      pageY: Math.round(y + scrollY),
      viewportW: docEl.clientWidth || innerWidth,
      viewportH: innerHeight,
      scrollY: Math.round(scrollY),
      dpr: window.devicePixelRatio || 1,
      browser: env.browser,
      os: env.os,
    };

    // 핀 표시
    layerDraft.style.left = `${x}px`;
    layerDraft.style.top = `${y}px`;
    root.append(layerDraft);

    // 캡처는 클릭한 순간의 화면을 기준으로 바로 시작한다.
    const capturing: Promise<CaptureResult | null> = ensureCapture().then((ok) =>
      ok && window.__gpCapture
        ? window.__gpCapture.captureViewport({ pin: { x, y }, target: big ? null : { x: rect.left, y: rect.top, w: rect.width, h: rect.height }, proxy: { base, key, session } })
        : null,
    ).catch(() => null);

    let kind: Kind = '수정';
    let split = false;
    let submitting = false;
    let active = true;
    let previewUrl: string | null = null;
    let capture: CaptureResult | null | undefined;
    let previewReady = false;

    const needName = !myName();
    const nameInput = h('input', { type: 'text', maxLength: 30, placeholder: uiText('예: 김디자인'), autocomplete: 'name', 'aria-label': uiText('내 별명') });
    const ta = h('textarea', { placeholder: uiText('무엇을 어떻게 고치면 좋을까요?'), maxLength: 2000, rows: 3, 'aria-label': uiText('요청 내용') });
    const asIs = h('textarea', { placeholder: uiText('지금 (AS-IS)'), maxLength: 1000, rows: 2, class: 'hide' });
    const toBe = h('textarea', { placeholder: uiText('이렇게 (TO-BE)'), maxLength: 1000, rows: 2, class: 'hide' });
    const err = h('div', { class: 'err' });
    let excludeScreenshot = false;
    const exclude = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false' }, uiText('스크린샷 제외'));
    const excludeRow = h('div', { class: 'row' }, exclude);
    const thumb = h('div', { class: 'thumb' }, h('span', { class: 'spin' }), uiText('화면을 캡처하는 중…'));
    const submit = h('button', { class: 'btn primary', type: 'button' }, uiText('남기기'));
    const kindRow = h('div', { class: 'row' });
    const splitLink = h('button', { class: 'link', type: 'button' }, uiText('고치기 전/후로 나눠 쓰기'));
    const moves = positionMoves(target.closest('button,a,[role="button"]') ?? target, locale);
    let proposalOpen = false;
    const waitingForPreview = () => capture === undefined || Boolean(capture?.blob && capture.blob.size < 7_000_000 && !previewReady);
    const refreshSubmit = () => { submit.disabled = submitting || (!proposalOpen && !excludeScreenshot && waitingForPreview()); };
    exclude.addEventListener('click', () => {
      excludeScreenshot = !excludeScreenshot;
      exclude.setAttribute('aria-pressed', String(excludeScreenshot));
      refreshPreviewState();
    });
    refreshSubmit();
    let moveBusy = false;
    let disposeDrag: (() => void) | undefined;
    let proposal: { move: PositionMove; capture: CaptureResult & { blob: Blob }; url: string } | null = null;
    const moveResult = h('div', { class: 'move-result', 'aria-live': 'polite' });
    const chooseMove = h('select', { 'aria-label': uiText('제안할 위치') },
      h('option', { value: '' }, uiText('옮길 위치 선택')),
      ...moves.map((move, i) => h('option', { value: String(i) }, move.after)));
    const movePreview = h('button', { class: 'btn sm', type: 'button', disabled: true }, uiText('제안 미리보기'));
    const dragMove = h('button', { class: 'btn sm', type: 'button' }, uiText('화면에서 끌기'));
    const moveFields = h('fieldset', { class: 'move-fields hide' }, dragMove, chooseMove, movePreview, moveResult);
    const moveToggle = h('button', { class: 'link', type: 'button', 'aria-expanded': 'false' }, uiText('위치 변경 제안'));

    function clearProposal() {
      if (proposal) URL.revokeObjectURL(proposal.url);
      proposal = null;
      clear(moveResult);
    }

    chooseMove.addEventListener('change', () => {
      clearProposal();
      movePreview.disabled = !chooseMove.value;
      place();
    });
    moveToggle.addEventListener('click', () => {
      proposalOpen = !proposalOpen;
      moveToggle.setAttribute('aria-expanded', String(proposalOpen));
      moveFields.classList.toggle('hide', !proposalOpen);
      excludeRow.classList.toggle('hide', proposalOpen);
      refreshSubmit();
      if (!proposalOpen) { clearProposal(); chooseMove.value = ''; movePreview.disabled = true; }
      place();
    });
    dragMove.addEventListener('click', () => {
      if (moveBusy || submitting) return;
      pop.classList.add('hide');
      disposeDrag = startPositionDrag({
        locale,
        overlay, moves,
        shot: previewUrl ? { url: previewUrl, w: draft.viewportW, h: draft.viewportH } : undefined,
        finish: (move) => {
          disposeDrag = undefined;
          pop.classList.remove('hide');
          dragMove.focus({ preventScroll: true });
          if (move) {
            chooseMove.value = String(moves.indexOf(move));
            void previewMove(move);
          }
        },
      });
    });
    movePreview.addEventListener('click', () => {
      if (chooseMove.value) void previewMove(moves[Number(chooseMove.value)]!);
    });
    async function previewMove(move: PositionMove) {
      if (moveBusy || submitting) return;
      clearProposal();
      moveBusy = chooseMove.disabled = movePreview.disabled = moveToggle.disabled = dragMove.disabled = true;
      moveResult.textContent = uiText('제안 화면을 만드는 중…');
      try {
        const before = (await capturing)?.blob;
        if (!active) return;
        if (!before || before.size > MAX_PROPOSAL_CAPTURE_BYTES || !window.__gpCapture) {
          moveResult.textContent = uiText('현재 화면을 캡처할 수 없어요. 위치 변경 제안을 닫고 일반 요청을 남길 수 있어요.');
          return;
        }
        const cap = await window.__gpCapture.captureViewport({ move, proxy: { base, key, session } });
        if (!active) return;
        if (!cap.blob || cap.blob.size > MAX_PROPOSAL_CAPTURE_BYTES) {
          moveResult.textContent = uiText('제안 화면을 캡처할 수 없어요. 화면을 확인하고 다시 시도해 주세요.');
          return;
        }
        const url = URL.createObjectURL(cap.blob);
        proposal = { move, capture: { blob: cap.blob, notes: cap.notes }, url };
        clear(moveResult);
        moveResult.append(h('span', null, uiText('제안 화면')), shotLink(url, url, uiText('제안 화면 미리보기')));
      } catch {
        if (active) moveResult.textContent = uiText('제안 화면을 캡처할 수 없어요. 화면을 확인하고 다시 시도해 주세요.');
      } finally {
        moveBusy = chooseMove.disabled = movePreview.disabled = moveToggle.disabled = dragMove.disabled = false;
        if (active) place();
      }
    }

    const renderKinds = () => {
      clear(kindRow);
      for (const k of KINDS) kindRow.append(h('button', { class: 'chip', type: 'button', 'aria-pressed': String(k === kind), on: { click: () => { kind = k; renderKinds(); } } }, `${KIND_EMOJI[k] ?? ''} ${kindLabel(k)}`));
    };
    renderKinds();

    splitLink.addEventListener('click', () => {
      split = !split;
      asIs.classList.toggle('hide', !split);
      toBe.classList.toggle('hide', !split);
      splitLink.textContent = split ? uiText('나눠 쓰기 끄기') : uiText('고치기 전/후로 나눠 쓰기');
    });

    disposeCompose = () => {
      active = false;
      disposeDrag?.();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      clearProposal();
    };

    const previewRequired = uiText('캡처 미리보기를 기다리거나 스크린샷 제외를 선택해 주세요.');
    const refreshPreviewState = () => {
      if (err.textContent === previewRequired && (excludeScreenshot || !waitingForPreview())) err.textContent = '';
      refreshSubmit();
    };
    void capturing.then((cap) => {
      if (!active) return;
      capture = cap;
      refreshPreviewState();
      clear(thumb);
      if (!cap?.blob || cap.blob.size >= 7_000_000) {
        thumb.append(h('span', null, uiText('화면 캡처에 실패했어요. 캡처 없이 저장돼요.')));
        place();
        return;
      }
      const url = previewUrl = URL.createObjectURL(cap.blob);
      const n: CaptureNotes = cap.notes;
      const warn = n.images || n.iframes ? en ? ` (${n.images} images and ${n.iframes} frames are shown as striped areas)` : ` (이미지 ${n.images}개·프레임 ${n.iframes}개는 사선 무늬로 표시돼요)` : '';
      const image = h('img', { alt: uiText('캡처 미리보기') });
      image.addEventListener('load', () => { previewReady = true; refreshPreviewState(); }, { once: true });
      image.addEventListener('error', () => {
        capture = null;
        refreshPreviewState();
        clear(thumb);
        thumb.append(h('span', null, uiText('화면 캡처에 실패했어요. 캡처 없이 저장돼요.')));
        place();
      }, { once: true });
      const captureHint = h('span', null);
      const refreshHint = () => {
        captureHint.textContent = excludeScreenshot && !proposalOpen
          ? uiText('이 요청에 스크린샷을 첨부하지 않아요.')
          : en ? `The current view will be saved${warn}` : `지금 화면이 함께 저장돼요${warn}`;
      };
      exclude.addEventListener('click', refreshHint);
      moveToggle.addEventListener('click', refreshHint);
      refreshHint();
      thumb.append(image, captureHint);
      image.src = url;
      place();
    });

    const pop = h('div', { class: 'pop card', role: 'dialog', 'aria-label': uiText('요청 남기기') },
      h('div', { class: 'head' }, h('h3', null, uiText('📍 요청 남기기')), h('button', { class: 'x', type: 'button', 'aria-label': uiText('취소'), on: { click: () => cancelAll() } }, '✕')),
      needName ? h('label', { class: 'namef' }, h('span', null, uiText('별명 '), h('small', null, uiText('(함께 보는 분들께 표시돼요)'))), nameInput) : null,
      h('div', { class: 'split' }, ta, asIs, toBe),
      h('div', { class: 'row' }, splitLink, moves.length ? moveToggle : null),
      moves.length ? moveFields : null,
      kindRow,
      thumb,
      excludeRow,
      err,
      h('div', { class: 'actions' }, h('span', { class: 'muted' }, uiText('Enter 남기기 · Shift+Enter 줄바꿈')), submit),
    );
    overlay.append(pop);

    // 클릭 지점 옆에, 화면 밖으로 나가지 않게 놓는다.
    const place = () => {
      const w = Math.min(344, innerWidth - 16);
      const ph = pop.offsetHeight || 320;
      let left = x + 18;
      if (left + w > innerWidth - 8) left = Math.max(8, x - w - 18);
      let top = y - 20;
      if (top + ph > innerHeight - 8) top = Math.max(8, innerHeight - ph - 8);
      pop.style.left = `${left}px`;
      pop.style.top = `${Math.max(8, top)}px`;
    };
    place();
    window.setTimeout(() => (needName && !nameInput.value.trim() ? nameInput : ta).focus({ preventScroll: true }), 30);

    // 한글 조합 중에는 Enter 를 무시한다(조합이 끝날 때 keydown 이 한 번 더 들어와 중복 등록되는 문제).
    onKey(ta, (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      // 쓰던 글이 있는데 Esc 한 번에 사라지면 아프다. 글이 있으면 ✕ 로만 닫는다.
      if (e.key === 'Escape') { e.preventDefault(); if (ta.value.trim()) toast(uiText('쓰던 글이 있어요. 닫으려면 ✕ 를 눌러 주세요'), 2200); else cancelAll(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
    });
    onKey(nameInput, (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); cancelAll(); return; }
      if (e.key === 'Enter') { e.preventDefault(); ta.focus(); }
    });
    for (const t of [asIs, toBe]) onKey(t, (e) => { if (e.key === 'Escape') { e.preventDefault(); cancelAll(); } });
    submit.addEventListener('click', () => void send());

    async function send() {
      if (submitting || moveBusy) return;
      const savedProposal = proposalOpen ? proposal : null;
      if (proposalOpen && !savedProposal) { err.textContent = uiText('옮길 위치를 선택하고 제안 미리보기를 확인해 주세요'); return; }
      const name = needName ? nameInput.value.trim() : '';
      if (needName && !name) { err.textContent = uiText('별명을 알려 주세요. 누가 남겼는지 함께 보는 분들께 보여 줘요'); nameInput.focus(); return; }
      const text = ta.value.trim() || (savedProposal ? `${uiText('위치 변경 제안')} · ${savedProposal.move.after}` : '');
      if (!text) { err.textContent = uiText('내용을 입력해 주세요'); ta.focus(); return; }
      if (!savedProposal && !excludeScreenshot && waitingForPreview()) {
        err.textContent = previewRequired;
        return;
      }
      submitting = true;
      submit.disabled = exclude.disabled = true;
      moveFields.disabled = moveToggle.disabled = true;
      submit.textContent = uiText('남기는 중…');
      err.textContent = '';
      try {
        const cap = savedProposal ? await capturing : excludeScreenshot ? null : capture;
        if (!active) return;
        let screenshot: string | null = null;
        if (cap?.blob && cap.blob.size < 7_000_000) screenshot = await blobToDataUrl(cap.blob);
        const proposalScreenshot = savedProposal ? await blobToDataUrl(savedProposal.capture.blob) : null;
        const notes = cap?.notes;
        const afterNotes = savedProposal?.capture.notes;
        const res = await call<{ request: { id: string; no: number } }>('/requests', {
          method: 'POST',
          body: mutation.body({
            ...draft,
            ...(name ? { name } : {}),
            body: text,
            asIs: savedProposal?.move.before ?? (split ? asIs.value.trim() || null : null),
            toBe: savedProposal?.move.after ?? (split ? toBe.value.trim() || null : null),
            kind,
            screenshot,
            ...(proposalScreenshot ? { proposalScreenshot } : {}),
            captureNotes: notes && afterNotes ? {
              images: Math.max(notes.images, afterNotes.images),
              iframes: Math.max(notes.iframes, afterNotes.iframes),
              fonts: Math.max(notes.fonts, afterNotes.fonts),
            } : notes ?? {},
          }),
        });
        mutation.done();
        if (name && reviewer) reviewer.name = name;
        if (active) cancelAll();
        await refresh();
        syncMarkers();
        pulse(res.request.id);
        toast(en ? `Request #${res.request.no} submitted 🙌 Other reviewers will see it shortly.` : `요청 #${res.request.no}을 남겼어요 🙌 다른 분들께는 몇 초 뒤 보여요`);
      } catch (e) {
        if (isEnded(e)) { cancelAll(); endSession(); return; }
        err.textContent = e instanceof Error ? e.message : uiText('남기지 못했어요. 잠시 뒤에 다시 해 주세요');
        submitting = false;
        exclude.disabled = false;
        refreshSubmit();
        moveFields.disabled = moveToggle.disabled = false;
        submit.textContent = uiText('남기기');
      }
    }
  }

  // 대화창 바깥(사이트 화면)을 누르면 닫는다. 핀·대화창 안을 누른 것은 제외한다(핀은 스스로 열고 닫는다).
  document.addEventListener('pointerdown', (e) => { if (thread && mode === 'idle' && !isWidget(e.composedPath()[0] ?? null)) closeThread(); }, true);
  // Esc: 열린 대화창·패널 닫기
  window.addEventListener('keydown', (e) => {
    const target = e.composedPath()[0] ?? null;
    if (e.key === 'Escape' && thread && mode === 'idle' && (isWidget(target) || target === document.body || target === document.documentElement)) closeThread();
  }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelOpen && mode === 'idle' && isWidget(e.composedPath()[0] ?? null)) togglePanel(false); }, true);

  if (boot.matchesBookmark) {
    document.addEventListener('gp:wake', () => {
      if (mode === 'idle') togglePanel(true);
      else if (mode === 'ended') toast(uiText('페이지를 새로고침한 뒤 북마크를 다시 눌러 주세요.'));
    });
  }

  // ── 시작 ──
  void authenticate().catch(error => {
    console.warn('[geomsupin] init failed', error);
    notify('unavailable');
  });
}

(function boot() {
  const b = window.__gpBoot;
  if (!b) return;
  const go = () => {
    try { start(b); } catch (e) { console.warn('[geomsupin] init failed', e); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
  else go();
})();
