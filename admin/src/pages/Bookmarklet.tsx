import { useLocale } from '../locale.tsx';
import { useId, useRef, useState } from 'react';
import { bookmarkletHref } from '../../../shared/bookmarklet.ts';
import { targetUrlLabel } from '../../../shared/target-url.ts';
import { reviewerPid } from '../reviewer.ts';
import { CopyButton, Icon } from '../ui.tsx';

interface BookmarkletProps {
  base: string;
  widgetKey: string;
  token: string;
  invitationUrl: string;
  project: string;
  preview: { url: string; id: string };
}

export function Bookmarklet({ base, widgetKey, token, project, preview, invitationUrl }: BookmarkletProps) {
  const { locale, t } = useLocale();
  const [pid] = useState(reviewerPid);
  const instructions = useId();
  const help = useRef<HTMLDetailsElement>(null);
  const href = bookmarkletHref({ locale, base, key: widgetKey, token, pid, previewId: preview.id, origin: new URL(preview.url).origin });
  const title = `${t("검수핀")} · ${project}`;
  const modifier = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';

  return <div className="bookmark-flow">
    <section className="card bookmark-transfer" aria-labelledby="transfer-title">
      <h2 id="transfer-title">{t("PC에서 북마크 설치하기")}</h2>
      <p>{t("이 초대 링크를 복사해 PC 브라우저에서 여세요.")}</p>
      <div className="row wrap">
        <CopyButton text={invitationUrl} label={t("초대 링크 복사")} className="btn primary" />
        <a className="small" href={preview.url} target="_blank" rel="noopener noreferrer">{t("검수할 사이트 열기")} <Icon name="external" /></a>
      </div>
    </section>
    <section className="card bookmark-install" aria-labelledby="install-title">
      <div className="bookmark-copy">
        <h2 id="install-title">{t("북마크바에 끌어다 놓기")}</h2>
        <p id={instructions}>{t("아래 검수핀을 브라우저 주소창 아래")} <strong>{t("북마크바")}</strong>{t("로 끌어다 놓으세요.")}</p>
        <div className="bookmark-shortcut"><span>{t("북마크바가 안 보이나요?")}</span> <kbd>{modifier}</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd></div>
      </div>
      <div className="bookmark-stage">
        <div className="bookmark-demo" aria-hidden="true">
          <div className="demo-toolbar"><span /><span /><span /><i /></div>
          <div className="demo-bookmarks"><Icon name="bookmark" /><b>{t("북마크바")}</b><span className="demo-slot" /></div>
        </div>
        <div className="bookmark-trail" aria-hidden="true"><Icon name="up" /><span /></div>
        <a className="bookmark-drag" data-bookmarklet draggable="true" aria-describedby={instructions}
          ref={node => { node?.setAttribute('href', href); }}
          onClick={event => {
            event.preventDefault();
            if (help.current) {
              help.current.open = true;
              help.current.querySelector('summary')?.focus();
            }
          }}>
          <Icon name="grip" /><Icon name="bookmark" /><span>{title}</span>
        </a>
      </div>
      <details ref={help} className="bookmark-help">
        <summary>{t("드래그가 안 되나요?")}</summary>
        <ol>
          <li>{locale === 'en' && 'Click '}<strong>{t("북마크 코드 복사")}</strong>{locale === 'en' ? '.' : '를 눌러 주세요.'}</li>
          <li>{t("현재 페이지를 북마크바에 저장하세요.")} <kbd>{modifier}</kbd> + <kbd>D</kbd></li>
          <li>{t("저장한 북마크를 수정해")} <strong>{t("URL 칸")}</strong>{t("에 복사한 코드를 붙여 넣으세요.")}</li>
        </ol>
        <CopyButton text={href} label={t("북마크 코드 복사")} className="btn sm" />
      </details>
    </section>
    <section className="card bookmark-open" aria-labelledby="open-title">
      <div className="bookmark-open-icon"><Icon name="window" /></div>
      <div className="grow">
        <h2 id="open-title">{t("사이트에서 북마크 누르기")}</h2>
        <p>{t("검수할 페이지에서 방금 저장한 북마크를 누르세요.")}</p>
        <span className="bookmark-destination small urltext">{targetUrlLabel(preview.url)}</span>
      </div>
      <a className="btn" href={preview.url} target="_blank" rel="noopener noreferrer" title={targetUrlLabel(preview.url)}>{t("검수할 사이트 열기")} <Icon name="external" /></a>
    </section>
  </div>;
}
