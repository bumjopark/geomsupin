import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocale } from './locale.tsx';

const currentIsHttp = window.location.protocol === 'http:';
const PeerContext = createContext<string | null>(null);
let peerRequest: Promise<string | null> | undefined;

async function loadPeer(): Promise<string | null> {
  try {
    const response = await fetch('/api/installation', { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) return null;
    const { peerReviewUrl } = await response.json();
    if (typeof peerReviewUrl !== 'string') return null;
    const peer = new URL(peerReviewUrl);
    if (peer.protocol !== (currentIsHttp ? 'https:' : 'http:') || peer.username || peer.password) return null;
    return peer.origin + '/';
  } catch {
    return null;
  }
}

export function InstallationProvider({ children }: { children: ReactNode }) {
  const [peer, setPeer] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    peerRequest ??= loadPeer();
    void peerRequest.then(url => { if (active) setPeer(url); });
    return () => { active = false; };
  }, []);
  return <PeerContext.Provider value={peer}>{children}</PeerContext.Provider>;
}

export function usePeerReviewUrl() {
  return useContext(PeerContext);
}

export function PeerReviewLink({ url }: { url: string }) {
  const { t } = useLocale();
  return <a className="review-entry-link" href={url} referrerPolicy="no-referrer" rel="noreferrer">
    {t(currentIsHttp ? 'HTTPS 사이트용 검수핀 열기' : 'HTTP 사이트용 검수핀 열기')}
  </a>;
}

export function InstallationNotice() {
  const { t } = useLocale();
  const peer = usePeerReviewUrl();
  return <aside className={`review-entry${currentIsHttp ? ' review-entry-http' : ''}`} aria-label={t('검수핀 접속 방식')}>
    <div className="review-entry-in">
      <strong>{t(currentIsHttp ? 'HTTP 사이트용 검수핀' : 'HTTPS 사이트용 검수핀')}</strong>
      {peer && <PeerReviewLink url={peer} />}
      {currentIsHttp && <span>{t('HTTP에서는 초대 링크·댓글·캡처가 암호화 없이 전송됩니다.')}</span>}
      {peer && <span>{t('두 입구의 프로젝트와 초대 링크는 별도로 관리됩니다.')}</span>}
    </div>
  </aside>;
}
