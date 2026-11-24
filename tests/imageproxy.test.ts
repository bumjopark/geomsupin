import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns';
import sharp from 'sharp';
import { fetchPublicImage, isPublicIp, portAllowed, ProxyError } from '../server/imageproxy.ts';
import { createSite, openReviewer, HOST, installManager, startTestApp, type TestApp } from './helpers.ts';

vi.mock('node:dns', async (original) => {
  const dns = await original<typeof import('node:dns')>();
  return { ...dns, lookup: vi.fn(dns.lookup) };
});

const blocked = async (url: string) => {
  try { await fetchPublicImage(url); } catch (e) { return e instanceof ProxyError ? `${e.status}:${e.code}` : `other:${String(e)}`; }
  return 'ALLOWED';
};

describe('SSRF 방어: 내부·비공개 주소는 절대 받지 않는다', () => {
  it('IP 판별: 공인은 통과, 사설·루프백·링크로컬·메타데이터는 거절', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '223.130.195.95', '2606:4700:4700::1111']) expect(isPublicIp(ip), ip).toBe(true);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) expect(isPublicIp(ip), ip).toBe(false);
  });

  it('주소 형식·표기 우회를 막는다', async () => {
    const urls = [
      'http://127.0.0.1/a.png', 'http://localhost/a.png', 'http://foo.localhost/a.png', 'http://[::1]/a.png',
      'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/a.png', 'http://192.168.1.1/a.png', 'http://172.16.5.5/a.png',
      'http://2130706433/a.png', 'http://0x7f.0.0.1/a.png', 'http://0177.0.0.1/a.png', 'http://127.1/a.png', 'http://[::ffff:127.0.0.1]/a.png',
      'http://metadata.internal/a.png', 'http://printer.local/a.png',
      'file:///etc/passwd', 'ftp://example.com/a.png', 'gopher://example.com/', 'javascript:alert(1)', 'data:image/png;base64,AAAA',
      'http://user:pw@example.com/a.png', 'http://example.com:22/a.png', 'http://example.com:8080/a.png', 'not a url',
    ];
    for (const u of urls) {
      const r = await blocked(u);
      expect(r, u).toMatch(/^(400|403):/);
    }
  });

  it('이름이 내부 주소로 풀리면(DNS) 연결 전에 거절한다', async () => {
    // 공인 IP와 내부 IP를 함께 반환해도 전체를 거절해야 한다. /etc/hosts나 외부 DNS에 의존하지 않는다.
    vi.mocked(lookup).mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (err: null, addresses: { address: string; family: number }[]) => void;
      callback(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    });
    expect(await blocked('http://dns-fixture.example/a.png')).toBe('403:blocked');
  });
});

describe('이미지 프록시의 포트 규칙', () => {
  it('80/443 만 열고, 서비스 포트·개발 포트는 막는다', () => {
    for (const p of [80, 443]) expect(portAllowed(p), String(p)).toBe(true);
    for (const p of [21, 22, 25, 110, 445, 1023, 3000, 3123, 5173, 8080, 65535, 0, 3.5]) expect(portAllowed(p), String(p)).toBe(false);
  });
  it('서명 쿼리가 있는 원본 이미지 주소는 프록시로 가져오지 않는다', async () => {
    await expect(fetchPublicImage('https://assets.example.test/preview.png?X-Amz-Signature=sample'))
      .rejects.toMatchObject({ status: 400, code: 'bad_url' });
  });
  it('표준이 아닌 포트는 400 bad_port 로 거절한다', async () => {
    for (const u of ['http://example.com:22/a.png', 'http://example.com:3123/a.png']) {
      try { await fetchPublicImage(u); expect.unreachable(u); } catch (e) { expect(e).toBeInstanceOf(ProxyError); expect((e as ProxyError).code, u).toBe('bad_port'); }
    }
  });
});

describe('프록시 동작 (로컬 서버로, allowPrivate 시험 모드)', () => {
  let srv: http.Server;
  let port = 0;
  let png: Buffer;
  beforeAll(async () => {
    png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#ef4444' } }).png().toBuffer();
    srv = http.createServer((req, res) => {
      if (req.url === '/ok.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); }
      else if (req.url === '/hotlink.png') {
        if (req.headers.referer === 'http://client.example/') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); } else { res.writeHead(403); res.end('no'); }
      }
      else if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script>alert(1)</script>'); }
      else if (req.url === '/svg.png') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); }
      else if (req.url === '/redir') { res.writeHead(302, { Location: '/ok.png' }); res.end(); }
      else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
      else if (req.url === '/big.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.alloc(3000)); }
      else if (req.url === '/slow.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.write('x'); /* 끝내지 않는다 */ }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as { port: number }).port;
  });
  afterAll(() => { srv.closeAllConnections?.(); srv.close(); });
  const get = (p: string, o: Parameters<typeof fetchPublicImage>[1] = {}) => fetchPublicImage(`http://127.0.0.1:${port}${p}`, { allowPrivate: true, ...o });

  it('이미지를 받아 type 과 함께 돌려준다', async () => {
    const r = await get('/ok.png');
    expect(r.contentType).toBe('image/png');
    expect(r.body.equals(png)).toBe(true);
  });
  it('리다이렉트는 따라가고, 무한 리다이렉트는 끊는다', async () => {
    expect((await get('/redir')).body.length).toBe(png.length);
    await expect(get('/loop')).rejects.toBeInstanceOf(ProxyError);
  });
  it('이미지가 아니면 415, 크기·시간 초과는 거절', async () => {
    await expect(get('/html')).rejects.toMatchObject({ status: 415 });
    await expect(get('/big.png', { maxBytes: 1000 })).rejects.toMatchObject({ status: 413 });
    await expect(get('/slow.png', { timeoutMs: 400 })).rejects.toBeInstanceOf(ProxyError);
    await expect(get('/none')).rejects.toBeInstanceOf(ProxyError);
  });
  it('SVG 는 이미지로 허용하고, 사이트의 Referer 를 실어 보낸다(핫링크 방지 대응)', async () => {
    expect((await get('/svg.png')).contentType).toBe('image/svg+xml');
    await expect(get('/hotlink.png')).rejects.toBeInstanceOf(ProxyError);
    expect((await get('/hotlink.png', { referer: 'http://client.example/' })).contentType).toBe('image/png');
  });

  describe('위젯 API 경유', () => {
    let t: TestApp;
    const ORIGIN = 'http://client.example';
    let key = '';
    let session = '';
    beforeAll(async () => {
      t = await startTestApp({ IMAGE_PROXY_ALLOW_PRIVATE: '1' });
      const { headers } = await installManager(t);
      const { site, token } = await createSite(t, headers, '프록시', ORIGIN);
      key = site.widgetKey;
      session = (await openReviewer(t, { ...HOST, 'x-gp-key': key, origin: ORIGIN }, token, { name: '고객' })).json().session;
    });
    afterAll(async () => { await t.close(); });

    it('세션이 없으면 401, 있으면 이미지와 CORS 헤더가 온다(사이트 Referer 전달)', async () => {
      const url = `/api/w/img?u=${encodeURIComponent(`http://127.0.0.1:${port}/hotlink.png`)}`;
      const anon = await t.app.inject({ method: 'GET', url, headers: { ...HOST, 'x-gp-key': key, origin: ORIGIN } });
      expect(anon.statusCode).toBe(401);
      const ok = await t.app.inject({ method: 'GET', url, headers: { ...HOST, 'x-gp-key': key, origin: ORIGIN, authorization: `Bearer ${session}` } });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toBe('image/png');
      expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(String(ok.headers['content-security-policy'])).toContain('sandbox');
    });
    it('이미지가 아닌 응답은 415 로 막는다', async () => {
      const res = await t.app.inject({ method: 'GET', url: `/api/w/img?u=${encodeURIComponent(`http://127.0.0.1:${port}/html`)}`, headers: { ...HOST, 'x-gp-key': key, origin: ORIGIN, authorization: `Bearer ${session}` } });
      expect(res.statusCode).toBe(415);
    });
  });
});

describe('운영 설정에서는 내부 주소를 받지 않는다', () => {
  let t: TestApp;
  const ORIGIN = 'http://client.example';
  beforeAll(async () => { t = await startTestApp(); });
  afterAll(async () => { await t.close(); });
  it('IMAGE_PROXY_ALLOW_PRIVATE 를 켜지 않으면 127.0.0.1 은 403', async () => {
    const { headers } = await installManager(t);
    const { site, token } = await createSite(t, headers, 'p', ORIGIN);
    const s = (await openReviewer(t, { ...HOST, 'x-gp-key': site.widgetKey, origin: ORIGIN }, token, { name: '고객' })).json().session;
    for (const u of ['http://127.0.0.1/a.png', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/a.png']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/w/img?u=${encodeURIComponent(u)}`, headers: { ...HOST, 'x-gp-key': site.widgetKey, origin: ORIGIN, authorization: `Bearer ${s}` } });
      expect([400, 403], u).toContain(res.statusCode);
    }
  });
});

describe('이미지 프록시 끄기', () => {
  let t: TestApp;
  const ORIGIN = 'http://client.example';
  beforeAll(async () => { t = await startTestApp({ IMAGE_PROXY_ENABLED: 'false', IMAGE_PROXY_ALLOW_PRIVATE: '1' }); });
  afterAll(async () => { await t.close(); });
  it('IMAGE_PROXY_ENABLED=false 면 /api/w/img 는 404 (세션이 있어도)', async () => {
    const { headers } = await installManager(t);
    const { site, token } = await createSite(t, headers, 'p', ORIGIN);
    const s = (await openReviewer(t, { ...HOST, 'x-gp-key': site.widgetKey, origin: ORIGIN }, token, { name: '고객' })).json().session;
    const res = await t.app.inject({ method: 'GET', url: `/api/w/img?u=${encodeURIComponent('https://example.com/a.png')}`, headers: { ...HOST, 'x-gp-key': site.widgetKey, origin: ORIGIN, authorization: `Bearer ${s}` } });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('proxy_disabled');
  });
});
