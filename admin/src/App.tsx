import { useLocale } from './locale.tsx';
import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.ts';
import { Avatar, Icon, MeCtx, PinIcon, Spinner, ToastProvider, useToast } from './ui.tsx';
import type { Me } from './types.ts';
import { TutorialButton } from './Tutorial.tsx';
import { SitesPage } from './pages/Sites.tsx';
import { SiteShell } from './pages/SiteShell.tsx';
import { InvitePage } from './pages/Invite.tsx';

const MANAGEMENT_LINK = 'gp:management-link';
let exchange: Promise<unknown> | undefined;

function consumeManagementLink() {
  if (location.pathname !== '/') return;
  const token = new URLSearchParams(location.hash.slice(1)).get('manage');
  if (token === null) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  const previous = exchange;
  exchange = (async () => {
    await previous?.catch(() => {});
    await api('/api/manage/exchange', { method: 'POST', body: { token } });
  })();
  void exchange.catch(() => {});
  window.dispatchEvent(new Event(MANAGEMENT_LINK));
}

consumeManagementLink();
window.addEventListener('hashchange', consumeManagementLink);

export function App() {
  return <ToastProvider><Root /></ToastProvider>;
}

function Root() {
  const loc = useLocation();
  if (/^\/r\/[^/]+/.test(loc.pathname)) {
    return <><Header /><Routes><Route path="/r/:token" element={<InvitePage />} /></Routes></>;
  }
  return <Management />;
}

function Management() {
  const { t } = useLocale();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState('');
  const nav = useNavigate();
  const toast = useToast();
  useEffect(() => {
    let active = true;
    let version = 0;
    async function load() {
      const current = ++version;
      setError('');
      try {
        await exchange;
        const session = await api<{ user: Me | null }>('/api/manage/session');
        if (active && current === version) setMe(session.user);
      } catch (e) {
        if (active && current === version) { setError(e instanceof Error ? e.message : t("관리 세션을 확인하지 못했어요")); setMe(null); }
      }
    }
    void load();
    const unauthorized = () => setMe(null);
    window.addEventListener('gp:unauthorized', unauthorized);
    window.addEventListener(MANAGEMENT_LINK, load);
    return () => {
      active = false;
      window.removeEventListener('gp:unauthorized', unauthorized);
      window.removeEventListener(MANAGEMENT_LINK, load);
    };
  }, []);

  async function logout() {
    try {
      await api('/api/manage/session', { method: 'DELETE' });
      setError('');
      setMe(null);
      nav('/', { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : t("로그아웃하지 못했어요"), true);
    }
  }
  if (me === undefined) return <Spinner />;
  if (!me) return <><Header /><PublicAccess managementError={error} /></>;
  return (
    <MeCtx.Provider value={me}>
      <Header me={me} onLogout={() => void logout()} />
      <BackupNotice />
      <Routes>
        <Route path="/" element={<Navigate to="/sites" replace />} />
        <Route path="/sites" element={<SitesPage />} />
        <Route path="/sites/:id/*" element={<SiteShell />} />
        <Route path="*" element={<div className="page"><div className="card empty"><h2>{t("페이지를 찾을 수 없어요")}</h2><p><Link to="/sites">{t("프로젝트 목록으로")}</Link></p></div></div>} />
      </Routes>
    </MeCtx.Provider>
  );
}

function PublicAccess({ managementError }: { managementError: string }) {
  const { t } = useLocale();
  const [link, setLink] = useState('');
  const [error, setError] = useState('');

  function openInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = link.trim();
    try {
      const url = value.startsWith('/r/') ? new URL(value, window.location.origin) : new URL(value);
      if (url.origin === window.location.origin && !url.username && !url.password && !url.search && !url.hash &&
        /^\/r\/[A-Za-z0-9_-]{16,80}$/.test(url.pathname)) {
        // The invite HTML is served with the selected project's frame policy.
        window.location.assign(url.pathname);
        return;
      }
    } catch { /* 입력란 아래에 안내를 표시한다. */ }
    setError("이 검수핀에서 발급한 초대 링크를 입력해 주세요.");
  }

  return <main className="page access-page">
    <section className="card pad stack access-entry">
      <span className="section-mark"><Icon name="bookmark" /></span>
      <div><h1>{t("검수에 참여하기")}</h1><p>{t("팀에서 받은 초대 링크를 열어 주세요.")}</p></div>
      <form className="access-form stack" onSubmit={openInvite}>
        <label className="field">{t("초대 링크")}<input className="input" value={link} onChange={event => { setLink(event.target.value); setError(''); }} placeholder={t("받은 초대 링크 붙여넣기")} autoCapitalize="none" spellCheck={false} inputMode="url" maxLength={2048} aria-invalid={!!error} aria-describedby={error ? 'invite-link-error' : undefined} /></label>
        {error && <div className="err" id="invite-link-error" role="alert">{t(error)}</div>}
        <button type="submit" className="btn primary" disabled={!link.trim()}>{t("초대 열기")} <Icon name="right" /></button>
      </form>
      <section className="access-management">
        <h2>{t("검수핀 관리")}</h2>
        {managementError && <div className="err" role="alert">{t(managementError)}</div>}
        <details className="bookmark-help">
          <summary>{t("관리 링크 발급 방법")}</summary>
          <p>{t("설치 서버에서")} <code>npm run manage</code>{t("로 관리 링크를 발급해 이 브라우저에서 열어 주세요.")}</p>
        </details>
      </section>
    </section>
    <aside className="access-guide" aria-label={t("사용 가이드")}><TutorialButton variant="poster" /></aside>
  </main>;
}

function BackupNotice() {
  const { t } = useLocale();
  const [state, setState] = useState('unknown');
  useEffect(() => {
    let active = true;
    const refresh = () => { void api<{ state: string }>('/api/operations/backup').then(result => { if (active) setState(result.state); }).catch(() => {}); };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  if (state !== 'failed' && state !== 'overdue') return null;
  return <div className="page" style={{ paddingBottom: 0 }}><div className="card pad" role="alert">
    <b>{t("자동 백업을 확인해 주세요.")}</b> {state === 'failed' ? t("최근 자동 백업을 완료하지 못했습니다.") : t("36시간 넘게 자동 백업이 완료되지 않았습니다.")} {t("서버 관리자에게 확인을 요청해 주세요.")} </div></div>;
}

function Header({ me, onLogout }: { me?: Me; onLogout?: () => void }) {
  const { locale, setLocale, t } = useLocale();
  return (
    <header className="top">
      <div className="top-in">
        <Link to="/sites" className="brand"><PinIcon /><span className="brand-name">{t("검수핀")}</span></Link>
        <div className="grow" />
        <TutorialButton />
        <div className="language-switch" role="group" aria-label={locale === 'en' ? 'Language' : '언어'}>
          <button type="button" lang="ko" aria-label="한국어" aria-pressed={locale === 'ko'} onClick={() => setLocale('ko')}>KO</button>
          <button type="button" lang="en" aria-label="English" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button>
        </div>
        {me && (
          <>
            <div className="workspace-name"><Avatar name={me.name} size="sm" /><span className="small">{me.workspace.name}</span></div>
            <button className="btn sm ghost" onClick={onLogout}>{t("로그아웃")}</button>
          </>
        )}
      </div>
    </header>
  );
}
