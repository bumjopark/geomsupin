import { randomBytes, createHash, createHmac, timingSafeEqual, hkdfSync } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** AUTH_SECRET 에서 용도별 키를 파생한다. */
function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'geomsupin', purpose, 32));
}

/** 파일 서명 주소: /files/<key>?exp=<unix>&sig=<hmac>. 키·만료가 서명에 묶인다. */
export function signFile(secret: string, key: string, expUnix: number, reviewSession?: string): string {
  const hmac = createHmac('sha256', deriveKey(secret, 'file-url')).update(`${key}\n${expUnix}`);
  if (reviewSession) hmac.update(`\nreview-session:${reviewSession}`);
  return hmac.digest('base64url');
}

export function verifyFileSig(secret: string, key: string, expUnix: number, sig: string, reviewSession?: string): boolean {
  if (!Number.isFinite(expUnix) || expUnix < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(signFile(secret, key, expUnix, reviewSession), sig);
}
