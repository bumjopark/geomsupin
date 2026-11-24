import { activeElement, matches, modalDialogs, pageRoots } from './page-dom.ts';

/** 네이티브 모달의 inert 영역을 벗어나고 조상 transform/overflow에도 잘리지 않게 한다. */
export function mountHost(host: HTMLElement, shadow: ShadowRoot) {
  const roots = new Set<Document | ShadowRoot>();
  let stack: HTMLDialogElement[] = [];
  let focusContainer: HTMLElement | null = null;
  let moving = false;
  let recovering = false;
  let pointing = false;
  let deferredFocus: HTMLElement | null = null;
  let releaseTimer = 0;
  const promote = (dialog: HTMLDialogElement) => { stack = stack.filter(d => d !== dialog); stack.push(dialog); };
  const observer = new MutationObserver(records => {
    let changed = !host.isConnected || !!focusContainer && !focusContainer.isConnected;
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target instanceof HTMLDialogElement || r.target === focusContainer) changed = true;
      } else for (const node of [...r.addedNodes, ...r.removedNodes]) {
        if (!(node instanceof Element) || node === host || node.getRootNode() === shadow) continue;
        if (node.matches('dialog') || node.querySelector('dialog')) changed = true;
        for (const root of pageRoots(node)) { observe(root); changed = true; }
      }
    }
    if (changed) sync(records);
  });
  function observe(root: Document | ShadowRoot) {
    if (roots.has(root)) return;
    roots.add(root);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden', 'style', 'class'], attributeOldValue: true });
  }
  for (const root of pageRoots()) observe(root);

  function sync(records: MutationRecord[] = []) {
    if (moving) return;
    for (const root of roots) if (root instanceof ShadowRoot && !root.host.isConnected) roots.delete(root);
    stack = stack.filter(d => d.isConnected && matches(d, ':modal'));
    for (const d of modalDialogs([...roots])) if (!stack.includes(d)) stack.push(d);
    for (const r of records) if (r.type === 'attributes' && r.attributeName === 'open' && r.oldValue === null && r.target instanceof HTMLDialogElement && matches(r.target, ':modal')) promote(r.target);
    const active = activeElement();
    const focused = active?.closest<HTMLDialogElement>('dialog');
    if (focused && matches(focused, ':modal') && active?.getRootNode() !== shadow) promote(focused);
    if (focusContainer && (!focusContainer.isConnected || !focusContainer.getClientRects().length)) focusContainer = null;
    const parent = stack.at(-1) ?? focusContainer ?? document.documentElement;
    const elevated = parent !== document.documentElement && typeof host.showPopover === 'function';
    const reopened = records.some(r => r.type === 'attributes' && r.attributeName === 'open' && r.target === parent && r.oldValue === null);
    if (host.parentElement === parent && !reopened && (!elevated || matches(host, ':popover-open'))) return;
    moving = true;
    const previous = shadow.activeElement instanceof HTMLElement ? shadow.activeElement : null;
    try {
      if (matches(host, ':popover-open')) host.hidePopover();
      host.removeAttribute('popover');
      parent.append(host);
      if (elevated) { host.setAttribute('popover', 'manual'); host.showPopover(); }
      previous?.focus({ preventScroll: true });
    } finally { moving = false; }
  }

  const top = document.elementFromPoint(0, 0)?.closest<HTMLDialogElement>('dialog');
  if (top && matches(top, ':modal')) promote(top);
  sync();
  window.addEventListener('focusin', event => {
    // 기존 요소에 나중에 붙인 ShadowRoot도 모달이 포커스를 받을 때 발견한다.
    for (const node of event.composedPath()) if (node instanceof ShadowRoot && node !== shadow) observe(node);
    sync();
  }, true);

  function recoverFocus(target: HTMLElement) {
    if (recovering || moving || shadow.activeElement === target || !target.isConnected) return;
    if (pointing) { deferredFocus = target; return; }
    // 먼저 등록된 window 트랩은 이벤트 차단으로 앞설 수 없다. 실제로 포커스를
    // 되돌린 컨테이너 안에 위젯을 두어 트랩의 내부 요소로 사용한다. 사이트의 focus를 패치하지 않는다.
    const redirected = activeElement();
    if (!(redirected instanceof HTMLElement) || redirected.getRootNode() === shadow) return;
    const container = redirected.closest<HTMLElement>('[role="dialog"], [aria-modal="true"]')
      ?? (redirected.matches('input,textarea,select,button,a') ? redirected.parentElement : redirected);
    if (!container || container === document.body || container === document.documentElement || host.contains(container)) return;
    recovering = true;
    try { focusContainer = container; sync(); target.focus({ preventScroll: true }); }
    finally { recovering = false; }
  }

  // mousedown 기본 포커스 처리 중 DOM을 옮기면 브라우저가 이어질 click을 취소한다.
  // 클릭 핸들러를 끝낸 뒤에만 재배치한다. Tab·프로그램 포커스는 바로 복구한다.
  const finishPointer = () => {
    pointing = false;
    const target = deferredFocus; deferredFocus = null;
    if (target) recoverFocus(target);
  };
  window.addEventListener('pointerdown', event => {
    clearTimeout(releaseTimer);
    pointing = event.composedPath().includes(host);
    deferredFocus = null;
  }, true);
  window.addEventListener('pointerup', () => {
    if (pointing) releaseTimer = window.setTimeout(finishPointer, 0);
  }, true);
  window.addEventListener('click', () => {
    if (!pointing) return;
    clearTimeout(releaseTimer);
    queueMicrotask(finishPointer);
  }, true);
  window.addEventListener('pointercancel', () => { pointing = false; deferredFocus = null; clearTimeout(releaseTimer); }, true);
  return { recoverFocus };
}
