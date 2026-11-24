import { useLocale } from '../locale.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useMatch, useParams } from 'react-router-dom';
import { api } from '../api.ts';
import { CopyButton, Icon, Spinner } from '../ui.tsx';
import { targetUrlLabel } from '../../../shared/target-url.ts';
import type { Site } from '../types.ts';
import { RequestsPage } from './Requests.tsx';
import { SettingsPage } from './Settings.tsx';

export function SiteShell() {
  const { t } = useLocale();
  const { id = '' } = useParams();
  const settingsMatch = useMatch('/sites/:id/settings');
  const [site, setSite] = useState<Site | null>(null);
  const [missing, setMissing] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const next = (await api<{ site: Site }>(`/api/sites/${id}`)).site;
      if (seq === loadSeq.current) { setSite(next); setMissing(false); }
    } catch { if (seq === loadSeq.current) setMissing(true); }
  }, [id]);
  useEffect(() => { setSite(null); setMissing(false); void load(); return () => { loadSeq.current++; }; }, [load]);

  if (missing) return <main className="page"><div className="card empty"><h1>{t("프로젝트를 찾을 수 없어요")}</h1><p><Link to="/sites">{t("프로젝트 목록으로")}</Link></p></div></main>;
  if (!site) return <Spinner />;

  const activeLink = site.links?.find((l) => l.active);

  return (
    <main className="page project-page">
      <header className="project-head">
        <nav aria-label={t("현재 위치")} className="crumbs muted"><Link to="/sites">{t("프로젝트")}</Link><Icon name="right" /><span>{site.name}</span></nav>
        <div className="sitehead">
          <div>
            <div className="row wrap site-title"><h1>{site.name}</h1>{site.status === 'done' && <span className="badge off">{t("종료")}</span>}</div>
            {site.preview && <div className="small urltext"><a className="site-target" href={site.preview.url} target="_blank" rel="noopener noreferrer" title={site.preview.url}><Icon name="window" />{targetUrlLabel(site.preview.url)}<Icon name="external" /></a></div>}
          </div>
          {!settingsMatch && <div className="row">
            {activeLink && site.preview && site.status === 'active'
              ? <CopyButton className="btn primary" text={activeLink.shareUrl} label={t("팀원 초대 링크 복사")} />
              : <Link to="settings" className="btn">{t("검수 설정")}</Link>}
          </div>}
        </div>
        <nav className="subnav" aria-label={t("프로젝트 메뉴")}>
          <NavLink to={`/sites/${site.id}`} end className={({ isActive }) => (isActive ? 'active' : '')}><Icon name="message" /> {t("요청")}</NavLink>
          <NavLink to={`/sites/${site.id}/settings`} className={({ isActive }) => (isActive ? 'active' : '')}><Icon name="settings" /> {t("설정")}</NavLink>
        </nav>
      </header>
      <Routes>
        <Route index element={<RequestsPage key={site.id} site={site} />} />
        <Route path="settings" element={<SettingsPage key={site.id} site={site} reload={load} />} />
      </Routes>
    </main>
  );
}
