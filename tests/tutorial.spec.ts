import { expect, test, type Locator } from '@playwright/test';
import { newTestContext } from './browser.ts';
import { createSite, installManager, startTestApp } from './helpers.ts';

const files = {
  video: '/tutorial/review-guide.mp4',
  korean: '/tutorial/review-guide.ko.vtt',
  english: '/tutorial/review-guide.en.vtt',
  poster: '/tutorial/review-guide-poster.jpg',
};
const title = '검수핀 사용법 영상';

const showingCaptions = (video: Locator) => video.evaluate(element =>
  Array.from((element as HTMLVideoElement).textTracks)
    .filter(track => track.mode === 'showing').map(track => track.language));

test('공개·초대·관리 헤더에서 사용법 영상을 열고 키보드로 재생을 끝낸다', async ({ browser }) => {
  const t = await startTestApp();
  const context = await newTestContext(browser);
  try {
    const owner = await installManager(t);
    const { token } = await createSite(t, owner.headers, '사용법 영상 검수', 'http://staging-tutorial.example');
    const origin = await t.app.listen({ host: '127.0.0.1', port: 0 });
    t.ctx.config.allowedHosts.add(new URL(origin).host);

    const range = await context.request.get(origin + files.video, { headers: { Range: 'bytes=0-63' } });
    expect(range.status()).toBe(206);
    expect(range.headers()['content-type']).toMatch(/^video\/mp4(?:;|$)/);
    expect(range.headers()['content-range']).toMatch(/^bytes 0-63\/\d+$/);
    expect(await range.body()).toHaveLength(64);
    const head = await context.request.head(origin + files.video);
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
    const track = video.locator('track[srclang=ko]');
    await expect(dialog).toBeVisible();
    await expect(close).toBeFocused();
    await expect(video).toHaveAttribute('controls', '');
    await expect(video).toHaveAttribute('poster', files.poster);
    await expect(track).toHaveAttribute('src', files.korean);
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).duration)).toBeGreaterThan(1);
    await expect.poll(() => track.evaluate(el => (el as HTMLTrackElement).track.cues?.length ?? 0)).toBeGreaterThan(0);
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
    expect(await showingCaptions(video)).toEqual(['ko']);
    const chapters = dialog.getByRole('navigation', { name: '영상 챕터' });
    await expect(chapters.getByRole('button')).toHaveCount(5);
    const shareCue = await track.evaluate(el => (el as HTMLTrackElement).track.cues?.getCueById('초대 공유')?.startTime);
    expect(shareCue).toBeGreaterThan(0);
    await chapters.getByRole('button', { name: '초대 공유' }).click();
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
    await page.route(`**${files.video}`, route => route.abort());
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

test('영어 사용법 영상의 버튼·챕터·오류를 번역하고 두 자막 언어를 선택할 수 있다', async ({ browser }) => {
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
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Geomsupin tutorial video' });
    const video = dialog.locator('video');
    const english = video.locator('track[srclang=en]');
    const korean = video.locator('track[srclang=ko]');
    await expect(video).toHaveAttribute('aria-label', 'Geomsupin tutorial');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(english).toHaveAttribute('src', files.english);
    await expect(korean).toHaveAttribute('src', files.korean);
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
    expect(await showingCaptions(video)).toEqual(['en']);
    const chapters = dialog.getByRole('navigation', { name: 'Video chapters' });
    await expect(chapters.getByRole('button')).toHaveText([
      'Connect a project', 'Share an invitation', 'Install the bookmark', 'Pin and comment', 'Replies and status',
    ]);
    await chapters.getByRole('button', { name: 'Install the bookmark' }).click();
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(14.4);

    // Native media controls choose between the two tracks by updating these modes.
    await english.evaluate(el => { (el as HTMLTrackElement).track.mode = 'disabled'; });
    await korean.evaluate(el => { (el as HTMLTrackElement).track.mode = 'showing'; });
    await expect.poll(() => korean.evaluate(el => (el as HTMLTrackElement).track.cues?.length ?? 0)).toBeGreaterThan(0);
    await expect(chapters.getByRole('button', { name: 'Install the bookmark' })).toBeVisible();
    const resumedAt = await video.evaluate(async element => {
      const player = element as HTMLVideoElement;
      player.pause();
      const pausedAt = player.currentTime;
      await player.play();
      return pausedAt;
    });
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(resumedAt + 0.15);
    expect(await showingCaptions(video)).toEqual(['ko']);
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();

    await page.getByRole('button', { name: '한국어', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '사용법 영상', exact: true }).click();
    const koreanDialog = page.getByRole('dialog', { name: title });
    const koreanVideo = koreanDialog.locator('video');
    await expect.poll(() => koreanVideo.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15);
    expect(await showingCaptions(koreanVideo)).toEqual(['ko']);
    await expect(koreanDialog.getByRole('navigation', { name: '영상 챕터' }).getByRole('button')).toHaveCount(5);
    await page.keyboard.press('Escape');

    // A fresh context prevents previously buffered media from bypassing the failure route.
    const offline = await newTestContext(browser);
    try {
      const offlinePage = await offline.newPage();
      await offlinePage.route(`**${files.video}`, route => route.abort());
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
