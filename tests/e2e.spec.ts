import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';
import { startDemo } from '../demo/serve.mjs';
import { recordScheduledBackup } from '../server/backup-status.ts';
import { issueAdminLink } from '../server/installation-admin.ts';
import { newTestContext } from './browser.ts';
import { startTestApp } from './helpers.ts';
import { ReviewBrowser } from './review-browser.ts';

const APP = 'http://127.0.0.1:8210';
const STAGE = 'http://localhost:8212';
const MASK_SECRET = 'privacy-fixture-value';
const boot = () => startTestApp({ PUBLIC_URL: APP, ALLOWED_HOSTS: '127.0.0.1:8210' });
const managementUrl = (token: string) => APP + '/#manage=' + token;
const countExchanges = (page: Page) => {
  let count = 0;
  page.on('request', r => { if (r.url() === APP + '/api/manage/exchange' && r.method() === 'POST') count++; });
  return () => count;
};

test('새 탭과 이미 열린 루트에서 관리 링크를 한 번 교환하고 로그아웃과 회전을 적용한다', async ({ browser }) => {
  const t = await boot();
  try {
    await t.app.listen({ port: 8210, host: '127.0.0.1' });
    const installed = await issueAdminLink(t.sql, undefined, '설치자 작업공간');
    const first = await newTestContext(browser);
    const alreadyOpen = await newTestContext(browser);
    const a = await first.newPage();
    const b = await alreadyOpen.newPage();
    const spent = await first.newPage();
    const freshExchanges = countExchanges(a);
    const sameDocumentExchanges = countExchanges(b);

    await b.goto(APP + '/');
    await expect(b.getByRole('heading', { name: '검수핀 관리' })).toBeVisible();
    expect((await b.request.get(APP + '/api/sites')).status()).toBe(401);
    expect((await t.sql`select count(*)::int as n from workspaces`)[0]!.n).toBe(1);

    await a.goto(managementUrl(installed.token));
    await expect(a.getByRole('button', { name: '로그아웃' })).toBeVisible();
    await expect(a).toHaveURL(APP + '/sites');
    expect(freshExchanges()).toBe(1);
    expect((await first.cookies(APP)).find(c => c.name === 'gp_install_session')).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: false });
    expect(await a.evaluate(() => document.cookie)).not.toContain('gp_install_session');

    await spent.goto(managementUrl(installed.token));
    await expect(spent.getByRole('alert')).toContainText('이미 사용됐어요');
    await expect(spent).toHaveURL(APP + '/');

    const rotated = await issueAdminLink(t.sql, installed.workspace.id);
    expect((await a.request.get(APP + '/api/sites')).status()).toBe(401);
    await b.evaluate(() => { (window as Window & { sameDocument?: boolean }).sameDocument = true; });
    await b.evaluate(token => { location.hash = 'manage=' + token; }, rotated.token);
    await expect(b.getByRole('button', { name: '로그아웃' })).toBeVisible();
    await expect(b).toHaveURL(APP + '/sites');
    expect(await b.evaluate(() => (window as Window & { sameDocument?: boolean }).sameDocument)).toBe(true);
    expect(sameDocumentExchanges()).toBe(1);

    await b.reload();
    await expect(b.getByRole('button', { name: '로그아웃' })).toBeVisible();
    expect(sameDocumentExchanges()).toBe(1);
    await b.getByRole('button', { name: '로그아웃' }).click();
    await expect(b.getByRole('heading', { name: '검수핀 관리' })).toBeVisible();
    await expect(b).toHaveURL(APP + '/');
    expect((await b.request.get(APP + '/api/sites')).status()).toBe(401);
    expect((await alreadyOpen.cookies(APP)).some(c => c.name === 'gp_install_session')).toBe(false);
  } finally {
    await t.close();
  }
});

async function openPin(review: ReviewBrowser, selector: string, maskLabel = false) {
  await review.locator('.bar button.primary').click();
  await expect(review.locator('.shield')).toBeVisible();
  const box = (await review.locator(selector).boundingBox())!;
  const x = box.x + Math.min(box.width / 2, 100);
  const y = box.y + box.height / 2;
  if (maskLabel) {
    await review.mouse.move(x, y);
    await expect(review.locator('.hilite .tag')).toHaveText('가림 영역');
  }
  await review.mouse.click(x, y);
  return review.getByRole('dialog', { name: '요청 남기기' });
}

async function savePin(review: ReviewBrowser, selector: string, body: string, nickname?: string, maskLabel = false) {
  const form = await openPin(review, selector, maskLabel);
  if (nickname) await form.getByRole('textbox', { name: '내 별명' }).fill(nickname);
  const content = form.getByRole('textbox', { name: '요청 내용' });
  await content.fill(body);
  await expect(form.locator('.thumb img')).toBeVisible({ timeout: 30_000 });
  const submit = form.getByRole('button', { name: '남기기', exact: true });
  await content.evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true })));
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(form).toBeHidden();
}

async function showMaskedFixture(review: ReviewBrowser) {
  await review.evaluate(secret => {
    const fixture = document.createElement('div');
    fixture.style.cssText = 'display:flex;align-items:center;gap:16px;height:88px;margin-bottom:12px';
    fixture.innerHTML = `
      <button type="button" id="${secret}-parent" aria-label="${secret}" style="display:flex;align-items:center;justify-content:flex-end;width:190px;height:66px">
        <span data-review-mask style="display:flex;position:relative;align-items:center;justify-content:center;width:72px;height:48px;background:#f00">
          <span id="${secret}-child" class="${secret}" data-testid="${secret}" style="width:54px;height:34px;overflow:hidden">${secret}</span>
        </span>
      </button>
      <button type="button" style="width:110px;height:66px">배치 기준</button>
      <img data-review-mask alt="${secret}" width="64" height="48">
      <canvas data-review-mask width="64" height="48"></canvas>`;
    const canvas = fixture.querySelector('canvas')!;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f00';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    fixture.querySelector('img')!.src = canvas.toDataURL();
    const contact = document.getElementById('contact')!;
    contact.querySelector('h2')!.after(fixture);
    contact.scrollIntoView();
  }, MASK_SECRET);
  await expect.poll(() => review.locator('#contact img[data-review-mask]').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(64);
}

test('설치자가 연결한 사이트에서 별명으로 남긴 핀을 관리하고 가려진 캡처를 엑셀로 받는다', async ({ browser }) => {
  const t = await boot();
  let demo: ReturnType<typeof startDemo> | undefined;
  const previousCsp = process.env.DEMO_CSP;
  delete process.env.DEMO_CSP;
  try {
    await t.app.listen({ port: 8210, host: '127.0.0.1' });
    const installed = await issueAdminLink(t.sql, undefined, '설치 검증');
    const adminContext = await newTestContext(browser, { viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const admin = await adminContext.newPage();
    await admin.goto(managementUrl(installed.token));
    await admin.getByLabel('프로젝트 이름').fill('검수 시험');
    await admin.getByRole('button', { name: '만들기', exact: true }).click();
    const settings = admin.getByRole('region', { name: '미리보기 연결' });
    await settings.getByRole('textbox', { name: '미리보기 주소' }).fill(STAGE + '/');
    await settings.getByRole('button', { name: '저장' }).click();
    await settings.locator('summary').filter({ hasText: '내장 미리보기 스크립트' }).click();
    const script = settings.getByRole('textbox', { name: '미리보기 연결 스크립트' });
    await expect(script).toBeVisible();
    const id = /data-gp-preview="([^"]+)"/.exec(await script.inputValue())![1]!;
    demo = startDemo({ sitePort: 8212, cdnPort: 8213, preview: { appOrigin: APP, id }, log: false });
    const invite = await admin.getByRole('textbox', { name: '초대 링크', exact: true }).inputValue();
    const guest = await newTestContext(browser, { viewport: { width: 1200, height: 1000 } });
    const review = new ReviewBrowser(await guest.newPage(), invite);

    await test.step('실제 스테이징을 열어 민감 영역을 가린 핀을 저장한다', async () => {
      await review.goto();
      await showMaskedFixture(review);
      const masks = await review.locator('input[type=password], [data-review-mask]').evaluateAll(els => els.map(el => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { tag: el.tagName, x, y, width, height };
      }));
      expect(masks.map(mask => mask.tag)).toEqual(['SPAN', 'IMG', 'CANVAS', 'INPUT', 'P']);
      await savePin(review, 'input[name=name]', '문의 양식 배치 확인', '김검수');
      await review.goto(STAGE + '/about.html');
      await savePin(review, '#about-history', '연혁 문구 확인');

      await admin.locator('.subnav').getByRole('link', { name: /요청/ }).click();
      await expect(admin.locator('table.tbl tbody tr')).toHaveCount(2);
      const maskedRow = admin.locator('table.tbl tbody tr').filter({ hasText: '문의 양식 배치 확인' });
      await maskedRow.locator('.body-cell').click();
      const detail = admin.getByRole('dialog', { name: '요청 상세' });
      const capture = detail.locator('img.shot').first();
      await expect.poll(() => capture.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      const response = await admin.request.get(new URL((await capture.getAttribute('src'))!, APP).href);
      expect(response.ok()).toBe(true);
      const data = await response.body();
      for (const box of masks) {
        const { data: pixels, info } = await sharp(data).extract({
          left: Math.ceil(box.x + 8), top: Math.ceil(box.y + 8),
          width: Math.floor(box.width - 16), height: Math.floor(box.height - 16),
        }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let masked = 0;
        for (let i = 0; i < pixels.length; i += info.channels) {
          if (Math.abs(pixels[i]! - 154) <= 8 && Math.abs(pixels[i + 1]! - 160) <= 8 && Math.abs(pixels[i + 2]! - 166) <= 8) masked++;
        }
        expect(masked / (info.width * info.height), box.tag).toBeGreaterThan(0.98);
      }
      await expect(detail).toContainText('김검수');
      await admin.keyboard.press('Escape');
      await expect(detail).toBeHidden();
      await maskedRow.getByLabel('상태', { exact: true }).selectOption('진행');
      await expect(admin.locator('.chip', { hasText: '진행' })).toContainText('1');
    });

    await test.step('관리 화면에서 검색과 페이지 필터를 쓰고 실제 엑셀에 두 캡처를 받는다', async () => {
      const rows = admin.locator('table.tbl tbody tr');
      const search = admin.getByPlaceholder('내용·등록자 검색');
      await search.fill('연혁');
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText('연혁');
      await search.fill('');
      const pageFilter = admin.getByLabel('페이지 필터');
      await pageFilter.selectOption({ index: 1 });
      await expect(rows).toHaveCount(1);
      await pageFilter.selectOption({ index: 0 });
      await expect(rows).toHaveCount(2);
      const [download] = await Promise.all([admin.waitForEvent('download'), admin.getByRole('link', { name: /엑셀로 받기/ }).click()]);
      expect(download.suggestedFilename()).toMatch(/^수정요청서_.*\.xlsx$/);
      const workbook = unzipSync(new Uint8Array(await readFile(await download.path())));
      expect(Object.keys(workbook).filter(n => /^xl\/media\/.+/.test(n))).toHaveLength(2);
      const list = strFromU8(workbook['xl/worksheets/sheet1.xml']!);
      expect(list.match(/HYPERLINK/g)).toHaveLength(2);
      expect(list).not.toContain('<drawing');
      expect(strFromU8(workbook['xl/worksheets/sheet2.xml']!)).toContain('<drawing');
    });

    await test.step('최근 자동 백업 오류가 복구 전까지만 관리자에게 표시된다', async () => {
      await recordScheduledBackup(t.dir, 'failed');
      await admin.reload();
      await expect(admin.getByRole('alert')).toContainText('최근 자동 백업을 완료하지 못했습니다');
      await recordScheduledBackup(t.dir, 'ok');
      await admin.reload();
      await expect(admin.getByText('자동 백업을 확인해 주세요.')).toHaveCount(0);
    });

    await test.step('한 페이지 앱의 주소별 핀을 유지하고 다른 페이지의 대화도 검수 안에서 연다', async () => {
      await review.goto(STAGE + '/app.html');
      await review.getByRole('link', { name: '주문 목록' }).click();
      await review.waitForURL(STAGE + '/app.html?tab=orders');
      await savePin(review, '#spa-body tr:first-child td:first-child', '주문 목록 너비 확인');
      const pin = review.locator('.marker').filter({ hasText: /^3$/ });
      await expect(pin).toBeVisible();
      await review.getByRole('link', { name: '설정', exact: true }).click();
      await review.waitForURL(STAGE + '/app.html?tab=settings');
      await expect(pin).toBeHidden();
      await review.goBack();
      await expect(pin).toBeVisible();
      await expect(review.locator('gp-widget')).toHaveCount(1);

      await review.locator('.bar button.ghost').click();
      const panel = review.locator('.panel');
      await expect(panel.locator('.tabx[aria-pressed="true"]')).toContainText('이 페이지');
      await panel.getByRole('button', { name: /전체/ }).click();
      await expect(panel.locator('.item')).toHaveCount(3);
      await panel.getByRole('button', { name: /내 것/ }).click();
      await expect(panel.locator('.item')).toHaveCount(3);
      await panel.locator('.item').filter({ hasText: '연혁 문구 확인' }).click();
      await expect(review.getByRole('dialog', { name: '대화' })).toContainText('연혁 문구 확인');
      expect(review.url()).toBe(STAGE + '/app.html?tab=orders');
    });

    await test.step('가림 영역의 내부·부모에 직접 찍은 핀과 위치 제안에 화면의 비밀값을 쓰지 않는다', async () => {
      await review.goto(STAGE + '/');
      await showMaskedFixture(review);
      await savePin(review, `#${MASK_SECRET}-child`, '가림 영역의 위치 확인', undefined, true);
      const [masked] = await t.sql<{ selector: string; text_hint: string }[]>`select selector, text_hint from requests where no = 4`;
      expect(masked!.text_hint).toBe('');
      expect(masked!.selector).toMatch(/:nth-child\(/);
      expect(masked!.selector).not.toContain(MASK_SECRET);
      expect(await review.evaluate(selector => document.querySelector(selector)?.id, masked!.selector)).toBe(`${MASK_SECRET}-child`);

      const form = await openPin(review, `#${MASK_SECRET}-parent`, true);
      await form.getByRole('button', { name: '위치 변경 제안' }).click();
      const destinations = form.getByRole('combobox', { name: '제안할 위치' });
      await expect(destinations).not.toContainText(MASK_SECRET);
      await destinations.selectOption({ label: '2번째 · 배치 기준 뒤로' });
      await form.getByRole('button', { name: '제안 미리보기' }).click();
      await expect(form.getByRole('img', { name: '제안 화면 미리보기' })).toBeVisible({ timeout: 25_000 });
      await form.getByRole('button', { name: '남기기', exact: true }).click();
      await expect(form).toBeHidden();
      const [proposal] = await t.sql<{ selector: string; text_hint: string; as_is: string; to_be: string; proposal_key: string }[]>`
        select selector, text_hint, as_is, to_be, proposal_key from requests where no = 5`;
      expect(proposal).toMatchObject({ text_hint: '', as_is: '1번째 · 가림 영역', to_be: '2번째 · 배치 기준 뒤로' });
      expect(proposal!.selector).toMatch(/:nth-child\(/);
      expect(await review.evaluate(selector => document.querySelector(selector)?.id, proposal!.selector)).toBe(`${MASK_SECRET}-parent`);
      expect(JSON.stringify(proposal)).not.toContain(MASK_SECRET);
      expect(proposal!.proposal_key).toBeTruthy();
    });
    await guest.close();
    await adminContext.close();
  } finally {
    if (previousCsp !== undefined) process.env.DEMO_CSP = previousCsp;
    demo?.close();
    await t.close();
  }
});
