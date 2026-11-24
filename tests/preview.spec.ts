import { expect, firefox, test, type FrameLocator, type Page, type Request } from '@playwright/test';
import sharp from 'sharp';
import { startDemo } from '../demo/serve.mjs';
import { newTestContext } from './browser.ts';
import { createSite, installManager, startTestApp } from './helpers.ts';
import { buildApp } from '../server/app.ts';
import { openReviewPreview } from './review-browser.ts';

const APP = 'http://127.0.0.1:8290';
const STAGING = 'http://localhost:8292';
const STAGE_URL = `${STAGING}/preview.html`;
const EVENTS = `${APP}/api/w/events`;
const SESSION = `${APP}/api/w/session`;
const PIN_UNCONFIRMED = '핀 연결을 확인하지 못했어요';
const PIN_CONNECTED = '핀 연결됨';
const frame = (page: Page) => page.frameLocator('iframe[title="검수 사이트 미리보기"]');

const liveResponse = (page: Page) => page.waitForResponse(r => r.url() === EVENTS && r.ok(), { timeout: 15_000 });

async function measure(label: string, send: () => Promise<void>, received: (timeout: number) => Promise<unknown>) {
  const start = performance.now();
  await send();
  await received(1500);
  const ms = Math.round(performance.now() - start);
  console.log(`[실시간] ${label} ${ms}ms`);
  expect(ms).toBeLessThan(1500);
}

async function startPin(page: Page, selector: string) {
  const review = frame(page);
  await review.locator('.bar button.primary').click();
  await expect(review.locator('.shield')).toBeVisible();
  const box = (await review.locator(selector).boundingBox())!;
  await page.mouse.click(box.x + Math.min(box.width / 2, 100), box.y + box.height / 2);
  await expect(review.getByRole('dialog', { name: '요청 남기기' })).toBeVisible();
}

async function seeComparison(review: FrameLocator | Page) {
  await review.locator('.marker').filter({ hasText: /^2$/ }).click();
  const pair = review.locator('.shot-pair');
  await expect(pair.getByText('현재 화면')).toBeVisible();
  await expect(pair.getByText('제안 화면')).toBeVisible();
  await expect(pair.getByRole('img')).toHaveCount(2);
  for (const image of await pair.getByRole('img').all()) {
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  return pair;
}

async function rgb(data: Buffer, x: number, y: number) {
  return [...await sharp(data).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
}

test('주소만 등록한 미리보기를 유지하고 늦게 도착한 핀 연결을 복구한다', async ({ browser }) => {
  const t = await startTestApp({ PUBLIC_URL: APP, ALLOWED_HOSTS: '127.0.0.1:8290,localhost:80' });
  const previousCsp = process.env.DEMO_CSP;
  delete process.env.DEMO_CSP;
  let demo: ReturnType<typeof startDemo> | undefined;
  try {
    const owner = await installManager(t);
    const { site } = await createSite(t, owner.headers, '주소만 등록한 사이트', STAGE_URL);
    await t.app.listen({ host: '127.0.0.1', port: 8290 });
    demo = startDemo({ sitePort: 8292, cdnPort: 8293, log: false });
    const context = await newTestContext(browser);
    const page = await context.newPage();
    const review = frame(page);
    const sessionRequests: number[] = [];
    page.on('request', req => { if (req.url() === SESSION) sessionRequests.push(Date.now()); });
    const stageResponse = page.waitForResponse(r => r.url() === STAGE_URL);
    await page.goto(site.links[0].shareUrl);
    await openReviewPreview(page);
    expect((await stageResponse).status()).toBe(200);
    await expect(review.getByRole('heading', { level: 1 })).toBeVisible();
    await review.locator('body').evaluate(body => { body.dataset.viewed = 'yes'; });
    await expect(page.getByRole('status').filter({ hasText: PIN_UNCONFIRMED })).toBeVisible({ timeout: 18_000 });
    await expect(review.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(review.locator('body')).toHaveAttribute('data-viewed', 'yes');
    const title = (await review.getByRole('heading', { level: 1 }).boundingBox())!;
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x + 1, y + 1)?.tagName, title)).toBe('IFRAME');
    await expect(review.locator('script[data-gp-preview]')).toHaveCount(0);
    await expect(review.locator('gp-widget')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '사이트 새 탭에서 열기' })).toHaveAttribute('href', STAGE_URL);
    expect(sessionRequests).toHaveLength(0);

    await page.route(SESSION, route => route.abort('failed'), { times: 1 });
    const connected = page.waitForResponse(r => r.url() === SESSION && r.ok(), { timeout: 15_000 });
    await review.locator('head').evaluate((head, { base, id }) => {
      const script = document.createElement('script');
      script.src = `${base}/w.js`;
      script.dataset.gpPreview = id;
      head.append(script);
    }, { base: APP, id: site.preview.id });
    const { session } = await (await connected).json();
    await expect(page.getByRole('status').filter({ hasText: PIN_CONNECTED })).toBeVisible();
    await expect(review.locator('.bar button.primary')).toBeVisible();
    await expect(review.locator('body')).toHaveAttribute('data-viewed', 'yes');
    expect(sessionRequests).toHaveLength(2);
    expect(sessionRequests[1]! - sessionRequests[0]!).toBeGreaterThanOrEqual(2_900);

    const expired = await t.app.inject({
      method: 'PATCH', url: `/api/sites/${site.id}/links/${site.links[0].id}`, headers: owner.headers,
      payload: { expiresAt: new Date(Date.now() - 1_000).toISOString() },
    });
    expect(expired.statusCode).toBe(200);
    await expect(page.getByRole('heading', { name: '이 링크는 기간이 지났어요' })).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    const request = await t.app.inject({
      url: '/api/w/requests', headers: { host: '127.0.0.1:8290', origin: STAGING, 'x-gp-key': site.widgetKey, authorization: `Bearer ${session}` },
    });
    expect(request.statusCode).toBe(401);
    await context.close();
  } finally {
    if (previousCsp !== undefined) process.env.DEMO_CSP = previousCsp;
    demo?.close();
    await t.close();
  }
});

test('주소만 등록한 초대도 주소 변경과 폐기를 반영하고 초대별 화면을 분리한다', async ({ browser }) => {
  const t = await startTestApp({ PUBLIC_URL: APP, ALLOWED_HOSTS: '127.0.0.1:8290,localhost:80' });
  let demo: ReturnType<typeof startDemo> | undefined;
  const previousCsp = process.env.DEMO_CSP;
  delete process.env.DEMO_CSP;
  try {
    const owner = await installManager(t);
    const { site, token } = await createSite(t, owner.headers, '첫 미리보기', STAGE_URL);
    const other = await createSite(t, owner.headers, '다른 초대', STAGE_URL);
    const invite = site.links[0].shareUrl as string;
    const stage = `${STAGING}/about.html`;
    await t.app.listen({ host: '127.0.0.1', port: 8290 });
    demo = startDemo({ sitePort: 8292, cdnPort: 8293, log: false });
    const context = await newTestContext(browser);
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(invite);
    await openReviewPreview(page);
    await expect(frame(page).getByRole('heading', { level: 1 })).toBeVisible();
    const initialCheck = page.waitForResponse(r => r.url() === `${APP}/api/share/${token}` && r.ok());
    await page.clock.fastForward(13_000);
    await initialCheck;
    await expect(page.getByRole('status').filter({ hasText: PIN_UNCONFIRMED })).toBeVisible();

    expect((await t.app.inject({
      method: 'PATCH', url: `/api/sites/${site.id}`, headers: owner.headers, payload: { previewUrl: stage },
    })).statusCode).toBe(200);
    await page.clock.fastForward(11_000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(frame(page).getByRole('heading', { name: '회사소개' })).toBeVisible();
    await expect(frame(page).locator('gp-widget')).toHaveCount(0);

    const differentOrigin = 'http://127.0.0.1:8292/about.html';
    expect((await t.app.inject({
      method: 'PATCH', url: `/api/sites/${site.id}`, headers: owner.headers, payload: { previewUrl: differentOrigin },
    })).statusCode).toBe(200);
    await page.clock.fastForward(11_000);
    const reloaded = page.waitForEvent('domcontentloaded');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await reloaded;
    await openReviewPreview(page);
    await expect(page.locator('iframe')).toHaveAttribute('src', differentOrigin);
    await expect(frame(page).getByRole('heading', { name: '회사소개' })).toBeVisible();

    let failOther!: () => void;
    const hold = new Promise<void>(resolve => { failOther = resolve; });
    const otherShare = `${APP}/api/share/${other.token}`;
    await page.route(otherShare, async route => { await hold; await route.abort('failed'); });
    const requested = page.waitForRequest(otherShare);
    try {
      await page.evaluate(path => {
        history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, new URL(other.site.links[0].shareUrl).pathname);
      await requested;
      await expect(page.getByRole('heading', { name: '첫 미리보기' })).toHaveCount(0);
      await expect(page.locator('iframe')).toHaveCount(0);
    } finally { failOther(); }
    await expect(page.getByRole('heading', { name: '초대를 불러오지 못했어요' })).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);

    await page.goto(invite);
    await openReviewPreview(page);
    await expect(frame(page).getByRole('heading', { name: '회사소개' })).toBeVisible();
    const changedCheck = page.waitForResponse(r => r.url() === `${APP}/api/share/${token}` && r.ok());
    await page.clock.fastForward(13_000);
    await changedCheck;
    expect((await t.app.inject({
      method: 'PATCH', url: `/api/sites/${site.id}/links/${site.links[0].id}`, headers: owner.headers, payload: { revoked: true },
    })).statusCode).toBe(200);
    await page.clock.fastForward(60_000);
    await expect(page.getByRole('heading', { name: '이 링크는 닫혔어요' })).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    await context.close();
  } finally {
    if (previousCsp !== undefined) process.env.DEMO_CSP = previousCsp;
    demo?.close();
    await t.close();
  }
});

test('다른 출처 미리보기에서 두 브라우저가 핀과 저장된 위치 변경 전후를 본다', async ({ browser }) => {
  const t = await startTestApp({ PUBLIC_URL: APP, ALLOWED_HOSTS: '127.0.0.1:8290,localhost:80' });
  let other: Awaited<ReturnType<typeof firefox.launch>> | undefined;
  let demo: ReturnType<typeof startDemo> | undefined;
  let restarted: Awaited<ReturnType<typeof buildApp>> | undefined;
  const previousCsp = process.env.DEMO_CSP;
  delete process.env.DEMO_CSP;
  try {
    const owner = await installManager(t);
    expect(owner.res.statusCode).toBe(200);
    const create = await t.app.inject({
      method: 'POST', url: '/api/sites', headers: owner.headers, payload: { name: '미리보기 검수' },
    });
    expect(create.statusCode).toBe(200);
    const { site } = create.json();
    const invite = site.links[0].shareUrl as string;
    const token = invite.split('/').at(-1)!;
    for (const previewUrl of [APP, 'http://staging;test/']) {
      const response = await t.app.inject({ method: 'PATCH', url: `/api/sites/${site.id}`, headers: owner.headers, payload: { previewUrl } });
      expect(response.statusCode).toBe(400);
    }
    await t.app.listen({ host: '127.0.0.1', port: 8290 });
    const guestA = await newTestContext(browser, { viewport: { width: 1100, height: 820 } });
    const a = await guestA.newPage();
    const primaryBrowser = browser.version().includes('Edg') || (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '').includes('msedge') ? 'Edge' : 'Chromium';
    await test.step('미연결이면 관리자에게 연결을 요청한다', async () => {
      await a.goto(invite);
      await expect(a.getByRole('heading', { name: '스테이징 미리보기 연결이 필요해요' })).toBeVisible();
      await expect(a.locator('iframe')).toHaveCount(0);
    });

    let previewId = '';
    let sharedInvite = '';
    await test.step('운영자가 주소를 연결하고 스테이징에 프로젝트용 스크립트를 설치한다', async () => {
      const ownerContext = await newTestContext(browser);
      await ownerContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
      const split = owner.cookie.indexOf('=');
      await ownerContext.addCookies([{ url: APP, name: owner.cookie.slice(0, split), value: owner.cookie.slice(split + 1) }]);
      const settings = await ownerContext.newPage();
      await settings.goto(`${APP}/sites/${site.id}/settings`);
      const section = settings.getByRole('region', { name: '미리보기 연결' });
      await section.getByRole('textbox', { name: '미리보기 주소' }).fill(STAGE_URL);
      await section.getByRole('button', { name: '저장' }).click();
      await section.locator('summary').filter({ hasText: '내장 미리보기 스크립트' }).click();
      const script = section.getByRole('textbox', { name: '미리보기 연결 스크립트' });
      await expect(script).toBeVisible();
      previewId = /data-gp-preview="([^"]+)"/.exec(await script.inputValue())![1]!;
      demo = startDemo({ sitePort: 8292, cdnPort: 8293, log: false, preview: { appOrigin: APP, id: previewId } });

      const card = settings.getByRole('region', { name: '초대 링크' }).filter({ has: settings.getByRole('heading', { name: '참여자 초대하기' }) });
      await expect(section.getByRole('heading', { name: '검수할 사이트' })).toBeVisible();
      await expect(section.getByRole('heading', { name: '핀 사용 설정' })).toBeVisible();
      await expect(card).toContainText('북마크를 설치할 수 있어요');
      await expect(card.getByRole('link', { name: /preview\.html/ })).toHaveAttribute('href', STAGE_URL);
      await card.getByRole('button', { name: /안내 문구.*복사/ }).click();
      const message = await settings.evaluate(() => navigator.clipboard.readText());
      expect(message).toContain(`검수할 사이트: ${STAGE_URL}`);
      expect(message).toContain('초대 링크에서 북마크를 저장한 뒤');
      sharedInvite = message.trim().split('\n').at(-1)!;
      expect(sharedInvite).toBe(invite);
    });

    other = await firefox.launch({ executablePath: firefox.executablePath() });
    const guestB = await newTestContext(other, { viewport: { width: 1100, height: 820 } });
    const b = await guestB.newPage();
    await test.step('두 브라우저에서 초대 링크로 입장하고 세션의 출처를 검증한다', async () => {
      const sessionResponse = a.waitForResponse(r => r.url() === `${APP}/api/w/session` && r.request().method() === 'POST', { timeout: 15_000 });
      const stagingRequest = a.waitForRequest(r => r.url() === STAGE_URL, { timeout: 15_000 });
      const ready = Promise.all([liveResponse(a), liveResponse(b)]);
      await Promise.all([a.reload(), b.goto(sharedInvite)]);
      await Promise.all([openReviewPreview(a), openReviewPreview(b)]);
      await ready;
      const scoped = await (await sessionResponse).json();
      expect(scoped.share).toBeUndefined();
      expect((await (await stagingRequest).allHeaders()).referer).toBeUndefined();
      for (const page of [a, b]) {
        await expect(frame(page).locator('.bar button.primary')).toBeVisible();
        await expect(page.getByRole('status').filter({ hasText: PIN_CONNECTED })).toBeVisible();
        const bootHasInvite = await frame(page).locator('body').evaluate((_el, secret) => JSON.stringify(window.__gpBoot).includes(secret), token);
        expect(bootHasInvite).toBe(false);
      }
      const bearer = { host: '127.0.0.1:8290', 'x-gp-key': site.widgetKey, authorization: `Bearer ${scoped.session}` };
      expect((await t.app.inject({ url: '/api/w/requests', headers: { ...bearer, origin: STAGING } })).statusCode).toBe(200);
      expect((await t.app.inject({ url: '/api/w/requests', headers: { ...bearer, origin: 'http://localhost:8294' } })).statusCode).toBe(401);
      expect((await t.app.inject({
        method: 'POST', url: '/api/w/session', headers: { ...bearer, origin: STAGING }, payload: { token, previewId },
      })).statusCode).toBe(403);
    });

    await test.step('일반 핀을 저장하고 버튼 이동 제안은 복제 화면에만 적용한다', async () => {
      const review = frame(a);
      await startPin(a, 'h1');
      await review.getByRole('textbox', { name: '내 별명' }).fill('크로미움 검수자');
      await review.getByRole('textbox', { name: '요청 내용' }).fill('워크숍 제목 확인');
      await expect(review.locator('.pop .thumb img')).toBeVisible();
      await measure(`핀 ${primaryBrowser} → Firefox`,
        () => review.getByRole('button', { name: '남기기', exact: true }).click(),
        timeout => expect(frame(b).locator('.marker').filter({ hasText: /^1$/ })).toBeVisible({ timeout }));
      await expect(review.locator('.marker').filter({ hasText: /^1$/ })).toBeVisible();
      await startPin(a, '#reserve');
      await review.getByRole('button', { name: '위치 변경 제안' }).click();
      await expect(review.getByRole('combobox', { name: '제안할 위치' })).toBeVisible();
      await expect(review.locator('.pop .thumb img')).toBeVisible();
      await review.getByRole('button', { name: '화면에서 끌기' }).click();
      const source = (await review.locator('#reserve').boundingBox())!;
      const destination = (await review.locator('#details').boundingBox())!;
      await a.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await a.mouse.down();
      await a.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 12 });
      await expect(review.locator('.move-ghost')).toBeVisible();
      await expect(review.locator('.move-banner')).toContainText('2번째 · 일정 보기 뒤로');
      await a.mouse.up();
      await expect(review.getByRole('img', { name: '제안 화면 미리보기' })).toBeVisible({ timeout: 25_000 });
      await expect(review.locator('.choices > button')).toHaveText(['예약하기', '일정 보기', '문의하기']);
      await measure(`위치 제안 ${primaryBrowser} → Firefox`,
        () => review.getByRole('button', { name: '남기기', exact: true }).click(),
        timeout => expect(frame(b).locator('.marker').filter({ hasText: /^2$/ })).toBeVisible({ timeout }));
      await expect(review.locator('.marker').filter({ hasText: /^2$/ })).toBeVisible({ timeout: 15_000 });
    });

    await test.step('열린 대화의 댓글과 상태를 전송하고 상대방의 초안을 보존한다', async () => {
      const reviewA = frame(a);
      const reviewB = frame(b);
      await Promise.all([seeComparison(reviewA), seeComparison(reviewB)]);
      await reviewB.getByRole('textbox', { name: '댓글' }).fill('저장 전 초안');
      await reviewA.getByRole('textbox', { name: '댓글' }).fill('제안 위치 확인했어요');
      await measure(`댓글 ${primaryBrowser} → Firefox`,
        () => reviewA.getByRole('button', { name: '보내기' }).click(),
        timeout => expect(reviewB.getByText('제안 위치 확인했어요', { exact: true })).toBeVisible({ timeout }));
      await expect(reviewB.getByRole('textbox', { name: '댓글' })).toHaveValue('저장 전 초안');
      await reviewB.getByRole('button', { name: '보내기' }).click();
      await reviewB.getByRole('textbox', { name: '내 별명' }).fill('파이어폭스 검수자');
      await measure(`댓글 Firefox → ${primaryBrowser}`,
        () => reviewB.getByRole('button', { name: '확인', exact: true }).click(),
        timeout => expect(reviewA.getByText('저장 전 초안', { exact: true })).toBeVisible({ timeout }));
      await measure(`완료 Firefox → ${primaryBrowser}`,
        () => reviewB.getByRole('button', { name: /해결/ }).click(),
        timeout => expect(reviewA.getByRole('button', { name: /다시 열기/ })).toBeVisible({ timeout }));
      await Promise.all([reviewA, reviewB].map(review => review.locator('.tpop').getByRole('button', { name: '닫기' }).click()));
    });

    await test.step('Firefox에서 전후 이미지가 실제로 바뀌었고 새로고침 후에도 유지되는지 확인한다', async () => {
      const review = frame(b);
      await expect(review.locator('.marker').filter({ hasText: /^2$/ })).toBeVisible({ timeout: 15_000 });
      const pair = await seeComparison(review);
      await expect(review.locator('.tpop')).toContainText('크로미움 검수자');
      const source = async (name: string) => {
        const src = await pair.getByRole('img', { name }).getAttribute('src');
        const file = await fetch(src!);
        expect(file.ok).toBe(true);
        return Buffer.from(await file.arrayBuffer());
      };
      const [before, after] = await Promise.all([source('요청 당시 화면'), source('제안된 위치의 화면')]);
      const [x, y] = await review.locator('#reserve').evaluate(el => {
        const rect = el.getBoundingClientRect();
        return [Math.round(rect.left + 14), Math.round(rect.top + 14)] as const;
      });
      const [beforeRed, , beforeBlue] = await rgb(before, x, y);
      const [afterRed, , afterBlue] = await rgb(after, x, y);
      expect(beforeRed! - beforeBlue!).toBeGreaterThan(80);
      expect(afterBlue! - afterRed!).toBeGreaterThan(80);
      await expect(review.locator('.choices > button')).toHaveText(['예약하기', '일정 보기', '문의하기']);

      await review.locator('.tpop').getByRole('button', { name: '닫기' }).click();
      const liveB = liveResponse(b);
      await b.reload();
      await openReviewPreview(b);
      await liveB;
      await seeComparison(review);
      const liveA = liveResponse(a);
      await a.reload();
      await openReviewPreview(a);
      await liveA;
      await seeComparison(frame(a));
      await expect(frame(a).locator('.tpop')).toContainText('크로미움 검수자 (나)');
    });

    await test.step('서버가 재시작되고 스트림이 차단돼도 조회하고, 다시 연결되면 실시간으로 반영한다', async () => {
      await frame(b).locator('.tpop').getByRole('button', { name: '닫기' }).click();
      const blocked = b.waitForEvent('requestfailed', { predicate: request => request.url() === EVENTS, timeout: 15_000 });
      await b.route(EVENTS, route => route.abort());
      const rejoinedA = liveResponse(a);
      await t.app.close();
      restarted = await buildApp(t.ctx, { logger: false });
      await restarted.listen({ host: '127.0.0.1', port: 8290 });
      await Promise.all([blocked, rejoinedA]);

      const reviewA = frame(a);
      const reviewB = frame(b);
      await startPin(a, '#contact');
      await reviewA.getByRole('textbox', { name: '요청 내용' }).fill('조회로 복구된 핀');
      await reviewA.getByRole('button', { name: '남기기', exact: true }).click();
      const afterRestart = reviewB.locator('.marker').filter({ hasText: /^3$/ });
      await expect(afterRestart).toBeVisible({ timeout: 9000 });
      await afterRestart.click();
      await expect(reviewB.getByText('조회로 복구된 핀', { exact: true })).toBeVisible();

      const rejoinedB = liveResponse(b);
      await b.unroute(EVENTS);
      await rejoinedB;
      await reviewA.locator('.marker').filter({ hasText: /^3$/ }).click();
      await reviewA.getByRole('textbox', { name: '댓글' }).fill('재연결 이후 실시간 댓글');
      await measure(`재연결 이후 댓글 ${primaryBrowser} → Firefox`,
        () => reviewA.getByRole('button', { name: '보내기' }).click(),
        timeout => expect(reviewB.getByText('재연결 이후 실시간 댓글', { exact: true })).toBeVisible({ timeout }));
    });

    await test.step('미리보기 안에서 표시 이름을 바꾸고 새로고침 후에도 유지한다', async () => {
      const review = frame(a);
      await review.getByRole('button', { name: /모두의 요청/ }).click();
      await review.getByRole('button', { name: '별명 바꾸기' }).click();
      await review.getByRole('textbox', { name: '내 별명' }).fill('이름을 바꾼 검수자');
      await review.getByRole('button', { name: '저장', exact: true }).click();
      await expect(review.locator('.panel .me')).toContainText('이름을 바꾼 검수자');
      await a.reload();
      await openReviewPreview(a);
      await seeComparison(review);
      await expect(review.locator('.tpop')).toContainText('이름을 바꾼 검수자 (나)');
    });

    await test.step('iframe 거부를 존중하고 새 탭 열기와 다시 연결을 제공한다', async () => {
      process.env.DEMO_CSP = "frame-ancestors 'none'";
      let sessionsWhileBlocked = 0;
      const countSession = (req: Request) => { if (req.url() === SESSION) sessionsWhileBlocked++; };
      b.on('request', countSession);
      await b.reload();
      await openReviewPreview(b);
      await expect(b.getByRole('status').filter({ hasText: PIN_UNCONFIRMED })).toBeVisible({ timeout: 20_000 });
      await expect(b.getByText(/사이트가 삽입을 차단하면 미리보기가 비어 있을 수 있어요.*원본을 새 탭에서 열고.*스크립트와 API 연결을 허용하면 북마크를 사용하세요/)).toBeVisible();
      await expect(b.locator('iframe')).toHaveCount(1);
      expect(sessionsWhileBlocked).toBe(0);
      b.off('request', countSession);
      const popup = guestB.waitForEvent('page', { timeout: 10_000 });
      await b.getByRole('link', { name: '사이트 새 탭에서 열기' }).click();
      const original = await popup;
      await expect(original).toHaveURL(STAGE_URL);
      await expect(original.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(original.locator('gp-widget')).toHaveCount(0);
      await original.close();
      delete process.env.DEMO_CSP;
      await b.getByRole('button', { name: '미리보기 다시 연결' }).click();
      await expect(frame(b).locator('.bar button.primary')).toBeVisible();
      await expect(b.getByRole('status').filter({ hasText: PIN_CONNECTED })).toBeVisible();
      await expect(frame(b).getByRole('heading', { level: 1 })).toBeVisible();
    });

    await test.step('열린 초대를 폐기하면 기존 핀 세션과 미리보기가 닫힌다', async () => {
      const session = await frame(b).locator('body').evaluate(() => window.__gpBoot?.session);
      expect(session).toBeTruthy();
      const revoked = await restarted!.inject({
        method: 'PATCH', url: `/api/sites/${site.id}/links/${site.links[0].id}`, headers: owner.headers, payload: { revoked: true },
      });
      expect(revoked.statusCode).toBe(200);
      await expect(b.getByRole('heading', { name: '이 링크는 닫혔어요' })).toBeVisible();
      await expect(b.locator('iframe')).toHaveCount(0);
      expect((await restarted!.inject({
        url: '/api/w/requests', headers: { host: '127.0.0.1:8290', origin: STAGING, 'x-gp-key': site.widgetKey, authorization: `Bearer ${session}` },
      })).statusCode).toBe(401);
    });
  } finally {
    if (previousCsp === undefined) delete process.env.DEMO_CSP;
    else process.env.DEMO_CSP = previousCsp;
    await other?.close();
    await Promise.all(browser.contexts().map(context => context.close()));
    demo?.close();
    await restarted?.close();
    await t.close();
  }
});
