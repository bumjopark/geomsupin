import { textHint } from './env.ts';
import { h } from './dom.ts';
import { isInReviewMask, touchesReviewMask } from './privacy.ts';
import type { Locale } from '../shared/locale.ts';
import { widgetText } from './locale.ts';

export interface PositionMove {
  target: HTMLElement;
  reference: HTMLElement;
  side: 'before' | 'after';
  before: string;
  after: string;
}

function describes(el: HTMLElement, index: number, locale: Locale) {
  const fallback = el.id || el.tagName.toLowerCase();
  const name = touchesReviewMask(el) ? widgetText(locale, '가림 영역') : el.getAttribute('aria-label') || textHint(el) || fallback;
  return locale === 'en' ? `Item ${index + 1} · ${name.slice(0, 80)}` : `${index + 1}번째 · ${name.slice(0, 80)}`;
}

export function positionMoves(element: Element, locale: Locale = 'ko'): PositionMove[] {
  const target = element instanceof HTMLElement ? element : null;
  const parent = target?.parentElement;
  if (!target || !parent || target.getRootNode() !== document || parent === document.body || parent.closest('dialog') || isInReviewMask(target)) return [];
  if (!['block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'flow-root'].includes(getComputedStyle(parent).display)) return [];
  const siblings = Array.from(parent.children).filter((el): el is HTMLElement => {
    if (!(el instanceof HTMLElement) || el.hasAttribute('data-gp-widget') || isInReviewMask(el)) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return ['static', 'relative'].includes(style.position) && style.order === '0'
      && style.gridColumnStart === 'auto' && style.gridRowStart === 'auto'
      && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  });
  const index = siblings.indexOf(target);
  if (index < 0) return [];
  return siblings.flatMap((reference, i) => {
    if (reference === target) return [];
    const side = i < index ? 'before' : 'after';
    const referenceName = describes(reference, i, locale);
    const after = locale === 'en'
      ? `${side === 'before' ? 'Before' : 'After'} ${referenceName}`
      : `${referenceName} ${side === 'before' ? '앞으로' : '뒤로'}`;
    return [{ target, reference, side, before: describes(target, index, locale), after }];
  });
}

export function startPositionDrag({ overlay, moves, shot, finish, locale = 'ko' }: {
  locale?: Locale;
  overlay: HTMLElement;
  moves: PositionMove[];
  shot?: { url: string; w: number; h: number };
  finish: (move: PositionMove | null) => void;
}) {
  const target = moves[0]!.target;
  const surface = h('div', { class: 'shield move-surface', 'aria-hidden': 'true' });
  const source = h('div', { class: 'move-source' });
  const destination = h('div', { class: 'move-destination hide' });
  const ghost = h('div', { class: 'move-ghost hide' });
  const hint = h('span', null, widgetText(locale, '선택한 요소를 같은 묶음의 다른 요소까지 끌어 놓으세요.'));
  const cancel = h('button', { type: 'button', on: { click: () => done(null) } }, widgetText(locale, '끌기 취소'));
  const banner = h('div', { class: 'banner move-banner', role: 'status' }, hint, cancel);
  surface.append(source, destination, ghost);
  overlay.append(surface, banner);
  cancel.focus({ preventScroll: true });

  const initial = target.getBoundingClientRect();
  let grab: { x: number; y: number } | null = null;
  const box = (el: HTMLElement, x: number, y: number, w: number, h: number) => {
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  };
  box(source, initial.left, initial.top, initial.width, initial.height);
  if (shot) {
    ghost.style.backgroundImage = `url("${shot.url}")`;
    ghost.style.backgroundSize = `${shot.w}px ${shot.h}px`;
    ghost.style.backgroundPosition = `-${initial.left}px -${initial.top}px`;
  } else {
    ghost.textContent = moves[0]!.before;
  }

  const contains = (rect: DOMRect, e: MouseEvent) => e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  const findMove = (e: MouseEvent) => moves.find(move => move.reference.isConnected && move.reference.parentElement === target.parentElement && contains(move.reference.getBoundingClientRect(), e));
  const reset = () => {
    grab = null;
    surface.classList.remove('dragging');
    destination.classList.add('hide');
    ghost.classList.add('hide');
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
  };
  function cleanup() {
    window.removeEventListener('keydown', key, true);
    surface.remove();
    banner.remove();
  }
  function done(move: PositionMove | null) {
    cleanup();
    finish(move);
  }

  surface.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !target.isConnected || !contains(initial, e)) return;
    e.preventDefault();
    grab = { x: e.clientX - initial.left, y: e.clientY - initial.top };
    surface.classList.add('dragging');
    ghost.classList.remove('hide');
    box(ghost, initial.left, initial.top, initial.width, initial.height);
  });
  surface.addEventListener('pointermove', (e) => {
    if (!grab) return;
    if (!e.buttons) { reset(); return; }
    box(ghost, e.clientX - grab.x, e.clientY - grab.y, initial.width, initial.height);
    const move = findMove(e);
    destination.classList.toggle('hide', !move);
    if (move) {
      const rect = move.reference.getBoundingClientRect();
      box(destination, rect.left, rect.top, rect.width, rect.height);
    }
    hint.textContent = move?.after ?? widgetText(locale, '같은 묶음의 다른 요소 위에 놓으세요.');
  });
  surface.addEventListener('pointerup', (e) => {
    if (!grab) return;
    const move = findMove(e);
    if (move) done(move);
    else reset();
  });
  surface.addEventListener('pointercancel', reset);
  surface.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  window.addEventListener('keydown', key, true);
  return cleanup;
}
