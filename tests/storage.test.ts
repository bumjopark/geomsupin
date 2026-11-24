import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedUrl } from '../server/storage.ts';
import { verifyFileSig } from '../server/security.ts';

const SECRET = 'test-secret-test-secret-test-secret-1234';
const KEY = 'captures/2026/10/11111111-2222-3333-4444-555555555555-thumb.jpg';
const parse = (u: string) => { const x = new URL(u); return { exp: Number(x.searchParams.get('exp')), sig: x.searchParams.get('sig')! }; };

afterEach(() => { vi.useRealTimers(); });

describe('서명 주소', () => {
  it('같은 시간 구간 안에서는 같은 주소가 나온다 (주기적으로 목록을 받아도 썸네일이 다시 내려받아지지 않는다)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:05Z'));
    const a = signedUrl('https://x.test', SECRET, KEY, 3600);
    vi.setSystemTime(new Date('2026-10-01T10:00:17Z')); // 폴링 한 번 뒤
    expect(signedUrl('https://x.test', SECRET, KEY, 3600)).toBe(a);
    vi.setSystemTime(new Date('2026-10-01T10:14:00Z')); // 구간(15분) 안
    expect(signedUrl('https://x.test', SECRET, KEY, 3600)).toBe(a);
  });

  it('유효 시간은 항상 ttl 이상이고, 서명은 그 만료 시각으로 검증된다', () => {
    for (const ttl of [3600, 86400, 30 * 86400]) {
      for (const at of ['2026-10-01T10:00:00Z', '2026-10-01T10:14:59Z', '2026-10-01T23:59:59Z']) {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(at));
        const now = Math.floor(Date.now() / 1000);
        const { exp, sig } = parse(signedUrl('https://x.test', SECRET, KEY, ttl));
        expect(exp).toBeGreaterThanOrEqual(now + ttl);
        expect(exp).toBeLessThanOrEqual(now + ttl + 3600);
        expect(verifyFileSig(SECRET, KEY, exp, sig)).toBe(true);
        expect(verifyFileSig(SECRET, KEY, exp + 1, sig)).toBe(false);
        vi.useRealTimers();
      }
    }
  });

  it('구간이 지나면 새 주소가 나온다(영원히 같은 주소가 아니다)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
    const a = signedUrl('https://x.test', SECRET, KEY, 3600);
    vi.setSystemTime(new Date('2026-10-01T11:30:00Z'));
    expect(signedUrl('https://x.test', SECRET, KEY, 3600)).not.toBe(a);
  });
});
