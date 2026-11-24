import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { bookmarkletHref, bookmarkletSource } from '../shared/bookmarklet.ts';

const args = {
  base: 'https://review.example', origin: 'https://staging.example',
  key: 'gpk_57NM2bSdUe', token: 'bookmark_invite_secret', pid: 'persistent-reviewer-id',
  previewId: 'b78ce24e-363c-43d6-b64d-783b69d3ccf0',
};

function tab(origin = args.origin, boot?: { matchesBookmark: (...args: string[]) => boolean }) {
  const window = { top: undefined as unknown, __gpBoot: boot };
  window.top = window;
  const script = { remove: vi.fn(), onerror: () => {} };
  const document = {
    head: { append: vi.fn() },
    createElement: vi.fn(() => script),
    dispatchEvent: vi.fn(),
  };
  const alert = vi.fn();
  const run = (values: Parameters<typeof bookmarkletSource>[0] = args) => runInNewContext(bookmarkletSource(values), {
    window, document, alert, Event, location: new URL(origin),
  });
  return { alert, run, document, script, window };
}

it('연결된 탭에서만 로더를 경유하고 주소로 초대 정보를 전송하지 않는다', () => {
  const here = tab();
  expect(bookmarkletHref(args)).toBe('javascript:' + encodeURIComponent(bookmarkletSource(args)));
  expect(here.run()).toBeUndefined();
  expect(here.document.head.append).toHaveBeenCalledWith(expect.objectContaining({
    src: args.base + '/w.js', referrerPolicy: 'no-referrer',
  }));
  expect(here.alert).not.toHaveBeenCalled();
  here.script.onerror();
  expect(here.script.remove).toHaveBeenCalled();
  expect(here.script).not.toHaveProperty('__gpBookmark');

  const foreign = tab('https://other.example');
  foreign.run();
  expect(foreign.document.createElement).not.toHaveBeenCalled();
  expect(foreign.alert).toHaveBeenCalledWith(expect.stringContaining('등록한 사이트'));
});

it('실행 중인 링크만 다시 열고 다른 링크에는 새로고침을 안내한다', () => {
  const current = tab(args.origin, { matchesBookmark: (_key, _preview, _pid, token) => token === args.token });
  current.run();
  expect(current.document.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'gp:wake' }));
  current.run({ ...args, token: 'replacement_invite_token' });
  expect(current.document.dispatchEvent).toHaveBeenCalledTimes(1);
  expect(current.document.createElement).not.toHaveBeenCalled();
  expect(current.alert).toHaveBeenCalledWith(expect.stringContaining('새로고침'));
});

it('북마크에 선택한 영어를 전달하고 안내문에도 사용한다', () => {
  const here = tab();
  here.run({ ...args, locale: 'en' });
  expect(here.document.head.append).toHaveBeenCalledWith(expect.objectContaining({
    __gpBookmark: expect.objectContaining({ locale: 'en' }),
  }));
  const foreign = tab('https://other.example');
  foreign.run({ ...args, locale: 'en' });
  expect(foreign.alert).toHaveBeenCalledWith(expect.stringContaining('registered site'));
});


it.each(['trusted script URL', 'script append'])('%s 실패 안내 후 같은 탭에서 다시 시도할 수 있다', (failure) => {
  const here = tab();
  if (failure === 'trusted script URL') {
    Object.defineProperty(here.script, 'src', { configurable: true, set() { throw new TypeError('TrustedScriptURL required'); } });
  } else {
    here.document.head.append.mockImplementationOnce(() => { throw new Error('Script blocked'); });
  }
  expect(() => here.run()).not.toThrow();
  expect(here.alert).toHaveBeenCalledWith(expect.stringContaining('보안 정책'));
  expect(here.window).not.toHaveProperty('__gpBookmarkLoading');
  expect(here.script).not.toHaveProperty('__gpBookmark');
  if (failure === 'trusted script URL') Reflect.deleteProperty(here.script, 'src');
  here.run();
  expect(here.document.createElement).toHaveBeenCalledTimes(2);
  expect(here.document.head.append).toHaveBeenLastCalledWith(expect.objectContaining({ src: args.base + '/w.js' }));
});

it.each(['ko', 'en'] as const)('리디렉션 안내는 실제 출처만 표시하고 www를 별도 승인 없이 허용하지 않는다 (%s)', locale => {
  const current = tab('https://www.staging.example:8443/current-private-path?token=current-private-query');
  current.run({
    ...args,
    origin: 'https://staging.example:8443/registered-private-path?token=registered-private-query',
    locale,
  });
  expect(current.document.createElement).not.toHaveBeenCalled();
  const [notice] = current.alert.mock.calls[0]!;
  expect(notice).toContain(locale === 'en' ? 'If it redirects, register the final address.' : '최종 주소를 등록해 주세요.');
  expect(notice).toContain((locale === 'en' ? 'Registered origin: ' : '등록한 출처: ') + 'https://staging.example:8443');
  expect(notice).toContain((locale === 'en' ? 'Current origin: ' : '현재 출처: ') + 'https://www.staging.example:8443');
  expect(notice).not.toContain('private-path');
  expect(notice).not.toContain('private-query');
});
