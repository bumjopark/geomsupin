import { PeerReviewLink, usePeerReviewUrl } from '../Installation.tsx';
import { useLocale } from '../locale.tsx';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, fullTime } from '../api.ts';
import { CopyButton, Icon, useToast } from '../ui.tsx';
import { InviteCard } from './Share.tsx';
import { TARGET_URL_MAX, parseTargetUrl, reviewProtocolIssue } from '../../../shared/target-url.ts';
import type { Link as ReviewLink, Site } from '../types.ts';

/** 미리보기 연결, 초대 링크, 프로젝트 관리. */
export function SettingsPage({ site, reload }: { site: Site; reload: () => Promise<void> }) {
  const { locale, t } = useLocale();
  const toast = useToast();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);

  async function patchSite(body: Record<string, unknown>, okMsg = t("저장했어요")) {
    setBusy(true);
    try {
      await api(`/api/sites/${site.id}`, { method: 'PATCH', body });
      await reload();
      toast(okMsg);
    } catch (e) { toast(e instanceof ApiError ? (e.fields ? Object.values(e.fields)[0]! : e.message) : t("저장하지 못했어요"), true); } finally { setBusy(false); }
  }

  const base = site.links?.[0]?.shareUrl ?? window.location.origin;

  return (
    <div className="stack settings-layout">
      <PreviewSettings site={site} base={base} busy={busy} save={(previewUrl) => patchSite({ previewUrl }, previewUrl ? t("미리보기 주소를 저장했어요") : t("미리보기 연결을 해제했어요"))} />

      <InviteCard site={site} />

      <details className="adv settings-advanced">
        <summary>{t("고급 설정")} <span className="muted small" style={{ fontWeight: 400 }}>{t("링크 관리 · 프로젝트 종료/삭제")}</span></summary>
        <div className="in">
          <Links site={site} reload={reload} />
          <section className="sec">
            <h2>{t("프로젝트 관리")}</h2>
            <div className="row wrap">
              <button className="btn" disabled={busy} onClick={() => void patchSite({ status: site.status === 'active' ? 'done' : 'active' }, site.status === 'active' ? t("검수를 종료했어요. 위젯이 더는 동작하지 않아요") : t("검수를 다시 열었어요"))}>
                {site.status === 'active' ? t("검수 종료하기") : t("검수 다시 열기")}
              </button>
              <span className="muted small">{site.status === 'active' ? t("종료하면 위젯이 멈추고, 요청과 엑셀은 그대로 남아요.") : t("지금은 종료된 프로젝트예요. 요청과 엑셀은 볼 수 있어요.")}</span>
            </div>
            <div className="row wrap">
              <button
                className="btn danger"
                onClick={async () => {
                  if (window.prompt(locale === 'en' ? `Permanently delete this project, its requests and screenshots? Type "${site.name}" to confirm.` : `이 프로젝트와 모든 요청·캡처를 지웁니다. 되돌릴 수 없어요.\n계속하려면 프로젝트 이름 "${site.name}" 을(를) 입력하세요.`) !== site.name) return;
                  try { await api(`/api/sites/${site.id}`, { method: 'DELETE' }); toast(t("프로젝트를 삭제했어요")); nav('/sites'); } catch { toast(t("삭제하지 못했어요"), true); }
                }}
              >{t("프로젝트 삭제")}</button>
            </div>
          </section>
        </div>
      </details>
    </div>
  );
}

function PreviewSettings({ site, base, busy, save }: { site: Site; base: string; busy: boolean; save: (url: string) => Promise<void> }) {
  const { t } = useLocale();
  const peer = usePeerReviewUrl();
  const saved = site.preview?.url ?? '';
  const [value, setValue] = useState(saved);
  useEffect(() => { setValue(saved); }, [saved]);
  const checked = parseTargetUrl(value);
  const targetProtocol = checked.ok && checked.url ? new URL(checked.url).protocol : undefined;
  const protocolIssue = targetProtocol ? reviewProtocolIssue(new URL(base).protocol, targetProtocol) : undefined;
  const issue = checked.ok ? protocolIssue : checked.message;
  const matchingPeer = protocolIssue && peer && new URL(peer).protocol === targetProtocol ? peer : null;
  const script = site.preview ? `<script defer src="${new URL(base).origin}/w.js" data-gp-preview="${site.preview.id}"></script>` : '';
  return (
    <section className="card pad sec settings-site" aria-label={t("미리보기 연결")}>
      <div className="settings-heading"><span className="section-mark"><Icon name="window" /></span><div><h2>{t("검수할 사이트")}</h2><p>{t("참여자가 핀을 남길 주소를 연결하세요.")}</p></div></div>
      <form className="row wrap settings-form" onSubmit={(e) => { e.preventDefault(); if (checked.ok && !issue) void save(checked.url); }}>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://staging.example.com" aria-label={t("미리보기 주소")} inputMode="url" autoCapitalize="none" spellCheck={false} maxLength={TARGET_URL_MAX} aria-invalid={Boolean(issue)} aria-describedby={issue ? "site-url-issue" : undefined} />
        <button className="btn primary" type="submit" disabled={busy || !checked.ok || Boolean(issue) || checked.url === saved}>{t("저장")}</button>
        {saved && <button className="btn" type="button" disabled={busy} onClick={() => void save('')}>{t("연결 해제")}</button>}
      </form>
      {issue && <div className="err" id="site-url-issue" role="alert">
        {matchingPeer ? <>{t('이 주소는 다른 입구에서 검수할 수 있어요. 그곳에서 프로젝트를 만들고 주소를 연결하세요.')} <PeerReviewLink url={matchingPeer} /></> : t(issue)}
      </div>}
      {script && (
        <details className="bookmark-help preview-settings">
          <summary>{t("내장 미리보기 스크립트")}</summary>
          <div className="stack">
            <h3>{t("핀 사용 설정")}</h3>
            <p>{t("초대 화면의 ‘브라우저에서 미리보기’ 안에서도 핀을 쓰려면 사이트에 이 스크립트를 추가하세요. 사이트에서")} <code>{new URL(base).origin}</code>{t("의 iframe 표시를 허용해야 해요.")}</p>
            <div className="urlbox"><input className="input" aria-label={t("미리보기 연결 스크립트")} readOnly value={script} /><CopyButton text={script} label={t("스크립트 복사")} /></div>
          </div>
        </details>
      )}
    </section>
  );
}

function Links({ site, reload }: { site: Site; reload: () => Promise<void> }) {
  const { locale, t } = useLocale();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const links = site.links ?? [];

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); await reload(); toast(ok); return true; } catch (e) { toast(e instanceof ApiError ? (e.fields ? Object.values(e.fields)[0]! : e.message) : t("처리하지 못했어요"), true); return false; } finally { setBusy(false); }
  }

  return (
    <section className="sec">
      <h2>{t("링크 관리")}</h2>
      <p className="muted small" style={{ margin: 0 }}>{t("링크는 여러 개 만들어 고객사·팀별로 나눠 보낼 수 있어요. 어느 링크로 들어와도 같은 요청 목록을 함께 봐요. 링크가 새어 나갔다면 폐기하세요. 이미 들어온 사람도 더는 쓸 수 없어요.")}</p>
      <div>
        {links.map((l: ReviewLink) => (
          <div key={l.id} className="linkrow">
            <div className="stack" style={{ gap: 6, minWidth: 0 }}>
              <div className="row wrap">
                <b>{l.label === '기본 링크' ? t(l.label) : l.label || t("이름 없는 링크")}</b>
                {l.active ? <span className="badge ok">{t("사용 중")}</span> : <span className="badge off">{l.revokedAt ? t("폐기됨") : t("만료됨")}</span>}
                {l.expiresAt && <span className="muted small">{locale === 'en' ? `Expires ${fullTime(l.expiresAt, locale)}` : `${fullTime(l.expiresAt, locale)}까지`}</span>}
              </div>
              <div className="urlbox"><input className="input" readOnly value={l.shareUrl} onFocus={(e) => e.currentTarget.select()} aria-label={t("공유 링크")} /><CopyButton text={l.shareUrl} className="btn sm" /><a className="btn sm" href={l.shareUrl} target="_blank" rel="noreferrer">{t("열어 보기")}</a></div>
            </div>
            <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
              <button className={`btn sm ${l.revokedAt ? '' : 'danger'}`} disabled={busy} onClick={() => void run(() => api(`/api/sites/${site.id}/links/${l.id}`, { method: 'PATCH', body: { revoked: !l.revokedAt } }), l.revokedAt ? t("링크를 다시 열었어요") : t("링크를 폐기했어요. 이미 들어온 사람도 더는 쓸 수 없어요"))}>{l.revokedAt ? t("다시 열기") : t("폐기")}</button>
            </div>
          </div>
        ))}
      </div>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          const body: Record<string, unknown> = { label };
          if (days) body.expiresAt = new Date(Date.now() + Number(days) * 86400_000).toISOString();
          void run(() => api(`/api/sites/${site.id}/links`, { method: 'POST', body }), t("링크를 만들었어요")).then(saved => { if (saved) { setLabel(''); setDays(''); } });
        }}
      >
        <input className="input" style={{ width: 220 }} placeholder={t("링크 이름 (예: 고객사 A)")} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        <select className="select" style={{ width: 140 }} value={days} onChange={(e) => setDays(e.target.value)} aria-label={t("유효 기간")}>
          <option value="">{t("기간 제한 없음")}</option><option value="7">{t("7일")}</option><option value="14">{t("14일")}</option><option value="30">{t("30일")}</option><option value="90">{t("90일")}</option>
        </select>
        <button className="btn primary" type="submit" disabled={busy}>{t("+ 링크 만들기")}</button>
      </form>
    </section>
  );
}
