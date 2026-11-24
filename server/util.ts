import type { FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const httpError = (status: number, code: string, message: string, extra?: Record<string, unknown>) => new HttpError(status, code, message, extra);

export function errorBody(code: string, message: string, extra?: Record<string, unknown>) {
  return { error: { code, message, ...extra } };
}

export function zodMessage(e: ZodError): { message: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (const issue of e.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return { message: '입력값을 확인해 주세요', fields };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 실제 접속자 IP. Cloudflare Tunnel 은 loopback 에서 들어오므로, 소켓이 loopback 일 때만
 * CF-Connecting-IP 를 믿는다(외부에서 직접 붙는 경로는 없다).
 */
export function clientIp(req: FastifyRequest): string {
  const remote = req.socket.remoteAddress || '';
  if (LOOPBACK.has(remote)) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.trim();
  }
  return req.ip;
}

export const clip = (s: string | undefined | null, n: number) => (s ?? '').slice(0, n);

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
