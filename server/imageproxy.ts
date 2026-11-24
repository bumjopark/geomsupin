// 이미지 프록시: 고객 사이트의 이미지가 CORS 를 열어 두지 않으면 브라우저 안에서는 읽을 수 없어 캡처에 빠진다.
// 서버가 대신 받아 CORS 를 붙여 돌려준다. 공개 이미지 주소만 받아야 하므로 SSRF 방어가 핵심이다:
//  - http/https·표준 포트만(로컬 시험에서만 allowPrivate로 해제), 주소에 계정정보 금지
//  - DNS 로 얻은 모든 IP 가 공인 주소일 때만 연결하고, 검증한 IP 로 그대로 연결한다(DNS 리바인딩 방지)
//  - 리다이렉트는 3번까지, 매번 같은 검사
//  - 이미지 content-type 만, 크기·시간 제한
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

export class ProxyError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]] as const) PRIVATE.addSubnet(net, prefix, 'ipv6');

/** 공인 인터넷 주소인가. IPv4-mapped IPv6(::ffff:a.b.c.d)는 안쪽 IPv4 로 판단한다. */
export function isPublicIp(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicIp(mapped[1]!);
  const v = isIP(ip);
  if (!v) return false;
  return !PRIVATE.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

interface ProxyOptions {
  /** 시험에서만 true: 로컬 서버로 성공 경로를 확인한다 */
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  referer?: string;
}

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)(;|$)/i;

/** 연결을 허용하는 포트: 80/443 만. 22·25 같은 서비스 포트나 개발 포트는 열지 않는다. */
export function portAllowed(port: number): boolean {
  return port === 80 || port === 443;
}

function checkUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ProxyError(400, 'bad_url', '주소가 올바르지 않습니다'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ProxyError(400, 'bad_url', 'http/https 주소만 가능합니다');
  if (u.username || u.password) throw new ProxyError(400, 'bad_url', '계정 정보가 들어간 주소는 받을 수 없습니다');
  if (!allowPrivate) {
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!portAllowed(port)) throw new ProxyError(400, 'bad_port', '표준 포트(80/443)만 가능합니다');
    // 주소가 IP 리터럴이면 바로 판단한다(십진수·16진수 표기는 URL 파서가 점 표기로 바꿔 준다)
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicIp(host)) throw new ProxyError(403, 'blocked', '내부 주소는 받을 수 없습니다');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new ProxyError(403, 'blocked', '내부 주소는 받을 수 없습니다');
  }
  return u;
}

/** DNS 결과를 검사하고, 검사한 그 IP 로 연결하게 하는 lookup. 하나라도 내부 주소면 거절한다. */
function safeLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...(typeof options === 'object' ? options : {}), all: true }, (err, addresses) => {
      if (err) return (callback as (e: Error) => void)(err);
      const list = addresses as unknown as { address: string; family: number }[];
      if (!list.length) return (callback as (e: Error) => void)(new ProxyError(502, 'dns', '주소를 찾지 못했습니다'));
      if (!allowPrivate && list.some((a) => !isPublicIp(a.address))) return (callback as (e: Error) => void)(new ProxyError(403, 'blocked', '내부 주소는 받을 수 없습니다'));
      const first = list[0]!;
      const wantAll = typeof options === 'object' && (options as { all?: boolean }).all;
      if (wantAll) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [first]);
      else (callback as unknown as (e: null, a: string, f: number) => void)(null, first.address, first.family);
    });
  };
}

interface Raw { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

function once(u: URL, opts: Required<Pick<ProxyOptions, 'timeoutMs' | 'maxBytes'>> & ProxyOptions): Promise<Raw> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // 결과·오류는 한 번만 전달하고, 연결은 오류 객체 없이 끊는다(destroy(err) 는 처리되지 않은 예외로 새어 나갈 수 있다).
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(hard); fn(); };
    const fail = (e: ProxyError) => finish(() => { req.destroy(); reject(e); });
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        lookup: safeLookup(Boolean(opts.allowPrivate)),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; geomsupin-capture/1.0)',
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
          'Accept-Encoding': 'identity',
          ...(opts.referer ? { Referer: opts.referer } : {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.on('error', () => fail(new ProxyError(502, 'fetch_failed', '이미지를 받지 못했습니다')));
        if (status >= 300 && status < 400) { res.resume(); return finish(() => resolve({ status, headers: res.headers, body: Buffer.alloc(0) })); }
        const type = String(res.headers['content-type'] ?? '');
        if (status !== 200 || !IMAGE_TYPES.test(type)) { res.resume(); return fail(new ProxyError(status === 200 ? 415 : 502, 'not_image', '이미지가 아니거나 받을 수 없습니다')); }
        if (Number(res.headers['content-length']) > opts.maxBytes) { res.resume(); return fail(new ProxyError(413, 'too_large', '이미지가 너무 큽니다')); }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) return fail(new ProxyError(413, 'too_large', '이미지가 너무 큽니다'));
          chunks.push(c);
        });
        res.on('end', () => finish(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })));
      },
    );
    // 응답이 느리게 이어져도 전체 시간을 넘기지 않는다.
    const hard = setTimeout(() => fail(new ProxyError(504, 'timeout', '이미지를 받는 데 시간이 너무 오래 걸립니다')), opts.timeoutMs);
    req.on('error', (e) => {
      if (e instanceof ProxyError) return fail(e);
      // lookup 단계에서 던진 ProxyError(내부 주소)는 cause 로 들어올 수 있다.
      const cause = (e as { cause?: unknown }).cause;
      if (cause instanceof ProxyError) return fail(cause);
      fail(new ProxyError(502, 'fetch_failed', '이미지를 받지 못했습니다'));
    });
    req.end();
  });
}

async function follow(raw: string, options: ProxyOptions): Promise<Raw> {
  const opts = { timeoutMs: 5000, maxBytes: 8 * 1024 * 1024, ...options };
  let u = checkUrl(raw, Boolean(opts.allowPrivate));
  for (let hop = 0; hop <= 3; hop++) {
    const r = await once(u, opts);
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.location;
      if (!loc || hop === 3) throw new ProxyError(502, 'redirect', '주소가 계속 다른 곳으로 넘어가서 열지 못했습니다');
      u = checkUrl(new URL(loc, u).toString(), Boolean(opts.allowPrivate));
      continue;
    }
    return r;
  }
  throw new ProxyError(502, 'redirect', '주소가 계속 다른 곳으로 넘어가서 열지 못했습니다');
}

export async function fetchPublicImage(raw: string, options: ProxyOptions = {}): Promise<{ contentType: string; body: Buffer }> {
  const r = await follow(raw, options);
  return { contentType: String(r.headers['content-type']).split(';')[0]!.trim().toLowerCase(), body: r.body };
}
