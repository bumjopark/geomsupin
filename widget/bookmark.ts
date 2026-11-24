import { bookmarkText } from '../shared/bookmarklet.ts';
import { normalizeLocale, type Locale } from '../shared/locale.ts';
import { fetchJson } from '../shared/network.ts';

declare global {
  interface Window {
    __gpBookmarkLoading?: boolean;
  }
  interface HTMLScriptElement {
    __gpBookmark?: { key: string; token: string; pid: string; previewId: string; locale?: Locale };
  }
}

export async function startBookmark(script: HTMLScriptElement, corePath: string, capture: string) {
  const args = script.__gpBookmark;
  // 주소, DOM 속성, 사이트 저장소에 초대 토큰을 남기지 않는다.
  delete script.__gpBookmark;
  script.remove();
  if (!args || window.__gpBoot) {
    delete window.__gpBookmarkLoading;
    return;
  }
  const { key, token, pid, previewId } = args;
  const locale = normalizeLocale(args.locale);
  const base = new URL(script.src).origin;

  let boot: Window['__gpBoot'];
  const failed = (message: string) => {
    delete window.__gpBookmarkLoading;
    if (boot && window.__gpBoot === boot) delete window.__gpBoot;
    window.alert(message);
  };

  if (!key || !token || !pid || !previewId || base === location.origin) {
    failed(bookmarkText(locale, 'unreadable'));
    return;
  }

  try {
    const { response, data } = await fetchJson(`${base}/api/w/bookmark-session`, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'X-GP-Key': key },
      body: JSON.stringify({ token, pid, previewId }),
    });
    if (!response.ok || typeof data?.session !== 'string' || typeof data.reviewer?.id !== 'string' || typeof data.reviewer.name !== 'string') {
      failed(locale === 'ko' && typeof data?.error?.message === 'string' ? data.error.message : bookmarkText(locale, 'sessionFailed'));
      return;
    }
    if (window.__gpBoot) {
      delete window.__gpBookmarkLoading;
      return;
    }

    boot = {
      base, key, capture, session: data.session, reviewer: data.reviewer, locale,
      matchesBookmark: (candidateKey, candidatePreview, candidatePid, candidateToken, candidateLocale) =>
        key === candidateKey && previewId === candidatePreview && pid === candidatePid && token === candidateToken && locale === normalizeLocale(candidateLocale),
      notify: () => {},
    };
    window.__gpBoot = boot;
    const core = document.createElement('script');
    const loadFailed = () => {
      core.remove();
      failed(bookmarkText(locale, 'loadFailed'));
    };
    core.onload = () => { delete window.__gpBookmarkLoading; };
    core.onerror = loadFailed;
    try {
      core.src = `${base}/${corePath}`;
      core.referrerPolicy = 'no-referrer';
      core.async = true;
      (document.head || document.documentElement).append(core);
    } catch {
      loadFailed();
    }
  } catch {
    failed(bookmarkText(locale, 'connectionFailed'));
  }
}
