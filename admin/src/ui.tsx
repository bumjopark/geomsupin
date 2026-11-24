import { useLocale } from './locale.tsx';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../../shared/browser.ts';
import { avatarAppearance } from '../../shared/avatar.ts';
import type { Me } from './types.ts';

// ── 토스트 ──
interface ToastItem { id: number; msg: string; bad?: boolean }
const ToastCtx = createContext<(msg: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((msg: string, bad = false) => {
    const id = ++seq.current;
    setItems((x) => [...x, { id, msg, bad }]);
    window.setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), bad ? 5000 : 2400);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {items.map((item) => <div key={item.id} className={`toast${item.bad ? ' bad' : ''}`}>{t(item.msg)}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ── 설치 관리자 ──
export const MeCtx = createContext<Me | null>(null);
export const useMe = () => {
  const v = useContext(MeCtx);
  if (!v) throw new Error('MeCtx');
  return v;
};

// ── 복사 버튼 ──
export function CopyButton({ text, label = '복사', className = 'btn sm' }: { text: string; label?: string; className?: string }) {
  const { t } = useLocale();
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) { setDone(true); toast(t("복사했어요")); window.setTimeout(() => setDone(false), 1500); } else toast(t("복사하지 못했어요. 직접 선택해 복사해 주세요"), true);
      }}
    >
      {done ? t("복사됨 ✓") : t(label)}
    </button>
  );
}

/** 이름 첫 글자 동그라미. 같은 이름은 항상 같은 색이라 한눈에 누가 누구인지 알 수 있어요. */
export function Avatar({ name, size = '' }: { name: string; size?: 'sm' | '' }) {
  const { initial, color } = avatarAppearance(name);
  return <span className={`av${size ? ` ${size}` : ''}`} style={{ background: color }} aria-hidden="true">{initial}</span>;
}

export function Spinner() {
  const { t } = useLocale();
  return <div className="center"><div className="spinner" aria-label={t("불러오는 중")} /></div>;
}

export function StatusPill({ status }: { status: string }) {
  const { t } = useLocale();
  return <span className={`st st-${status}`}>{t(status)}</span>;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return v;
}

export const PinIcon = () => (
  <i aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" /></svg></i>
);

const paths = {
  bookmark: 'M6 20V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v15l-6-4-6 4Z',
  pin: 'M19 10c0 5-7 10-7 10S5 15 5 10a7 7 0 1 1 14 0Zm-5 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  window: 'M4 5h16v14H4V5Zm0 5h16M7 7.5h.01m3 0h.01',
  up: 'm5 12 7-7 7 7m-7-7v14',
  grip: 'M9 5h.01m6 0h.01M9 12h.01m6 0h.01M9 19h.01m6 0h.01',
  external: 'M13 5h6v6m0-6-9 9m7 0v5H5V7h5',
  folder: 'M3 8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z',
  right: 'm9 6 6 6-6 6',
  message: 'M4 5h16v11H9l-5 4V5Zm4 4h8m-8 3h5',
  settings: 'M4 7h16m-16 10h16M8 4v6m8 4v6',
  close: 'm6 6 12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v11m-4-4 4 4 4-4M5 16v4h14v-4',
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
