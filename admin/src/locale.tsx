import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { normalizeLocale, type Locale } from '../../shared/locale.ts';
import { translate } from './messages.ts';

const key = 'geomsupin.locale';

function savedLocale(): Locale {
  try { return normalizeLocale(localStorage.getItem(key)); }
  catch { return 'ko'; }
}

const LocaleContext = createContext({
  locale: 'ko' as Locale,
  setLocale: (_locale: Locale) => {},
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, update] = useState(savedLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, '검수핀');
  }, [locale]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) update(savedLocale());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  function setLocale(value: Locale) {
    update(value);
    try { localStorage.setItem(key, value); } catch { /* The selection still applies to this tab. */ }
  }
  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);
  return { ...context, t: (text: string) => translate(context.locale, text) };
}
