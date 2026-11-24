/** 사이트의 document 캡처 리스너보다 먼저 위젯 클릭을 처리한다.
 * 원래 이벤트는 사이트로 보내지 않고, ShadowRoot 안에서만 다시 전달한다.
 * click 기본 동작(폼 제출·링크 등)이 두 번 실행되지 않도록 원본은 취소한다.
 * mousedown의 실제 포커스·선택 동작은 원본 브라우저 이벤트에 맡긴다.
 */
export function isolatePointerEvents(isWidget: (node: EventTarget | null) => boolean) {
  for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'contextmenu']) {
    window.addEventListener(type, event => {
      const target = event.composedPath()[0];
      if (!(target instanceof Element) || !isWidget(target)) return;
      event.stopPropagation();
      if (type === 'click') event.preventDefault();
      const mouse = event as MouseEvent;
      const init: MouseEventInit = { bubbles: true, cancelable: true, composed: false, view: window,
        detail: mouse.detail, screenX: mouse.screenX, screenY: mouse.screenY, clientX: mouse.clientX, clientY: mouse.clientY,
        ctrlKey: mouse.ctrlKey, altKey: mouse.altKey, shiftKey: mouse.shiftKey, metaKey: mouse.metaKey,
        button: mouse.button, buttons: mouse.buttons, relatedTarget: mouse.relatedTarget };
      const local = event instanceof MouseEvent ? new MouseEvent(type, init) : new Event(type, init);
      if (!target.dispatchEvent(local)) event.preventDefault();
    }, { capture: true, passive: false });
  }
}
