import { afterEach, expect, it, vi } from 'vitest';
import { fetchJson, pendingMutation } from '../shared/network.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('헤더를 받아도 본문이 오지 않으면 제한 시간 뒤 다시 시도할 수 있다', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => Promise.resolve({ text: () => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))) })));
  const result = expect(fetchJson('/test', {}, 100)).rejects.toThrow('다시 시도');
  await vi.advanceTimersByTimeAsync(101); await result;
});

it('전송 실패는 자동 재전송하지 않고 안내한다', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')); vi.stubGlobal('fetch', fetch);
  await expect(fetchJson('/test', { method: 'POST' })).rejects.toThrow('연결');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('같은 초안의 실패 후 재시도만 같은 전송 키를 사용한다', () => {
  const pending = pendingMutation();
  const a = pending.body({ body: '내용' });
  expect(pending.body({ body: '내용' }).mutationId).toBe(a.mutationId);
  pending.done();
  expect(pending.body({ body: '내용' }).mutationId).not.toBe(a.mutationId);
  const b = pending.body({ body: '다른 내용' });
  expect(b.mutationId).toMatch(/^[a-f0-9]{32}$/);
  expect(b.mutationId).not.toBe(a.mutationId);
});
