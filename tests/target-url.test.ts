import { describe, expect, it } from 'vitest';
import { parseTargetUrl, readTargetUrl, reviewProtocolIssue, targetUrlLabel } from '../shared/target-url.ts';

describe('검수할 주소', () => {
  it('프로토콜 불일치의 두 방향에 실제 제한 사유를 알려 준다', () => {
    expect(reviewProtocolIssue('https:', 'https:')).toBeUndefined();
    expect(reviewProtocolIssue('http:', 'http:')).toBeUndefined();
    expect(reviewProtocolIssue('https:', 'http:')).toContain('전송 중 변경');
    expect(reviewProtocolIssue('http:', 'https:')).toContain('HTTP 검수핀 로드를 차단');
  });
  it('http/https 주소를 표준 형태로 바꾸고, 빈 값은 지움이다', () => {
    expect(parseTargetUrl('  http://Staging.Example.com ')).toEqual({ ok: true, url: 'http://staging.example.com/' });
    expect(parseTargetUrl('https://a.example.com/shop?x=1#top')).toEqual({ ok: true, url: 'https://a.example.com/shop?x=1#top' });
    expect(parseTargetUrl('http://10.0.0.5:3000/')).toEqual({ ok: true, url: 'http://10.0.0.5:3000/' });
    expect(parseTargetUrl('   ')).toEqual({ ok: true, url: '' });
  });
  it('위험하거나 잘못된 주소는 한국어 안내와 함께 거절한다', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://a.example.com', 'example.com', 'localhost:3000', '//example.com', 'http://', 'http://a b.example.com', 'http://u:p@example.com', 'http://u@example.com', `http://a.example.com/${'x'.repeat(2001)}`]) {
      const r = parseTargetUrl(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/[가-힣]/);
    }
  });
  it('한글이 들어간 주소는 인코딩된 길이로 재서, 받아들인 값이 저장 뒤에도 그대로 읽힌다', () => {
    const korean = `http://staging.example.com/${'가나다라마바사아자차'.repeat(7)}가나다라마바사`; // 입력은 104자, 표준 형태는 700자 넘게 늘어난다
    const r = parseTargetUrl(korean);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url.length).toBeGreaterThan(500);
      expect(readTargetUrl(r.url)).toBe(r.url); // 받아들인 값은 반드시 다시 읽힌다(조회·초대 화면에서 빈 주소가 되면 안 된다)
      expect(targetUrlLabel(r.url)).toContain('가나다라마바사아자차'); // 보여 줄 때는 한글로 풀어 준다
    }
    // 입력은 짧아도 표준 형태가 한도를 넘으면 처음부터 거절한다(저장 뒤에 사라지지 않게)
    const tooBig = parseTargetUrl(`http://staging.example.com/${'가'.repeat(300)}`);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.message).toMatch(/너무 길어요/);
    // 어떤 입력이든 ok 면 다시 읽었을 때 같은 값이다
    for (const text of ['http://a.example.com/가', 'https://a.example.com/a b'.replace(' ', '%20'), 'http://a.example.com/?q=한글&x=1', `http://${'a'.repeat(60)}.example.com/${'가'.repeat(150)}`]) {
      const p = parseTargetUrl(text);
      if (p.ok) expect(readTargetUrl(p.url), text).toBe(p.url);
    }
  });
  it('보여 줄 이름은 길면 줄이고 한글 경로는 풀어 준다', () => {
    expect(targetUrlLabel(`http://a.example.com/${'a'.repeat(400)}`)).toHaveLength(80);
    expect(targetUrlLabel(`http://a.example.com/${'a'.repeat(400)}`).endsWith('…')).toBe(true);
    expect(targetUrlLabel('http://a.example.com/%EA%B0%80%EB%82%98')).toBe('a.example.com/가나');
    expect(targetUrlLabel('http://a.example.com/%E0%A4%A')).toBe('a.example.com/%E0%A4%A'); // 풀 수 없는 경로는 그대로
  });
  it('저장돼 있던 값은 안전할 때만 내보낸다', () => {
    expect(readTargetUrl('http://10.0.0.8:3123')).toBe('http://10.0.0.8:3123/');
    for (const bad of ['javascript:alert(1)', 'http://u:p@example.com/', '', null, undefined, '그냥 글자']) expect(readTargetUrl(bad as string), String(bad)).toBe('');
  });
  it('포트와 경로를 주소 레이블에 표시한다', () => {
    expect(targetUrlLabel('http://staging.example.com:3123/')).toBe('staging.example.com:3123');
    expect(targetUrlLabel('https://a.example.com/shop/list')).toBe('a.example.com/shop/list');
  });
});
