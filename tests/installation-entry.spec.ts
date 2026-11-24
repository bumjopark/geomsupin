import { expect, test } from '@playwright/test';
import { createSite, installManager, startTestApp } from './helpers.ts';

test('HTTP entry appears on the landing page, invitation, and settings without forwarding invitation details', async ({ page, context }) => {
  const peerOrigin = 'https://review.example.test:3443';
  const t = await startTestApp({ PEER_REVIEW_URL: peerOrigin });
  try {
    const owner = await installManager(t);
    const { site, token } = await createSite(t, owner.headers, 'Protocol check', 'http://staging.example.test/');
    const origin = await t.app.listen({ host: '127.0.0.1', port: 0 });
    t.ctx.config.allowedHosts.add(new URL(origin).host);

    let configurationRequests = 0;
    page.on('request', request => {
      if (request.url() === origin + '/api/installation') configurationRequests++;
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (value: string) => { sessionStorage.setItem('testClipboard', value); } },
      });
    });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(origin);
    const notice = page.getByRole('complementary', { name: '검수핀 접속 방식' });
    await expect(notice.getByText('HTTP 사이트용 검수핀', { exact: true })).toBeVisible();
    await expect(notice.getByText('HTTP에서는 초대 링크·댓글·캡처가 암호화 없이 전송됩니다.')).toBeVisible();
    await expect(notice.getByText('두 입구의 프로젝트와 초대 링크는 별도로 관리됩니다.')).toBeVisible();
    await expect(notice.getByRole('link')).toHaveAttribute('href', peerOrigin + '/');
    expect(await notice.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(320);
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(notice).toHaveCount(0);
    const englishNotice = page.getByRole('complementary', { name: 'Geomsupin connection' });

    await page.goto(origin + '/r/' + token + '?private=1#fragment');
    await expect(page.getByRole('heading', { name: 'Protocol check' })).toBeVisible();
    await page.getByRole('button', { name: 'Copy invitation link', exact: true }).filter({ visible: true }).click();
    expect(await page.evaluate(() => sessionStorage.getItem('testClipboard'))).toBe(origin + '/r/' + token);
    const invitationPeer = englishNotice.getByRole('link', { name: 'Open Geomsupin for HTTPS sites' });
    await expect(invitationPeer).toHaveAttribute('referrerpolicy', 'no-referrer');
    await page.route(peerOrigin + '/**', async route => {
      expect(route.request().url()).toBe(peerOrigin + '/');
      expect(route.request().headers()['referer']).toBeUndefined();
      await route.fulfill({ contentType: 'text/plain', body: 'Peer entry' });
    });
    await invitationPeer.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(peerOrigin + '/');

    const separator = owner.cookie.indexOf('=');
    await context.addCookies([{ url: origin, name: owner.cookie.slice(0, separator), value: owner.cookie.slice(separator + 1) }]);
    await page.setViewportSize({ width: 950, height: 760 });
    await page.goto(origin + '/sites/' + site.id);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(englishNotice).toBeVisible();
    const target = page.getByRole('textbox', { name: 'Site address' });
    await target.fill('https://staging.example.test/');
    await expect(target).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').getByRole('link')).toHaveAttribute('href', peerOrigin + '/');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(configurationRequests).toBe(3);
  } finally {
    await t.close();
  }
});

test('HTTPS entry only offers a configured HTTP peer', async ({ page }) => {
  const t = await startTestApp();
  try {
    const origin = await t.app.listen({ host: '127.0.0.1', port: 0 });
    t.ctx.config.allowedHosts.add(new URL(origin).host);
    let peerReviewUrl: string | null = 'http://review.example.test:3080/';
    const publicOrigin = 'https://review.example.test:3443';
    await page.route(publicOrigin + '/**', async route => {
      const { pathname, search } = new URL(route.request().url());
      if (pathname === '/api/installation') return route.fulfill({ json: { peerReviewUrl } });
      return route.fulfill({ response: await route.fetch({ url: origin + pathname + search }) });
    });
    await page.goto(publicOrigin);
    const notice = page.getByRole('complementary', { name: '검수핀 접속 방식' });
    await expect(notice.getByText('HTTPS 사이트용 검수핀', { exact: true })).toBeVisible();
    await expect(notice.getByRole('link', { name: 'HTTP 사이트용 검수핀 열기' })).toHaveAttribute('href', peerReviewUrl);
    await expect(notice.getByText('HTTP에서는 초대 링크·댓글·캡처가 암호화 없이 전송됩니다.')).toHaveCount(0);

    peerReviewUrl = null;
    await Promise.all([page.waitForResponse(publicOrigin + '/api/installation'), page.reload()]);
    await expect(notice.getByRole('link')).toHaveCount(0);
    await expect(notice.getByText('두 입구의 프로젝트와 초대 링크는 별도로 관리됩니다.')).toHaveCount(0);
  } finally {
    await t.close();
  }
});
