import { useLocale } from '../locale.tsx';
import { useEffect, useRef, useState } from 'react';
import { isPreviewMessage, PREVIEW_CHANNEL } from '../../../shared/preview.ts';
import { reviewerPid } from '../reviewer.ts';

interface PreviewProps {
  preview: { url: string; id: string };
  token: string;
  widgetKey: string;
  base: string;
  onUnavailable: () => void;
  onReconnect: () => void;
}

const PIN_STATUS = {
  checking: '핀 연결 확인 중…',
  unconfirmed: '핀 연결을 확인하지 못했어요',
  connected: '핀 연결됨',
};

export function ReviewPreview({ preview, token, widgetKey, base, onUnavailable, onReconnect }: PreviewProps) {
  const { locale, t } = useLocale();
  const frame = useRef<HTMLIFrameElement>(null);
  const [load, setLoad] = useState(0);
  const [pins, setPins] = useState<keyof typeof PIN_STATUS>('checking');
  const [pid] = useState(reviewerPid);
  const previewOrigin = new URL(preview.url).origin;

  useEffect(() => {
    setPins('checking');
    const iframe = frame.current;
    const child = iframe?.contentWindow;
    if (!child || previewOrigin === location.origin || location.origin !== new URL(base).origin) {
      setPins('unconfirmed');
      return;
    }

    const abort = new AbortController();
    const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
    const envelope = { channel: PREVIEW_CHANNEL, id: preview.id, nonce };
    let started = false;
    let pending = false;
    let attemptAfter = 0;
    let retryDelay = 3_000;
    let waited = false;
    let stopped = false;
    let checkedInvite = false;
    let probe: number | undefined;
    const timeout = window.setTimeout(() => {
      // iframe의 load 여부로는 교차 출처 사이트가 실제 표시됐는지 알 수 없다.
      waited = true;
      setPins('unconfirmed');
      onUnavailable();
    }, 12_000);
    function ping() {
      if (stopped || started) return;
      if (load && !pending && Date.now() >= attemptAfter) child?.postMessage({ ...envelope, type: 'ping' }, previewOrigin);
      probe = window.setTimeout(ping, waited ? 2_000 : 350);
    }
    function stop() {
      stopped = true;
      window.clearTimeout(probe);
      window.clearTimeout(timeout);
    }
    function checkInvite() {
      if (checkedInvite) return;
      checkedInvite = true;
      onUnavailable();
    }

    async function onMessage(event: MessageEvent) {
      if (event.origin !== previewOrigin || event.source !== child || !isPreviewMessage(event.data, preview.id) || event.data.nonce !== nonce) return;
      if (event.data.type === 'ready' && load && !stopped && !started && !pending && Date.now() >= attemptAfter) {
        pending = true;
        try {
          const res = await fetch('/api/w/session', {
            method: 'POST',
            mode: 'cors',
            credentials: 'omit',
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
            headers: { 'Content-Type': 'application/json', 'X-GP-Key': widgetKey },
            body: JSON.stringify({ token, pid, previewId: preview.id }),
          });
          if (!res.ok) {
            if (abort.signal.aborted) return;
            if ([401, 403, 404].includes(res.status)) {
              stop();
              setPins('unconfirmed');
              checkInvite();
              return;
            }
            if (res.status === 429) retryDelay = 30_000;
            throw new Error('preview session');
          }
          const { session, reviewer } = await res.json();
          if (!abort.signal.aborted) {
            child?.postMessage({ ...envelope, type: 'start', locale, key: widgetKey, session, reviewer }, previewOrigin);
            started = true;
          }
        } catch {
          if (!abort.signal.aborted) {
            attemptAfter = Date.now() + retryDelay;
            retryDelay = Math.min(retryDelay * 2, 30_000);
            waited = true;
            setPins('unconfirmed');
          }
        } finally {
          pending = false;
        }
      } else if (started && event.data.type === 'active') {
        stop();
        setPins('connected');
      } else if (started && event.data.type === 'unavailable') {
        stop();
        setPins('unconfirmed');
        checkInvite();
      }
    }

    window.addEventListener('message', onMessage);
    ping();
    return () => {
      stop();
      abort.abort();
      window.removeEventListener('message', onMessage);
    };
  }, [locale, base, load, onUnavailable, pid, preview.id, previewOrigin, token, widgetKey]);

  return (
    <div className="review-preview">
      <div className="review-preview-status">
        <div>
          <span role="status" className={`badge ${pins === 'connected' ? 'ok' : 'off'}`}>{t(PIN_STATUS[pins])}</span>
          {pins === 'unconfirmed' && <p className="muted small">{t("사이트가 보이면 그대로 볼 수 있어요. 핀에는 연결 스크립트 설치가 필요해요. 화면이 비어 있으면 새 탭에서 열거나 다시 연결해 주세요.")}</p>}
        </div>
        {pins === 'unconfirmed' && <button className="btn sm" type="button" onClick={onReconnect}>{t("미리보기 다시 연결")}</button>}
      </div>
      <iframe ref={frame} title={t("검수 사이트 미리보기")} src={preview.url} onLoad={() => setLoad((n) => n + 1)} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
    </div>
  );
}
