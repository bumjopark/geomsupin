// 현재 연결된 스테이징의 최상위 탭에서도 검수핀을 직접 실행한다.
import { normalizeLocale, type Locale } from './locale.ts';

const bookmarkLabels = {
  wrongTab: ['연결된 스테이징 사이트의 탭을 열고 이 북마크를 눌러 주세요.', 'Open the connected site in its own tab, then click this bookmark.'],
  mixedContent: ['브라우저가 보안 연결에서 HTTP 검수핀을 차단해요. 설치 관리자에게 문의해 주세요.', 'The browser blocks HTTP Geomsupin on a secure page. Contact your installation administrator.'],
  alreadyOpen: ['이 탭에서 검수핀이 이미 켜져 있어요. 페이지를 새로고침한 뒤 이 북마크를 다시 눌러 주세요.', 'Geomsupin is already open in this tab. Refresh the page, then click this bookmark again.'],
  loadFailed: ['검수핀을 불러오지 못했어요. 사이트의 보안 정책과 서버 연결을 확인해 주세요.', 'Could not load Geomsupin. Check the site’s security policy and server connection.'],
  unreadable: ['북마크 정보를 읽을 수 없어요. 초대 화면에서 북마크를 다시 만들어 주세요.', 'Could not read this bookmark. Create it again from the invitation.'],
  sessionFailed: ['검수 세션을 시작하지 못했어요. 초대 링크를 다시 확인해 주세요.', 'Could not start the review. Check your invitation link and try again.'],
  connectionFailed: ['검수핀 서버에 연결하지 못했어요. 사이트의 보안 정책과 서버 연결을 확인해 주세요.', 'Could not connect to Geomsupin. Check the site’s security policy and server connection.'],
} as const;

export function bookmarkText(locale: Locale, key: keyof typeof bookmarkLabels): string {
  return bookmarkLabels[key][locale === 'en' ? 1 : 0];
}

interface BookmarkletArgs {
  base: string;
  key: string;
  token: string;
  pid: string;
  previewId: string;
  origin: string;
  locale?: Locale;
}

export function bookmarkletSource({ base, key, token, pid, previewId, origin, locale: language }: BookmarkletArgs): string {
  const locale = normalizeLocale(language);
  const q = JSON.stringify;
  return (
    `(function(){var w=window,b=${q(base)},k=${q(key)},v=${q(previewId)},p=${q(pid)},t=${q(token)},l=${q(locale)};` +
    `if(w!==w.top||location.origin!==${q(origin)}){alert(${q(bookmarkText(locale, 'wrongTab'))});return;}` +
    `if(location.protocol==='https:'&&b.indexOf('http:')===0){alert(${q(bookmarkText(locale, 'mixedContent'))});return;}` +
    `if(w.__gpBoot){if(w.__gpBoot.matchesBookmark?.(k,v,p,t,l)){document.dispatchEvent(new Event('gp:wake'));}else{alert(${q(bookmarkText(locale, 'alreadyOpen'))});}return;}` +
    `if(w.__gpBookmarkLoading)return;w.__gpBookmarkLoading=true;` +
    `var s=document.createElement('script');s.async=true;s.referrerPolicy='no-referrer';s.src=b+'/w.js';` +
    `s.__gpBookmark={key:k,token:t,pid:p,previewId:v,locale:l};` +
    `s.onerror=function(){delete w.__gpBookmarkLoading;delete s.__gpBookmark;s.remove();alert(${q(bookmarkText(locale, 'loadFailed'))});};` +
    `try{(document.head||document.documentElement).append(s);}catch(e){s.onerror();}})()`
  );
}

export function bookmarkletHref(args: BookmarkletArgs): string {
  return 'javascript:' + encodeURIComponent(bookmarkletSource(args));
}
