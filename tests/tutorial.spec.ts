import { expect, test, type Locator } from '@playwright/test';
import { newTestContext } from './browser.ts';
import { createSite, installManager, startTestApp } from './helpers.ts';

const files = {
  ko: { video: '/tutorial/review-guide.mp4', chapters: '/tutorial/review-guide.ko.vtt', poster: '/tutorial/review-guide-poster.jpg' },
  en: { video: '/tutorial/review-guide.en.mp4', chapters: '/tutorial/review-guide.en.vtt', poster: '/tutorial/review-guide-poster.en.jpg' },
};
const title = '검수핀 사용법 영상';

async function expectChapterMetadata(video: Locator, language: 'ko' | 'en') {
  const track = video.locator('track');
  await expect(track).toHaveCount(1);
  await expect(track).toHaveAttribute('src', files[language].chapters);
  await expect(track).toHaveAttribute('kind', 'metadata');
  await expect.poll(() => track.evaluate(element => (element as HTMLTrackElement).track.cues?.length ?? 0)).toBeGreaterThan(0);
  expect(await video.evaluate(element => Array.from((element as HTMLVideoElement).textTracks)
    .map(track => [track.kind, track.mode]))).toEqual([['metadata', 'hidden']]);
  return track;
}

test('공개·초대·관리 헤더에서 사용법 영상을 열고 키보드로 재생을 끝낸다', async ({ browser }) => {
  const t = await startTestApp();
  const context = await newTestContext(browser);
  try {
    const owner = await installManager(t);
    const { token } = await createSite(t, owner.headers, '사용법 영상 검수', 'http://staging-tutorial.example');
    const origin = await t.app.listen({ host: '127.0.0.1', port: 0 });
    t.ctx.config.allowedHosts.add(new URL(origin).host);

    const range = await context.request.get(origin + files.ko.video, { headers: { Range: 'bytes=0-63' } });
    expect(range.status()).toBe(206);
    expect(range.headers()['content-type']).toMatch(/^video\/mp4(?:;|$)/);
    expect(range.headers()['content-range']).toMatch(/^bytes 0-63\/\d+$/);
    expect(await range.body()).toHaveLength(64);
    const head = await context.request.head(origin + files.ko.video);
    expect(head.status()).toBe(200);
    expect(head.headers()['content-length']).toBe(range.headers()['content-range']?.split('/')[1]);
    expect(await head.body()).toHaveLength(0);

    const page = await context.newPage();
    await page.goto(origin);
    const button = page.getByRole('button', { name: '사용법 영상', exact: true });
    const poster = page.getByRole('button', { name: '사용법 영상 보기', exact: true });
    await expect(button).toBeVisible();
    await expect(poster).toBeVisible();
    expect(await button.getAttribute('aria-controls')).not.toBe(await poster.getAttribute('aria-controls'));
    await expect.poll(() => poster.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('video')).toHaveCount(0);

    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: title });
    const close = dialog.getByRole('button', { name: '닫기' });
    const video = dialog.locator('video');
    await expect(dialog).toBeVisible();
    await expect(close).toBeFocused();
    await expect(video).toHaveAttribute('controls', '');
    await expect(video).toHaveAttribute('poster', files.ko.poster);
    await expect(video).toHaveAttribute('src', files.ko.video);
    const download = dialog.getByRole('link', { name: 'MP4 내려받기' });
    await expect(download).toHaveAttribute('href', files.ko.video);
    await expect(download).toHaveAttribute('download', '');
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).duration)).toBeGreaterThan(1);
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
    const track = await expectChapterMetadata(video, 'ko');
    const chapters = dialog.getByRole('navigation', { name: '영상 챕터' });
    await expect(chapters.getByRole('button')).toHaveCount(5);
    const shareCue = await track.evaluate(el => (el as HTMLTrackElement).track.cues?.getCueById('초대 공유')?.startTime);
    expect(shareCue).toBeGreaterThan(0);
    const shareChapter = chapters.getByRole('button', { name: '초대 공유' });
    await shareChapter.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(shareCue!);
    const mountedVideo = await video.elementHandle();
    expect(await mountedVideo!.evaluate(el => (el as HTMLVideoElement).paused)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
    expect(await mountedVideo!.evaluate(el => (el as HTMLVideoElement).paused)).toBe(true);
    await expect(page.locator('video')).toHaveCount(0);

    await poster.click();
    await expect(dialog).toBeVisible();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(poster).toBeFocused();

    await page.goto(`${origin}/r/${token}`);
    await expect(page.getByRole('heading', { name: '사용법 영상 검수' })).toBeVisible();
    await expect(button).toBeVisible();
    await expect(poster).toHaveCount(0);
    await button.click();
    await expect(dialog).toBeVisible();
    await close.click();

    const separator = owner.cookie.indexOf('=');
    await context.addCookies([{ url: origin, name: owner.cookie.slice(0, separator), value: owner.cookie.slice(separator + 1) }]);
    await page.goto(`${origin}/sites`);
    await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible();
    await expect(button).toBeVisible();
    await button.click();
    await expect(dialog).toBeVisible();
    await close.click();
    await expect(button).toBeFocused();
  } finally {
    await context.close();
    await t.close();
  }
});

test('작은 터치 화면에서 포스터를 열고 다운로드 실패 시 안내한다', async ({ browser }) => {
  const t = await startTestApp();
  const context = await newTestContext(browser, { hasTouch: true, isMobile: true, viewport: { width: 320, height: 620 } });
  try {
    const origin = await t.app.listen({ host: '127.0.0.1', port: 0 });
    t.ctx.config.allowedHosts.add(new URL(origin).host);
    const page = await context.newPage();
    await page.route(`**${files.ko.video}`, route => route.abort());
    await page.goto(origin);

    const poster = page.getByRole('button', { name: '사용법 영상 보기' });
    await poster.tap();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(620);
    await expect(dialog.getByRole('alert')).toContainText('영상을 불러오지 못했어요');
    await dialog.getByRole('button', { name: '닫기' }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(poster).toBeFocused();
  } finally {
    await context.close();
    await t.close();
  }
});

test('영어 영상·포스터·다운로드를 선택하고 자막 트랙 없이 영어 챕터를 제공한다', async ({ browser }) => {
  const t = await startTestApp();
  const context = await newTestContext(browser);
  try {
    const origin = await t.app.listen({ host: '127.0.0.1', port: 0 });
    t.ctx.config.allowedHosts.add(new URL(origin).host);
    const page = await context.newPage();
    await page.goto(origin);
    const language = page.getByRole('button', { name: 'English', exact: true });
    await language.click();
    await expect(language).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(language).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 320, height: 620 });

    const button = page.getByRole('button', { name: 'Tutorial video', exact: true });
    const poster = page.getByRole('button', { name: 'Watch tutorial video', exact: true });
    await expect(button).toBeVisible();
    await expect(poster).toBeVisible();
    await expect(poster.locator('img')).toHaveAttribute('src', files.en.poster);
    await expect.poll(() => poster.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Geomsupin tutorial video' });
    const video = dialog.locator('video');
    await expect(video).toHaveAttribute('aria-label', 'Geomsupin tutorial');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(video).toHaveAttribute('poster', files.en.poster);
    await expect(video).toHaveAttribute('src', files.en.video);
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
    const english = await expectChapterMetadata(video, 'en');
    const chapters = dialog.getByRole('navigation', { name: 'Video chapters' });
    await expect(chapters.getByRole('button')).toHaveCount(5);
    const bookmark = await english.evaluate(el => {
      const cues = Array.from((el as HTMLTrackElement).track.cues ?? []).filter(cue => cue.id);
      return { label: cues[2]!.id, start: cues[2]!.startTime };
    });
    const bookmarkChapter = chapters.getByRole('button', { name: bookmark.label, exact: true });
    await bookmarkChapter.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(bookmark.start);
    const download = dialog.getByRole('link', { name: 'Download MP4' });
    await expect(download).toHaveAttribute('href', files.en.video);
    const [downloaded] = await Promise.all([page.waitForEvent('download'), download.click()]);
    expect(downloaded.suggestedFilename()).toBe('review-guide.en.mp4');
    expect(await downloaded.failure()).toBeNull();
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();

    await page.getByRole('button', { name: '한국어', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '사용법 영상', exact: true }).click();
    const koreanDialog = page.getByRole('dialog', { name: title });
    const koreanVideo = koreanDialog.locator('video');
    await expect.poll(() => koreanVideo.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
    await expect(koreanVideo).toHaveAttribute('src', files.ko.video);
    await expectChapterMetadata(koreanVideo, 'ko');
    await expect(koreanDialog.getByRole('navigation', { name: '영상 챕터' }).getByRole('button')).toHaveCount(5);
    await page.keyboard.press('Escape');

    // A fresh context prevents previously buffered media from bypassing the failure route.
    const offline = await newTestContext(browser);
    try {
      const offlinePage = await offline.newPage();
      await offlinePage.route(`**${files.en.video}`, route => route.abort());
      await offlinePage.goto(origin);
      await offlinePage.getByRole('button', { name: 'English', exact: true }).click();
      const trigger = offlinePage.getByRole('button', { name: 'Tutorial video', exact: true });
      await trigger.click();
      const errorDialog = offlinePage.getByRole('dialog', { name: 'Geomsupin tutorial video' });
      await expect(errorDialog.getByRole('alert')).toContainText('The video didn’t load.');
      await errorDialog.getByRole('button', { name: 'Close' }).click();
      await expect(trigger).toBeFocused();
    } finally {
      await offline.close();
    }
  } finally {
    await context.close();
    await t.close();
  }
});
