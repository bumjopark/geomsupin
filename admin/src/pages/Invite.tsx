import { useLocale } from '../locale.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { CopyButton, Icon, Spinner } from '../ui.tsx';
import { ReviewPreview } from './ReviewPreview.tsx';
import { Bookmarklet } from './Bookmarklet.tsx';

type Share =
  | { state: 'ok'; project: string; widgetKey: string; base: string; preview: { url: string; id: string } }
  | { state: 'revoked' | 'expired' | 'done' | 'unconnected'; project: string };

const CLOSED = {
  revoked: ['이 링크는 닫혔어요', '설치 관리자에게 새 링크를 요청해 주세요.'],
  expired: ['이 링크는 기간이 지났어요', '설치 관리자에게 새 링크를 요청해 주세요.'],
  done: ['검수가 끝났어요', '검수 기록은 설치 관리자에게 문의해 주세요.'],
  unconnected: ['스테이징 미리보기 연결이 필요해요', '설치 관리자에게 프로젝트 설정에서 스테이징을 연결해 달라고 요청해 주세요.'],
};

function InviteNotice({ title, description, retry = false }: { title: string; description: string; retry?: boolean }) {
  const { t } = useLocale();
  return <main className="page narrow"><div className="card empty">
    <h1>{title}</h1><p className="muted">{description}</p>
    {retry && <button className="btn primary" onClick={() => window.location.reload()}>{t("미리보기 다시 연결")}</button>}
  </div></main>;
}

export function InvitePage() {
  const { token = '' } = useParams();
  return <Invite key={token} token={token} />;
}

function Invite({ token }: { token: string }) {
  const { locale, t } = useLocale();
  const [data, setData] = useState<Share | 'missing' | 'error' | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const recheck = useRef<(() => void) | null>(null);
  const recheckShare = useCallback(() => recheck.current?.(), []);

  useEffect(() => {
    let active = true;
    let previous: Share | undefined;
    let checking = false;
    let queued = false;
    let lastCheck = 0;
    const path = `/api/share/${encodeURIComponent(token)}`;
    async function load() {
      if (checking) { queued = true; return; }
      checking = true;
      lastCheck = Date.now();
      try {
        const result = await api<Share>(path);
        if (!active) return;
        if (previous?.state === 'ok' && result.state === 'ok' &&
            new URL(previous.preview.url).origin !== new URL(result.preview.url).origin) {
          // 출처가 달라지면 새 HTML의 frame-src가 필요하다.
          window.location.reload();
          return;
        }
        previous = result;
        setData(result);
      } catch (e) {
        if (!active) return;
        if (e instanceof ApiError && e.status === 404) {
          previous = undefined;
          setData('missing');
        } else {
          setData(current => current ?? 'error');
        }
      } finally {
        checking = false;
        if (active && queued) {
          queued = false;
          void load();
        }
      }
    }
    const whenVisible = () => {
      if (previous?.state === 'ok' && !checking && !document.hidden && Date.now() - lastCheck >= 10_000) void load();
    };
    recheck.current = () => void load();
    void load();
    const timer = window.setInterval(whenVisible, 60_000);
    document.addEventListener('visibilitychange', whenVisible);
    window.addEventListener('focus', whenVisible);
    return () => {
      active = false;
      recheck.current = null;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', whenVisible);
      window.removeEventListener('focus', whenVisible);
    };
  }, [token]);

  if (!data) return <Spinner />;
  if (data === 'missing') return <InviteNotice title={t("초대 링크를 찾을 수 없어요")} description={t("주소가 잘리지 않았는지 확인해 주세요.")} />;
  if (data === 'error') return <InviteNotice title={t("초대를 불러오지 못했어요")} description={t("연결을 확인한 뒤 다시 시도해 주세요.")} retry />;
  if (data.state !== 'ok') {
    const [title, body] = CLOSED[data.state];
    return <InviteNotice title={t(title!)} description={`‘${data.project}’ · ${t(body!)}`} retry={data.state === 'unconnected'} />;
  }
  if (showPreview) return (
    <main className="review-workspace">
      <header className="review-header">
        <h1>{data.project}</h1>
        <div className="row wrap">
          <a className="btn sm" href={data.preview.url} target="_blank" rel="noopener noreferrer">{t("사이트 새 탭에서 열기")}</a>
          <button type="button" className="btn sm" onClick={() => setShowPreview(false)}>{t("북마크 설치로 돌아가기")}</button>
          <CopyButton className="btn sm" text={window.location.href} label={t("초대 링크 복사")} />
        </div>
      </header>
      <ReviewPreview key={`${token}:${data.preview.id}:${previewAttempt}:${locale}`} preview={data.preview} base={data.base} widgetKey={data.widgetKey} token={token}
        onUnavailable={recheckShare} onReconnect={() => { recheckShare(); setPreviewAttempt(attempt => attempt + 1); }} />
    </main>
  );
  return <main className="page invite-page">
    <header className="invite-heading">
      <p className="eyebrow"><Icon name="pin" /> {t("검수 초대")}</p>
      <h1>{data.project}</h1>
    </header>
    <Bookmarklet project={data.project} preview={data.preview} base={data.base} widgetKey={data.widgetKey} token={token} />
    <div className="invite-tools">
      <button type="button" className="btn ghost sm" onClick={() => setShowPreview(true)}><Icon name="window" /> {t("브라우저에서 미리보기")}</button>
      <CopyButton className="btn ghost sm invite-copy" text={window.location.href} label={t("초대 링크 복사")} />
    </div>
  </main>;
}
