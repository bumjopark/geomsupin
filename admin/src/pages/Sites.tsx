import { useLocale } from '../locale.tsx';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, relTime } from '../api.ts';
import { Icon, Spinner } from '../ui.tsx';
import type { Site } from '../types.ts';
import { targetUrlLabel } from '../../../shared/target-url.ts';

export function SitesPage() {
  const { locale, t } = useLocale();
  const nav = useNavigate();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState(false);

  useEffect(() => { api<{ sites: Site[] }>('/api/sites').then((r) => setSites(r.sites)).catch(() => setLoadError(true)); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ site: Site }>('/api/sites', { method: 'POST', body: { name } });
      nav(`/sites/${r.site.id}/settings`);
    } catch (err) {
      const m = err instanceof ApiError ? (err.fields ? Object.values(err.fields)[0] : err.message) : t("만들지 못했어요");
      setError(m ?? t("만들지 못했어요"));
    } finally { setBusy(false); }
  }

  if (loadError) return <main className="page"><div className="callout" role="alert">{t("프로젝트 목록을 불러오지 못했어요.")} <button className="btn sm" onClick={() => window.location.reload()}>{t("다시 시도")}</button></div></main>;
  if (!sites) return <Spinner />;

  const form = (
    <form className="card pad stack project-form" onSubmit={create}>
      <span className="section-mark"><Icon name="folder" /></span>
      <h2>{t("새 프로젝트 만들기")}</h2>
      <label className="field">{t("프로젝트 이름")}<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("예: 웹사이트 리뉴얼")} required maxLength={60} autoFocus /></label>
      {error && <div className="err" role="alert">{t(error)}</div>}
      <div className="row">
        <button className="btn primary lg" disabled={busy} type="submit">{busy ? t("만드는 중…") : t("만들기")}</button>
        {sites.length > 0 && <button className="btn" type="button" onClick={() => setCreating(false)}>{t("취소")}</button>}
      </div>
    </form>
  );

  return (
    <main className="page projects-page">
      <div className="row between wrap hello">
        <div>
          <h1>{t("프로젝트")}</h1>
          {sites.length > 0 && <div className="muted">{locale === 'en' ? `${sites.length} project${sites.length === 1 ? '' : 's'}` : `${sites.length}개 프로젝트`}</div>}
        </div>
        {sites.length > 0 && !creating && <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" /> {t("새 프로젝트")}</button>}
      </div>

      {(creating || sites.length === 0) && form}

      {sites.length > 0 && !creating && (
        <div className="sites">
          {sites.map((s) => (
            <Link key={s.id} to={`/sites/${s.id}`} className="card site">
              <div className="row site-main">
                <span className="section-mark"><Icon name="folder" /></span>
                <div className="grow">
                  <div className="name">{s.name}</div>
                  <div className="site-location small muted">{s.preview ? targetUrlLabel(s.preview.url) : t("사이트 주소 미연결")}</div>
                </div>
                {s.status === 'done' && <span className="badge off">{t("종료")}</span>}
              </div>
              <div className="stat">
                <div><b className="open-count">{s.openCount ?? 0}</b><span className="muted small">{t("열린 요청")}</span></div>
                <div><b>{s.totalCount ?? 0}</b><span className="muted small">{t("전체")}</span></div>
                <div><b>{locale === 'en' ? s.roundNo ?? 1 : `${s.roundNo ?? 1}차`}</b><span className="muted small">{t("현재 차수")}</span></div>
              </div>
              <div className="row between site-end">
                <span className="muted small">{locale === 'en' ? `Created ${relTime(s.createdAt, locale)}` : `${relTime(s.createdAt, locale)} 생성`}</span>
                <Icon name="right" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
