import { useLocale } from '../locale.tsx';
import { CopyButton, Icon } from '../ui.tsx';
import { targetUrlLabel } from '../../../shared/target-url.ts';
import type { Site } from '../types.ts';

export function InviteCard({ site }: { site: Site }) {
  const { locale, t } = useLocale();
  const link = site.links?.find(l => l.active);
  const target = site.preview?.url;
  if (!target || !link || site.status !== 'active') {
    const message = site.status === 'done' ? t("검수가 종료됐어요.") : !target ? t("사이트 주소를 저장하면 초대할 수 있어요.") : t("고급 설정의 링크 관리에서 새 링크를 만들어 주세요.");
    return <section className="card pad sharecard" aria-label={t("초대 링크")}><div className="settings-heading"><span className="section-mark"><Icon name="bookmark" /></span><div><h2>{t("참여자 초대하기")}</h2><p>{message}</p></div></div></section>;
  }
  const message = locale === 'en'
    ? `You’re invited to review ${site.name}.\nReview site: ${target}\nOpen the invitation to save your bookmark, then click it on the review site.\n${link.shareUrl}`
    : `[${site.name}] 검수에 참여해 주세요.\n검수할 사이트: ${target}\n초대 링크에서 북마크를 저장한 뒤, 검수할 사이트에서 북마크를 누르세요.\n${link.shareUrl}`;
  return (
    <section className="card sharecard" aria-label={t("초대 링크")}>
      <div className="settings-heading"><span className="section-mark"><Icon name="bookmark" /></span><div><h2>{t("참여자 초대하기")}</h2><p>{t("이 링크를 보내면 참여자가 북마크를 설치할 수 있어요.")}</p></div></div>
      <div className="shareurl">
        <input className="input" readOnly value={link.shareUrl} onFocus={e => e.currentTarget.select()} aria-label={t("초대 링크")} />
        <CopyButton text={link.shareUrl} label={t("링크 복사")} className="btn primary lg" />
      </div>
      <div className="row wrap share-actions">
        <CopyButton text={message} label={t("안내 문구까지 복사")} className="btn ghost sm" />
        <a className="btn ghost sm" href={link.shareUrl} target="_blank" rel="noreferrer">{t("받는 사람 화면 보기")} <Icon name="external" /></a>
        <a className="small urltext share-target" href={target} target="_blank" rel="noopener noreferrer" title={target}>{targetUrlLabel(target)}</a>
      </div>
    </section>
  );
}
