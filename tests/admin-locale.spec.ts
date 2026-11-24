import { expect, test } from '@playwright/test';
import { newTestContext } from './browser.ts';
import { createSite, HOST, installManager, openReviewer, startTestApp } from './helpers.ts';
import { managerCookie } from './review-browser.ts';

test('관리 화면 언어를 바꿔도 입력·사용자 원문·저장 상태가 보존된다', async ({ browser }) => {
  const origin = 'http://127.0.0.1:8294';
  const app = await startTestApp({ PUBLIC_URL: origin, ALLOWED_HOSTS: '127.0.0.1:8294,localhost:80' });
  const context = await newTestContext(browser);
  try {
    await app.app.listen({ host: '127.0.0.1', port: 8294 });
    const owner = await installManager(app);
    const stage = 'http://studio.example.com';
    const { site, token } = await createSite(app, owner.headers, '프로젝트', stage);
    const headers = { ...HOST, 'x-gp-key': site.widgetKey, origin: stage };
    const reviewer = await openReviewer(app, headers, token, { name: '보통' });
    const result = await app.app.inject({
      method: 'POST', url: '/api/w/requests', headers: { ...headers, authorization: `Bearer ${reviewer.json().session}` },
      payload: { pageUrl: stage + '/', body: '수정', selector: 'h1', viewportW: 1024, viewportH: 768 },
    });
    expect(result.statusCode).toBe(200);

    await managerCookie(context, origin, owner.cookie);
    const page = await context.newPage();
    await page.goto(origin + '/sites');
    await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
    await page.getByLabel('프로젝트 이름').fill('새 초안');
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(page.getByLabel('Project name')).toHaveValue('새 초안');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('link', { name: /프로젝트/ }).click();
    const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: '수정', exact: true }) });
    await expect(row).toContainText('보통');
    await expect(row).toContainText('Change');
    await row.getByLabel('Status').selectOption({ label: 'Resolved' });
    await expect.poll(async () => (await app.sql`select status from requests where site_id=${site.id}`)[0]?.status).toBe('완료');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(row.getByLabel('Status')).toHaveValue('완료');
    await row.getByRole('button', { name: '수정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Request details' });
    await expect(dialog.getByRole('heading', { name: 'Discussion' })).toBeVisible();
    await expect(dialog).toContainText('marked this Resolved');
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Site address')).toHaveValue(stage + '/');
    const address = page.getByLabel('Site address');
    await address.fill('bad address');
    await expect(page.getByRole('alert')).toContainText('Enter a full URL');
    await page.getByRole('button', { name: '한국어', exact: true }).click();
    await expect(page.getByLabel('미리보기 주소')).toHaveValue('bad address');
    await expect(page.getByRole('alert')).toContainText('주소를 입력');
  } finally {
    await context.close();
    await app.close();
  }
});
