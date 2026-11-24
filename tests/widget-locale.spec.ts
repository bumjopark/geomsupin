import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { newTestContext } from './browser.ts';
import { createSite, installManager, startTestApp } from './helpers.ts';

test('영어 북마크가 원본 탭의 핀·대화·상태를 번역하고 저장 형식을 보존한다', async ({ browser }) => {
  test.setTimeout(60_000);
  const app = 'http://127.0.0.1:8490';
  const stage = 'http://localhost:8492';
  const target = stage + '/review';
  const t = await startTestApp({ PUBLIC_URL: app, ALLOWED_HOSTS: '127.0.0.1:8490,localhost:80' });
  const context = await newTestContext(browser);
  const staging = createServer();
  try {
    const { headers } = await installManager(t);
    const { site } = await createSite(t, headers, '언어 검수', target);
    await t.app.listen({ host: '127.0.0.1', port: 8490 });
    staging.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><script async src="${app}/w.js" data-gp-preview="${site.preview.id}"></script><h1 style="width:max-content">원본 제목</h1>`);
    });
    await new Promise<void>((resolve, reject) => {
      staging.once('error', reject);
      staging.listen(8492, '127.0.0.1', resolve);
    });
    const page = await context.newPage();
    const invite = await context.newPage();
    await invite.goto(site.links[0].shareUrl);
    await invite.getByRole('button', { name: 'English', exact: true }).click();
    await expect(invite.locator('html')).toHaveAttribute('lang', 'en');
    const bookmark = invite.locator('a[data-bookmarklet]');
    await expect(bookmark).toBeVisible();
    const href = await bookmark.getAttribute('href');
    expect(href).toMatch(/^javascript:/);

    await page.goto(target);
    await page.evaluate(url => { location.href = url; }, href!);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.locator('gp-widget')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Leave a request' }).click();
    await expect(page.getByRole('status')).toContainText('Click where a change is needed');
    const pin = await page.getByRole('heading', { name: '원본 제목' }).boundingBox();
    await page.mouse.click(pin!.x + pin!.width / 2, pin!.y + pin!.height / 2);

    const composer = page.getByRole('dialog', { name: 'Leave a request' });
    await composer.getByRole('textbox', { name: 'My name' }).fill('검수자');
    await composer.getByRole('textbox', { name: 'Request details' }).fill('사용자가 작성한 내용');
    await composer.getByRole('button', { name: 'Bug' }).click();
    await composer.getByRole('button', { name: 'Submit', exact: true }).click();
    await page.locator('.marker', { hasText: /^1$/ }).click();

    const thread = page.getByRole('dialog', { name: 'Conversation' });
    await expect(thread).toContainText('사용자가 작성한 내용');
    await expect(thread).toContainText('검수자 (me)');
    await thread.getByRole('textbox', { name: 'Comment' }).fill('원본 댓글');
    await thread.getByRole('button', { name: 'Send' }).click();
    await expect(thread).toContainText('원본 댓글');
    const requestDetail = /\/api\/w\/requests\/[a-f0-9-]{36}$/;
    await page.route(requestDetail, route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 403, headers: { 'access-control-allow-origin': stage }, json: {
          error: { code: 'not_yours', message: '본인만 바꿀 수 있어요' },
        } })
      : route.continue());
    const resolve = thread.getByRole('button', { name: 'Resolve' });
    await resolve.click();
    await expect(page.getByText('Only the author can edit or delete this item.', { exact: true })).toBeVisible();
    await page.unroute(requestDetail);
    await resolve.click();
    await expect(thread).toContainText('marked it as resolved');
    const [saved] = await t.sql`select kind, status, body from requests where site_id = ${site.id}`;
    expect(saved).toEqual({ kind: '버그', status: '완료', body: '사용자가 작성한 내용' });

    await invite.getByRole('button', { name: 'Preview in browser', exact: true }).click();
    const preview = invite.frameLocator('iframe');
    await expect(preview.locator('gp-widget')).toHaveAttribute('lang', 'en');
    await preview.locator('.marker', { hasText: /^1$/ }).click();
    await expect(preview.getByRole('dialog', { name: 'Conversation' })).toContainText('원본 댓글');

    await invite.getByRole('button', { name: '한국어', exact: true }).click();
    await expect(preview.locator('gp-widget')).toHaveAttribute('lang', 'ko');
    await invite.getByRole('button', { name: '북마크 설치로 돌아가기', exact: true }).click();
    const koBookmark = await bookmark.getAttribute('href');
    expect(koBookmark).toMatch(/^javascript:/);
    expect(koBookmark).not.toBe(href);

    await page.bringToFront();
    const mismatch = page.waitForEvent('dialog', { timeout: 5_000 }).then(async notice => {
      const message = notice.message();
      await notice.dismiss();
      return message;
    });
    await page.evaluate(url => { location.href = url; }, koBookmark!);
    expect(await mismatch).toContain('새로고침');
    await page.reload();
    await page.evaluate(url => { location.href = url; }, koBookmark!);
    await expect(page.getByRole('button', { name: '요청 남기기' })).toBeVisible();
    await expect(page.locator('gp-widget')).toHaveAttribute('lang', 'ko');
  } finally {
    await context.close();
    try { await t.close(); }
    finally { await new Promise<void>(resolve => staging.close(() => resolve())); }
  }
});
