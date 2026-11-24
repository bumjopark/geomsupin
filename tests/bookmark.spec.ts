import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { BookmarkBar } from './bookmark-bar.ts';
import { newTestContext } from './browser.ts';
import { createSite, installManager, startTestApp } from './helpers.ts';
import { managerCookie } from './review-browser.ts';

const APP = 'http://127.0.0.1:8370';
const STAGE = 'http://localhost:8372';
const TARGET = STAGE + '/orders';
const BOOKMARK_SESSION = APP + '/api/w/bookmark-session';
const REVIEWER = '북마크 검수자';
const BODY = '원본 주문 화면의 제목 배치 확인';
const COMMENT = '원본 화면에서 쓴 추가 댓글';
const MASK_TEXT = '합성 내부 주문 정보';

function respond(res: ServerResponse, html: string) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  });
  res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>합성 주문 사이트</title><style>body{font:18px sans-serif;margin:36px;color:#18212a}input,label,button{display:block;margin:8px 0}h1{width:max-content}#private{background:#f00;width:280px;height:70px;display:grid;place-items:center}</style></head><body>${html}</body></html>`);
}

async function fixture(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/login' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    if (form.get('account') === 'fixture-order-operator' && form.get('password') === 'synthetic-browser-password') {
      res.writeHead(303, { Location: '/orders', 'Set-Cookie': 'order_fixture_session=authenticated; Path=/; HttpOnly; SameSite=Lax' });
      res.end();
      return;
    }
    res.writeHead(403).end();
    return;
  }
  if (req.url === '/login') {
    respond(res, '<h1>주문 사이트 로그인</h1><form action="/login" method="post"><label>계정 <input name="account" required></label><label>비밀번호 <input name="password" type="password" required></label><button>로그인</button></form>');
    return;
  }
  if (req.url === '/orders' && /(?:^|; )order_fixture_session=authenticated(?:;|$)/.test(req.headers.cookie ?? '')) {
    respond(res, `<h1>내 주문</h1><p>fixture-order-operator 계정으로 로그인됨</p><div id="private" data-review-mask>${MASK_TEXT}</div><a href="/orders">주문 화면 다시 열기</a>`);
    return;
  }
  if (req.url === '/orders') { res.writeHead(303, { Location: '/login' }).end(); return; }
  res.writeHead(404).end();
}

/** 렌더링된 초대 링크를 실제 브라우저의 javascript: URL 처리로 실행한다. */
async function runBookmark(page: Page, href: string) {
  expect(href).toMatch(/^javascript:/);
  await page.evaluate(url => { location.href = url; }, href);
}

test('프레임 금지 사이트에 로그인하고 초대 북마크로 원본 탭의 핀·캡처·댓글을 남기고 폐기한다', async ({ browser }, testInfo) => {
  const t = await startTestApp({ PUBLIC_URL: APP, ALLOWED_HOSTS: '127.0.0.1:8370,localhost:80' });
  const staging = createServer((req, res) => { void fixture(req, res).catch(() => res.writeHead(500).end()); });
  const manager = await newTestContext(browser);
  const bookmarkBar = process.env.PLAYWRIGHT_BOOKMARK_BAR === '1' ? new BookmarkBar(testInfo.outputPath('chromium-profile')) : undefined;
  let guest = bookmarkBar ? await bookmarkBar.create()
    : await newTestContext(browser, { viewport: { width: 1100, height: 780 }, deviceScaleFactor: 1 });
  try {
    await Promise.all([
      t.app.listen({ host: '127.0.0.1', port: 8370 }),
      new Promise<void>((resolve, reject) => {
        staging.once('error', reject);
        staging.listen(8372, '127.0.0.1', resolve);
      }),
    ]);
    const owner = await installManager(t);
    const { site } = await createSite(t, owner.headers, '주문 사이트 북마크 검수', TARGET);
    await managerCookie(manager, APP, owner.cookie);
    const settings = await manager.newPage();
    await settings.goto(`${APP}/sites/${site.id}/settings`);
    let invitePage = guest.pages()[0] ?? await guest.newPage();
    await invitePage.goto(APP + '/');
    const invitation = invitePage.getByRole('textbox', { name: '초대 링크' });
    const openInvitation = invitePage.getByRole('button', { name: '초대 열기' });
    await invitation.fill(STAGE + '/r/another-installation');
    await openInvitation.click();
    await expect(invitePage.getByRole('alert')).toContainText('이 검수핀에서 발급한 초대 링크를 입력해 주세요.');
    await expect(invitePage).toHaveURL(APP + '/');
    await invitation.fill(site.links[0].shareUrl);
    await openInvitation.click();
    await expect(invitePage).toHaveURL(site.links[0].shareUrl);
    const bookmark = invitePage.locator('a[data-bookmarklet]');
    await expect(bookmark).toBeVisible();
    const href = await bookmark.getAttribute('href');
    expect(href).toBeTruthy();
    await expect(invitePage.locator('iframe')).toHaveCount(0);
    if (bookmarkBar) {
      guest = await bookmarkBar.install(guest, invitePage, bookmark, href!);
      invitePage = guest.pages()[0] ?? await guest.newPage();
      await invitePage.goto(site.links[0].shareUrl);
    }

    const targetLink = invitePage.getByRole('link', { name: '검수할 사이트 열기' });
    await expect(targetLink).toHaveAttribute('href', TARGET);
    const [target] = await Promise.all([invitePage.waitForEvent('popup'), targetLink.click()]);
    await expect(target.getByRole('heading', { name: '주문 사이트 로그인' })).toBeVisible();
    await target.getByLabel('계정').fill('fixture-order-operator');
    await target.getByLabel('비밀번호').fill('synthetic-browser-password');
    const authenticated = target.waitForResponse(r => r.url() === TARGET && r.ok());
    await target.getByRole('button', { name: '로그인', exact: true }).click();
    expect((await (await authenticated).allHeaders())['x-frame-options']).toBe('DENY');
    await expect(target.getByRole('heading', { name: '내 주문' })).toBeVisible();
    await expect(target.locator('script[src], gp-widget')).toHaveCount(0);
    expect(target.frames()).toHaveLength(1);

    const opened = target.waitForResponse(r => r.url() === BOOKMARK_SESSION && r.request().method() === 'POST');
    if (bookmarkBar) await bookmarkBar.run(target);
    else await runBookmark(target, href!);
    expect((await opened).ok()).toBe(true);
    await expect(target).toHaveURL(TARGET);
    await expect(target.getByText('fixture-order-operator 계정으로 로그인됨')).toBeVisible();
    const pinButton = target.locator('.bar button.primary');
    await pinButton.click();
    await expect(target.locator('.shield')).toBeVisible();
    const title = (await target.getByRole('heading', { name: '내 주문' }).boundingBox())!;
    const mask = (await target.locator('#private').boundingBox())!;
    await target.mouse.click(title.x + title.width / 2, title.y + title.height / 2);
    const composer = target.getByRole('dialog', { name: '요청 남기기' });
    await composer.getByRole('textbox', { name: '내 별명' }).fill(REVIEWER);
    await composer.getByRole('textbox', { name: '요청 내용' }).fill(BODY);
    await expect(composer.locator('.thumb img')).toBeVisible({ timeout: 30_000 });
    await composer.getByRole('button', { name: '남기기', exact: true }).click();
    await expect(composer).toBeHidden();
    const marker = target.locator('.marker', { hasText: /^1$/ });
    await marker.click();
    const thread = target.locator('.tpop');
    await expect(thread).toContainText(BODY);
    await thread.getByRole('textbox', { name: '댓글', exact: true }).fill(COMMENT);
    await thread.getByRole('button', { name: '보내기', exact: true }).click();
    await expect(thread).toContainText(COMMENT);

    const requests = await manager.newPage();
    await requests.goto(`${APP}/sites/${site.id}`);
    const row = requests.locator('table.tbl tbody tr').filter({ hasText: BODY });
    await expect(row).toHaveCount(1);
    await row.locator('.body-cell').click();
    const detail = requests.getByRole('dialog', { name: '요청 상세' });
    await expect(detail).toContainText(REVIEWER);
    await expect(detail).toContainText(COMMENT);
    const capture = detail.locator('img.shot').first();
    await expect.poll(() => capture.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const storedCapture = await requests.request.get(new URL((await capture.getAttribute('src'))!, APP).href);
    expect(storedCapture.ok()).toBe(true);
    const pixel = await sharp(await storedCapture.body()).extract({ left: Math.round(mask.x + 20), top: Math.round(mask.y + 20), width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    for (const [index, expected] of [154, 160, 166].entries()) expect(Math.abs(pixel[index]! - expected)).toBeLessThan(12);

    const advanced = settings.locator('summary', { hasText: '고급 설정' });
    await advanced.click();
    const links = settings.locator('details').filter({ has: advanced });
    await links.getByRole('button', { name: '폐기', exact: true }).click();
    await expect(links.getByText('폐기됨', { exact: true })).toBeVisible();
    await target.bringToFront();
    await expect(target.getByRole('heading', { name: '검수가 마무리되었거나 링크가 닫혔어요' })).toBeVisible();
    await invitePage.reload();
    await expect(invitePage.getByRole('heading', { name: '이 링크는 닫혔어요' })).toBeVisible();
    await target.reload();
    const rejected = target.waitForResponse(r => r.url() === BOOKMARK_SESSION && r.request().method() === 'POST');
    if (bookmarkBar) await bookmarkBar.run(target);
    else await runBookmark(target, href!);
    const denied = await rejected;
    expect(denied.status()).toBe(404);
    expect((await denied.json()).error.code).toBe('link_invalid');
    await expect(target.locator('gp-widget')).toHaveCount(0);
    await expect(target.getByRole('heading', { name: '내 주문' })).toBeVisible();
  } finally {
    await Promise.allSettled([manager.close(), guest.close()]);
    try { await t.close(); }
    finally { await new Promise<void>(resolve => staging.close(() => resolve())); }
  }
});
