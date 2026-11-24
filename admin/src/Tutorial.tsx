import { useEffect, useId, useRef, useState } from 'react';
import { useLocale } from './locale.tsx';
import './tutorial.css';

const MEDIA = '/tutorial/review-guide';
const POSTER = `${MEDIA}-poster.jpg`;

interface Chapter { name: string; time: number }

const labels = {
  ko: {
    button: '사용법 영상', poster: '사용법 영상 보기', title: '검수핀 사용법 영상', close: '닫기',
    video: '검수핀 사용법', chapters: '영상 챕터', error: '영상을 불러오지 못했어요. 창을 닫고 다시 열어 주세요.',
  },
  en: {
    button: 'Tutorial video', poster: 'Watch tutorial video', title: 'Geomsupin tutorial video', close: 'Close',
    video: 'Geomsupin tutorial', chapters: 'Video chapters', error: 'The video didn’t load. Close this window and try again.',
  },
};

function PlayIcon() {
  return <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5.4a1.2 1.2 0 0 1 1.8-1l10.1 6.5a1.3 1.3 0 0 1 0 2.2L9.8 19.6a1.2 1.2 0 0 1-1.8-1z" />
  </svg>;
}

export function TutorialButton({ variant = 'header' }: { variant?: 'header' | 'poster' }) {
  const { locale } = useLocale();
  const copy = labels[locale];
  const [open, setOpen] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const koreanCaptions = useRef<HTMLTrackElement>(null);
  const englishCaptions = useRef<HTMLTrackElement>(null);
  const captionOrder = locale === 'en' ? ['en', 'ko'] as const : ['ko', 'en'] as const;

  useEffect(() => {
    const modal = dialog.current;
    const media = video.current;
    if (!open || !modal) return;
    modal.showModal();
    closeButton.current?.focus();
    return () => {
      media?.pause();
      if (modal.open) modal.close();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const [preferred, alternate] = locale === 'en'
      ? [englishCaptions.current, koreanCaptions.current]
      : [koreanCaptions.current, englishCaptions.current];
    const media = video.current;
    if (!preferred || !alternate || !media) return;

    const readChapters = () => {
      const cues = Array.from(preferred.track.cues ?? []);
      setChapters(cues.filter(cue => cue.id).map(cue => ({ name: cue.id, time: cue.startTime })));
    };
    // Some browsers apply their initial caption preference after mounting the tracks.
    const deduplicate = () => {
      if (preferred.track.mode === 'showing' && alternate.track.mode === 'showing') {
        alternate.track.mode = 'disabled';
      }
    };
    media.addEventListener('playing', deduplicate, { once: true });
    preferred.addEventListener('load', readChapters);
    alternate.track.mode = 'disabled';
    preferred.track.mode = 'showing';
    readChapters();
    return () => {
      media.removeEventListener('playing', deduplicate);
      preferred.removeEventListener('load', readChapters);
    };
  }, [open, locale]);

  function show() {
    setMediaError(false);
    setChapters([]);
    setOpen(true);
  }

  function finish() {
    video.current?.pause();
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }

  const isPoster = variant === 'poster';
  return <>
    <button ref={trigger} type="button" className={isPoster ? 'tutorial-poster' : 'btn tutorial-button'}
      aria-haspopup="dialog" aria-controls={id} onClick={show}>
      {isPoster
        ? <>
          <img src={POSTER} alt="" width="1440" height="810" decoding="async" />
          <span className="tutorial-poster-label"><PlayIcon />{copy.poster}</span>
        </>
        : <><PlayIcon />{copy.button}</>}
    </button>
    <dialog ref={dialog} id={id} className="tutorial-dialog" aria-labelledby={`${id}-title`}
      onCancel={event => { event.preventDefault(); finish(); }}>
      <div className="tutorial-dialog-heading">
        <h2 id={`${id}-title`}>{copy.title}</h2>
        <button ref={closeButton} className="btn tutorial-close" type="button" onClick={finish}>
          {copy.close}
        </button>
      </div>
      {open && <video ref={video} className="tutorial-video" aria-label={copy.video}
        controls autoPlay playsInline preload="metadata" poster={POSTER} src={`${MEDIA}.mp4`} onError={() => setMediaError(true)}>
        {captionOrder.map(language => <track key={language} kind="captions" src={`${MEDIA}.${language}.vtt`}
          ref={language === 'ko' ? koreanCaptions : englishCaptions}
          srcLang={language} label={language === 'ko' ? '한국어' : 'English'} default={language === locale} />)}
      </video>}
      {!mediaError && chapters.length > 0 && <nav className="tutorial-chapters" aria-label={copy.chapters}>
        {chapters.map(chapter => <button key={chapter.name} className="btn sm" type="button" onClick={() => {
          if (video.current) video.current.currentTime = chapter.time;
        }}>{chapter.name}</button>)}
      </nav>}
      {mediaError && <p className="tutorial-error" role="alert">{copy.error}</p>}
    </dialog>
  </>;
}
