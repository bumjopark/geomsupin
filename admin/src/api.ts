import type { Locale } from '../../shared/locale.ts';
import { fetchJson } from '../../shared/network.ts';

export class ApiError extends Error {
  constructor(public status: number, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let result;
  try { result = await fetchJson(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }); } catch (e) { throw new ApiError(0, (e as Error).message); }
  const { response: res, data } = result;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/manage/')) window.dispatchEvent(new Event('gp:unauthorized'));
    throw new ApiError(res.status, data?.error?.message ?? '요청을 처리하지 못했습니다', data?.error?.fields);
  }
  return data as T;
}

const formats = (locale: Locale, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ko-KR', { timeZone: 'Asia/Seoul', hour12: false, ...options });

const short = { ko: formats('ko', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), en: formats('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) };
const full = { ko: formats('ko', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }), en: formats('en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) };
const relativeEn = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

export const fullTime = (iso: string | null, locale: Locale) => iso ? full[locale].format(new Date(iso)) : '';

export function relTime(iso: string | null, locale: Locale): string {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return locale === 'en' ? 'just now' : '방금';
  if (seconds < 86400 * 30) {
    const [size, unit, label] = seconds < 3600 ? [60, 'minute', '분'] as const
      : seconds < 86400 ? [3600, 'hour', '시간'] as const : [86400, 'day', '일'] as const;
    const count = Math.floor(seconds / size);
    return locale === 'en' ? relativeEn.format(-count, unit) : `${count}${label} 전`;
  }
  return short[locale].format(new Date(iso));
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname + u.search + u.hash) || '/';
  } catch {
    return url;
  }
}
