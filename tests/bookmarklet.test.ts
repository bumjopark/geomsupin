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
  return { alert, run, document, script };
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
  expect(foreign.alert).toHaveBeenCalledWith(expect.stringContaining('스테이징'));
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
  expect(foreign.alert).toHaveBeenCalledWith(expect.stringContaining('connected site'));
});
