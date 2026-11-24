import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { expect, test, firefox, type Browser } from '@playwright/test';
import { createSite, installManager, startTestApp } from './helpers.ts';
import { newTestContext } from './browser.ts';
import { startDemo } from '../demo/serve.mjs';
import { ReviewBrowser, seedReviewer } from './review-browser.ts';

test('Chromium 두 사람과 Firefox 한 사람의 협업', async ({ browser }) => {
  const step = test.step;
  const MAIN = 'http://127.0.0.1:8220';
  const SITE = 'http://127.0.0.1:8222';
  const OUT = 'test-results/collab';
  mkdirSync(OUT, { recursive: true });


  const t = await startTestApp({ PUBLIC_URL: MAIN, ALLOWED_HOSTS: '127.0.0.1:8220,localhost:80' });
  await t.app.listen({ port: 8220, host: '127.0.0.1' });
  let ffox: Browser | null = null;

  const api = (path: string, o: { method?: string; body?: unknown; cookie?: string } = {}) =>
    fetch(MAIN + path, { method: o.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });

  const { cookie, headers } = await installManager(t, '협업');
  const { site, token } = await createSite(t, headers, '협업 시험', SITE);
  const { id: siteId, widgetKey: key } = site;
  const invite = site.links[0].shareUrl as string;
  const demo = startDemo({ sitePort: 8222, cdnPort: 8223, log: false, preview: { appOrigin: MAIN, id: site.preview.id } });
  const open = async (browser: Browser, name: string) => {
    const ctx = await newTestContext(browser, { viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
    await seedReviewer(t, ctx, key, token, SITE, name);
    const review = new ReviewBrowser(await ctx.newPage(), invite);
    await review.goto();
    return review;
  };
  const pin = async (p: ReviewBrowser, selector: string, text: string) => {
    await p.evaluate((sel) => document.querySelector(sel)!.scrollIntoView({ block: 'center' }), selector);
    await p.waitForTimeout(300);
    await p.locator('.bar button.primary').click();
    await p.locator('.banner').waitFor();
    const b = (await p.locator(selector).first().boundingBox())!;
    await p.mouse.click(b.x + Math.min(b.width / 2, 120), b.y + Math.min(b.height / 2, 14));
    await p.locator('.pop textarea').first().fill(text);
    await p.locator('.pop .thumb img').waitFor({ timeout: 25000 });
    await p.locator('.pop button.primary').click();
    await p.locator('.toast', { hasText: /#\d+/ }).waitFor();
  };
  const marker = (p: ReviewBrowser, no: number) => p.locator('.marker', { hasText: new RegExp(`^${no}$`) });
  const texts = (p: ReviewBrowser) => p.locator('.tpop .thread .cm .ctext, .tpop .thread .cm.first .dbody').allInnerTexts();
  const lat: Record<string, number> = {};
  const timed = async (label: string, since: number, fn: () => Promise<unknown>) => { await fn(); lat[label] = Math.round((Date.now() - since) / 100) / 10; };

  let A: ReviewBrowser, B: ReviewBrowser, C: ReviewBrowser;
  try {
    const firefoxBrowser = ffox = await firefox.launch({ executablePath: firefox.executablePath() });
    console.log('\n[입장] 세 사람이 같은 초대 미리보기를 연다');
    await step('세 참여자의 초대 미리보기에 위젯이 열린다', async () => {
      A = await open(browser, 'A 김에이');
      B = await open(browser, 'B 박디자인');
      C = await open(firefoxBrowser, 'C 최개발');
      for (const p of [A, B, C]) assert.equal(await p.locator('.modal').count(), 0);
    });

    console.log('\n[새 핀 알림] 한 사람이 핀을 꽂으면 나머지 둘에게 새로고침 없이 전해진다');
    await step('A 가 핀 #1 을 꽂으면 B·C 가 알림을 받고 같은 핀이 보인다', async () => {
      await pin(A, '#hero h1, .hero h1, h1', '히어로 제목이 너무 작아요');
      const t0 = Date.now();
      await Promise.all([
        timed('A핀→B알림(초)', t0, () => B.locator('.toast', { hasText: 'A 김에이' }).waitFor({ timeout: 20000 })),
        timed('A핀→C알림(초)', t0, () => C.locator('.toast', { hasText: 'A 김에이' }).waitFor({ timeout: 20000 })),
      ]);
      for (const p of [B, C]) { await p.evaluate(() => window.scrollTo(0, 0)); await marker(p, 1).waitFor({ timeout: 15000 }); }
    });
    await step('B 가 핀 #2 를 꽂으면 A·C 가 알림을 받는다', async () => {
      await pin(B, '.btn, a.btn, button', '버튼 색이 배경과 겹쳐요');
      const t0 = Date.now();
      await Promise.all([
        timed('B핀→A알림(초)', t0, () => A.locator('.toast', { hasText: 'B 박디자인' }).waitFor({ timeout: 20000 })),
        timed('B핀→C알림(초)', t0, () => C.locator('.toast', { hasText: 'B 박디자인' }).waitFor({ timeout: 20000 })),
      ]);
    });

    console.log('\n[한 핀에서 세 사람이 대화] 모두 같은 순서로 같은 말을 본다');
    const A_MSG = 'A: 이 제목 시안은 32px 였어요';
    const B_MSG = 'B: 네, 32px 로 키울게요';
    const C_MSG = 'C: 모바일에서는 28px 로 줄여요';
    await step('세 사람이 #1 핀의 대화창을 연다', async () => {
      for (const p of [A, B, C]) { await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(400); await marker(p, 1).click(); await p.locator('.tpop').waitFor(); }
    });
    await step('A → B → C 순서로 말하면, 각자 새로고침 없이 나머지의 말을 본다', async () => {
      await A.locator('.tpop .compose textarea').fill(A_MSG); await A.keyboard.press('Enter');
      let t0 = Date.now();
      await Promise.all([B, C].map((p, i) => timed(`A말→${i ? 'C' : 'B'}(초)`, t0, () => p.locator('.tpop .cm', { hasText: A_MSG }).waitFor({ timeout: 15000 }))));
      await B.locator('.tpop .compose textarea').fill(B_MSG); await B.keyboard.press('Enter');
      t0 = Date.now();
      await Promise.all([A, C].map((p, i) => timed(`B말→${i ? 'C' : 'A'}(초)`, t0, () => p.locator('.tpop .cm', { hasText: B_MSG }).waitFor({ timeout: 15000 }))));
      await C.locator('.tpop .compose textarea').fill(C_MSG); await C.keyboard.press('Enter');
      t0 = Date.now();
      await Promise.all([A, B].map((p, i) => timed(`C말→${i ? 'B' : 'A'}(초)`, t0, () => p.locator('.tpop .cm', { hasText: C_MSG }).waitFor({ timeout: 15000 }))));
    });
    await step('세 화면의 대화가 같은 순서로 똑같다 (첫 요청 → A → B → C)', async () => {
      const [a, b, c] = await Promise.all([texts(A), texts(B), texts(C)]);
      assert.deepEqual(a, ['히어로 제목이 너무 작아요', A_MSG, B_MSG, C_MSG]);
      assert.deepEqual(b, a);
      assert.deepEqual(c, a);
      await A.screenshot({ path: `${OUT}/A.png` });
      await C.screenshot({ path: `${OUT}/C.png` });
    });

    console.log('\n[상태·권한]');
    await step('C 가 해결 → 모두에게 기록과 상태가 보이고, B 가 다시 열 수 있다', async () => {
      await C.locator('.tpop .status .btn.ok').click();
      await C.locator('.tpop .sys', { hasText: '완료로 표시했어요' }).waitFor();
      await Promise.all([A, B].map((p) => p.locator('.tpop .sys', { hasText: '완료로 표시했어요' }).waitFor({ timeout: 15000 })));
      assert.match(await A.locator('.tpop .thead .st').innerText(), /완료/);
      await B.locator('.tpop .status .btn.warn').click();
      await Promise.all([A, C].map((p) => p.locator('.tpop .sys', { hasText: '다시 열었어요' }).waitFor({ timeout: 15000 })));
    });
    await step('남의 요청은 지우거나 고칠 수 없다 (서버가 403 으로 막는다). 요청 번호 #1 #2 는 그대로다', async () => {
      const list = await (await api(`/api/sites/${siteId}/requests`, { cookie })).json();
      const first = list.requests.find((r: { no: number }) => r.no === 1);
      assert.ok(first);
      const call = (p: ReviewBrowser, method: 'DELETE' | 'PATCH') => p.evaluate(async ({ base, key, id, method }) => {
        const session = window.__gpBoot?.session;
        const r = await fetch(`${base}/api/w/requests/${id}`, { method, mode: 'cors', credentials: 'omit', headers: { 'X-GP-Key': key, 'Content-Type': 'application/json', Authorization: `Bearer ${session ?? ''}` }, body: method === 'PATCH' ? JSON.stringify({ body: '남의 요청 고치기' }) : undefined });
        return r.status;
      }, { base: MAIN, key, id: first.id, method });
      for (const p of [B, C]) { assert.equal(await call(p, 'DELETE'), 403); assert.equal(await call(p, 'PATCH'), 403); }
      assert.equal((await (await api(`/api/sites/${siteId}/requests`, { cookie })).json()).total, 2);
    });
    await step('에이전시 화면 데이터에도 세 사람의 대화가 그대로 있다', async () => {
      const list = await (await api(`/api/sites/${siteId}/requests`, { cookie })).json();
      const first = list.requests.find((r: { no: number }) => r.no === 1);
      const d = (await (await api(`/api/requests/${first.id}`, { cookie })).json()).request;
      const bodies = d.comments.filter((c: { type: string }) => c.type === 'reviewer').map((c: { body: string }) => c.body);
      assert.deepEqual(bodies, [A_MSG, B_MSG, C_MSG]);
      assert.deepEqual(d.comments.filter((c: { type: string }) => c.type === 'system').length, 2);
    });
    await step('작성자만 수정·삭제 메뉴를 사용하고 다른 브라우저에도 적용된다', async () => {
      const menu = (p: ReviewBrowser) => p.getByRole('button', { name: '더 보기', exact: true });
      await menu(B).click();
      await expect(B.locator('.tpop .tmore')).toBeVisible();
      await expect(B.locator('.tpop .own')).toHaveCount(0);
      await menu(B).click();
      await menu(A).click();
      await A.getByRole('button', { name: '내용 고치기', exact: true }).click();
      const body = '히어로 제목을 32px로 키워 주세요';
      await A.getByRole('textbox', { name: '요청 내용 수정' }).fill(body);
      await A.locator('.tpop .actions .btn.primary').click();
      for (const p of [A, B, C]) await expect(p.locator('.tpop .cm.first .dbody')).toHaveText(body);

      await menu(A).click();
      await A.locator('.tpop .own').getByRole('button', { name: '지우기', exact: true }).click();
      await A.locator('.tpop .danger').getByRole('button', { name: '지우기', exact: true }).click();
      for (const p of [A, B, C]) {
        await expect(p.locator('.tpop')).toHaveCount(0);
        await expect(marker(p, 1)).toHaveCount(0);
      }
      assert.equal((await (await api(`/api/sites/${siteId}/requests`, { cookie })).json()).total, 1);
    });
  } finally {
    console.log(`\n실시간 전달 시간(초): ${JSON.stringify(lat)}`);
    await ffox?.close();
    await Promise.all(browser.contexts().map((context) => context.close()));
    demo.close();
    await t.close();
  }

});
