import { useEffect, useId, useRef, useState } from 'react';
import type { Locale } from '../../shared/locale.ts';
import { useLocale } from './locale.tsx';
import './tutorial.css';

const MEDIA = '/tutorial/review-guide';
const mediaFiles = {
  ko: { video: `${MEDIA}.mp4`, poster: `${MEDIA}-poster.jpg`, chapters: `${MEDIA}.ko.vtt` },
  en: { video: `${MEDIA}.en.mp4`, poster: `${MEDIA}-poster.en.jpg`, chapters: `${MEDIA}.en.vtt` },
};

interface Chapter { name: string; time: number }

const labels = {
  ko: {
    button: '사용법 영상', poster: '사용법 영상 보기', title: '검수핀 사용법 영상', close: '닫기',
    video: '검수핀 사용법', chapters: '영상 챕터', download: 'MP4 내려받기', error: '영상을 불러오지 못했어요. 창을 닫고 다시 열어 주세요.',
  },
  en: {
    button: 'Tutorial video', poster: 'Watch tutorial video', title: 'Geomsupin tutorial video', close: 'Close',
    video: 'Geomsupin tutorial', chapters: 'Video chapters', download: 'Download MP4', error: 'The video didn’t load. Close this window and try again.',
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
  const files = mediaFiles[locale];
  const [open, setOpen] = useState(false);
  const [failedLocale, setFailedLocale] = useState<Locale | null>(null);
  const [chapterState, setChapterState] = useState<{ locale: Locale; entries: Chapter[] } | null>(null);
  const mediaError = failedLocale === locale;
  const chapters = chapterState?.locale === locale ? chapterState.entries : [];
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const chapterTrack = useRef<HTMLTrackElement>(null);

  useEffect(() => {
    const modal = dialog.current;
    if (!open || !modal) return;
    modal.showModal();
    closeButton.current?.focus();
    return () => {
      if (modal.open) modal.close();
    };
  }, [open]);

  useEffect(() => {
    const element = chapterTrack.current;
    const media = video.current;
    if (!open || !element || !media) return;

    const readChapters = () => {
      const entries = Array.from(element.track.cues ?? [])
        .filter(cue => cue.id).map(cue => ({ name: cue.id, time: cue.startTime }));
      setChapterState({ locale, entries });
    };
    element.addEventListener('load', readChapters);
    element.track.mode = 'hidden';
    if (element.readyState === HTMLTrackElement.LOADED) readChapters();
    return () => {
      media.pause();
      element.removeEventListener('load', readChapters);
    };
  }, [open, locale]);

  function show() {
    setFailedLocale(null);
    setChapterState(null);
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
          <img src={files.poster} alt="" width="1440" height="810" decoding="async" />
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
      {open && <video key={locale} ref={video} className="tutorial-video" aria-label={copy.video}
        controls autoPlay playsInline preload="metadata" poster={files.poster} src={files.video}
        onLoadedData={() => setFailedLocale(null)} onError={() => setFailedLocale(locale)}>
        <track ref={chapterTrack} kind="metadata" src={files.chapters} srcLang={locale} label={copy.chapters} />
      </video>}
      {!mediaError && chapters.length > 0 && <nav className="tutorial-chapters" aria-label={copy.chapters}>
        {chapters.map(chapter => <button key={chapter.name} className="btn sm" type="button" onClick={() => {
          if (video.current) video.current.currentTime = chapter.time;
        }}>{chapter.name}</button>)}
      </nav>}
      {open && <a className="btn sm tutorial-download" href={files.video} download>{copy.download}</a>}
      {mediaError && <p className="tutorial-error" role="alert">{copy.error}</p>}
    </dialog>
  </>;
}
