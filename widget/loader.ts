// 스테이징의 스크립트가 초대 화면과 출처를 확인한 다음 위젯 본체를 불러온다.
import { normalizeLocale } from '../shared/locale.ts';
import { isPreviewMessage, PREVIEW_CHANNEL } from '../shared/preview.ts';
import { startBookmark } from './bookmark.ts';

declare const __CORE__: string;
declare const __CAPTURE__: string;

(function () {
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement)) return;
  if (window === window.top && script.__gpBookmark) {
    void startBookmark(script, __CORE__, __CAPTURE__);
    return;
  }
  if (window.parent === window || window.parent !== window.top || window.__gpBoot) return;
  const id = script.dataset.gpPreview;
  if (!id) return;
  const base = new URL(script.src).origin;
  if (base === location.origin) return;
  let nonce = '';

  function connect(event: MessageEvent) {
    if (event.source !== window.parent || event.origin !== base || !isPreviewMessage(event.data, id!)) return;
    const data = event.data;
    if (data.type === 'ping' && typeof data.nonce === 'string') {
      nonce = data.nonce;
      window.parent.postMessage({ channel: PREVIEW_CHANNEL, id, nonce, type: 'ready' }, base);
    }
    if (data.type !== 'start' || !nonce || data.nonce !== nonce || window.__gpBoot) return;
    if (typeof data.key !== 'string' || typeof data.session !== 'string' || typeof data.reviewer?.id !== 'string' || typeof data.reviewer.name !== 'string') return;
    window.removeEventListener('message', connect);
    const notify = (type: 'active' | 'unavailable') => window.parent.postMessage({ channel: PREVIEW_CHANNEL, id, nonce, type }, base);
    window.__gpBoot = { base, key: data.key, capture: __CAPTURE__, session: data.session, reviewer: data.reviewer, locale: normalizeLocale(data.locale), notify };

    const core = document.createElement('script');
    core.src = `${base}/${__CORE__}`;
    core.async = true;
    core.onerror = () => {
      delete window.__gpBoot;
      core.remove();
      notify('unavailable');
    };
    document.head.append(core);
  }
  window.addEventListener('message', connect);
})();
