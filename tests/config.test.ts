import { describe, expect, it } from 'vitest';
import { buildConfig } from '../server/config.ts';

const base = { PUBLIC_URL: 'http://10.0.0.8:3200', DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/d', AUTH_SECRET: 'x'.repeat(40) };

describe('사내(on-prem) 설치 설정', () => {
  it('http IP:포트 주소를 공개 주소로 쓸 수 있다: Host 허용·쿠키는 Secure 아님', () => {
    const c = buildConfig({ ...base, HOST: '0.0.0.0', PORT: '3200', ALLOWED_HOSTS: '10.0.0.5:3200' });
    expect(c.publicUrl).toBe('http://10.0.0.8:3200');
    expect(c.publicOrigin).toBe('http://10.0.0.8:3200');
    expect(c.secureCookies).toBe(false);
    expect(c.host).toBe('0.0.0.0');
    expect(c.allowedHosts.has('10.0.0.8:3200')).toBe(true); // PUBLIC_URL 의 host 는 자동 허용
    expect(c.allowedHosts.has('10.0.0.5:3200')).toBe(true);
    expect(c.allowedHosts.has('evil.example')).toBe(false);
  });
  it('https 공개 주소면 Secure 쿠키', () => {
    expect(buildConfig({ ...base, PUBLIC_URL: 'https://geomsupin.example.com' }).secureCookies).toBe(true);
  });
  it('keeps the optional peer separate from allowed hosts', () => {
    expect(buildConfig(base).peerReviewUrl).toBeNull();
    const paired = buildConfig({ ...base, PEER_REVIEW_URL: 'https://review.example:3443/' });
    expect(paired.peerReviewUrl).toBe('https://review.example:3443');
    expect(paired.allowedHosts.has('review.example:3443')).toBe(false);
  });
  it.each(['http://review.example:3080', 'javascript:alert(1)', 'https://user@review.example',
    'https://review.example/r/invite', 'https://review.example/?key=1', 'https://review.example/#manage'])(
    'rejects invalid peer %s', peer => {
      expect(() => buildConfig({ ...base, PEER_REVIEW_URL: peer })).toThrow();
    },
  );
  it('이미지 프록시의 사설 주소 허용은 기본으로 꺼져 있다(링크만 있으면 누구나 쓰는 프록시라 사내 주소를 열면 안 된다)', () => {
    expect(buildConfig(base).imageProxyAllowPrivate).toBe(false);
    expect(buildConfig({ ...base, IMAGE_PROXY_ALLOW_PRIVATE: '1' }).imageProxyAllowPrivate).toBe(true);
  });
  it('빌드 결과 폴더는 DIST_DIR 로 바꿀 수 있다(라이브 서비스를 건드리지 않고 시험할 때)', () => {
    expect(buildConfig(base).distDir.endsWith('/dist')).toBe(true);
    expect(buildConfig({ ...base, DIST_DIR: 'dist-next' }).distDir.endsWith('/dist-next')).toBe(true);
  });
});
