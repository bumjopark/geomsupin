import assert from 'node:assert/strict';
import { test, expect, type Route } from '@playwright/test';
import { createSite, openReviewer, HOST, installManager, startTestApp } from './helpers.ts';
import { newTestContext } from './browser.ts';
import { startDemo } from '../demo/serve.mjs';
import { managerCookie, openReviewPreview, ReviewBrowser, seedReviewer } from './review-browser.ts';

test('응답 유실·경합·저장소 차단·대량 데이터 회귀', async ({ browser }) => {
  const step = test.step;
  const MAIN = 'http://127.0.0.1:8270';
  const SITE = 'http://127.0.0.1:8272';
  const t = await startTestApp({ PUBLIC_URL: MAIN, ALLOWED_HOSTS: '127.0.0.1:8270,localhost:80' });
  await t.app.listen({ port: 8270, host: '127.0.0.1' });
  const admin = await installManager(t, '팀장');
  const { site, token } = await createSite(t, admin.headers, '회귀 검증', SITE);
  const invite = site.links[0].shareUrl as string;
  const demo = startDemo({ sitePort: 8272, cdnPort: 8273, log: false, preview: { appOrigin: MAIN, id: site.preview.id } });
  const pid = 'reliability_person_123456';
  const wh = { ...HOST, origin: SITE, 'x-gp-key': site.widgetKey };
  const session = (await openReviewer(t, wh, token, { pid, name: '검수자' })).json().session;
  const ids: string[] = [];
  for (const body of ['요청 하나', '요청 둘', '긴 대화']) {
    const response = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: { ...wh, authorization: `Bearer ${session}` }, payload: { pageUrl: SITE + '/', viewportW: 1440, viewportH: 900, selector: 'h1', offsetX: 0.2, offsetY: 0.5, body } });
    assert.equal(response.statusCode, 200); ids.push(response.json().request.id);
  }
  await t.sql`insert into comments (request_id, author_type, author_name, body, created_at)
    select ${ids[2]!}, 'agency', '팀장', '이전 대화 ' || n, now() + n * interval '1 microsecond' from generate_series(1, 305) as n`;
  async function widget(blockStorage = false) {
    const context = await newTestContext(browser, { viewport: { width: 1440, height: 900 } });
    await seedReviewer(t, context, site.widgetKey, token, SITE, '검수자', pid);
    if (blockStorage) await context.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const review = new ReviewBrowser(page, invite);
    await review.goto();
    return review;
  }
  async function manager(id?: string) {
    const context = await newTestContext(browser, { viewport: { width: 1440, height: 1000 } });
    await managerCookie(context, MAIN, admin.cookie);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(`${MAIN}/sites/${site.id}${id ? `?r=${id}` : ''}`);
    await page.locator('table.tbl').waitFor();
    if (id) await page.locator('.drawer .reqtext').first().waitFor();
    return page;
  }
  async function openThread(page: ReviewBrowser, no: number) {
    await page.locator('.marker', { hasText: new RegExp(`^${no}$`) }).click();
    await page.locator('.tpop .cwho').first().waitFor();
  }
  async function comment(id: string, body: string) {
    const result = await t.app.inject({ method: 'POST', url: `/api/requests/${id}/comments`, headers: admin.headers, payload: { body } });
    assert.equal(result.statusCode, 200);
  }
  // 서버 처리 후 응답만 늦춰, 사용자가 응답을 기다리는 동안 다른 행동을 하는 상황을 재현한다.
  function deferredResponse() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    const handle = async (route: Route) => {
      const response = await route.fetch(); started = true; await gate; await route.fulfill({ response });
    };
    return { handle, release, started: () => started };
  }

  try {
    await step('저장 후 응답만 끊겨도 위젯 댓글 재시도는 한 건으로 남는다', async () => {
      const p = await widget();
      try {
        await openThread(p, 1);
        const url = `**/api/w/requests/${ids[0]}/comments`;
        await p.route(url, async (route) => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
        const input = p.getByRole('textbox', { name: '댓글', exact: true });
        await input.fill('응답 유실 후 다시 보내는 댓글');
        const send = p.locator('.tpop').getByRole('button', { name: '보내기', exact: true });
        await send.click(); await expect(send).toBeEnabled();
        await expect(input).toHaveValue('응답 유실 후 다시 보내는 댓글');
        await send.click(); await expect(input).toHaveValue('');
        assert.equal((await t.sql`select count(*)::int as n from comments where body = '응답 유실 후 다시 보내는 댓글'`)[0]!.n, 1);
      } finally { await p.context().close(); }
    });

    await step('관리 화면에서도 응답 유실 후 재전송한 댓글이 중복되지 않는다', async () => {
      const p = await manager(ids[0]);
      try {
        await p.route(`**/api/requests/${ids[0]}/comments`, async (route) => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
        const input = p.getByRole('textbox', { name: '댓글', exact: true });
        const send = p.getByRole('button', { name: '보내기', exact: true });
        await input.fill('관리 화면 응답 유실 댓글'); await send.click(); await expect(send).toBeEnabled();
        await expect(input).toHaveValue('관리 화면 응답 유실 댓글');
        await send.click(); await expect(input).toHaveValue('');
        assert.equal((await t.sql`select count(*)::int as n from comments where body = '관리 화면 응답 유실 댓글'`)[0]!.n, 1);
      } finally { await p.context().close(); }
    });

    await step('미리보기 전에 Enter를 누르면 전송하지 않고 스크린샷 제외를 선택할 수 있다', async () => {
      const p = await widget();
      try {
        await p.evaluate('window.__gpCapture = { captureViewport: () => new Promise(() => {}) }');
        await p.locator('.bar button.primary').click();
        const target = (await p.locator('h1').boundingBox())!;
        await p.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
        const text = p.getByRole('textbox', { name: '요청 내용', exact: true });
        await text.fill('멈춘 캡처 없이 저장');
        await text.press('Enter');
        await expect(p.locator('.pop .err')).toContainText('캡처 미리보기를 기다리거나 스크린샷 제외');
        assert.equal((await t.sql`select count(*)::int as n from requests where body = '멈춘 캡처 없이 저장'`)[0]!.n, 0);
        await p.getByRole('button', { name: '스크린샷 제외', exact: true }).click();
        await p.getByRole('button', { name: '남기기', exact: true }).click();
        await expect(p.getByRole('dialog', { name: '요청 남기기' })).toHaveCount(0);
        assert.equal((await t.sql`select count(*)::int as n from requests where body = '멈춘 캡처 없이 저장' and screenshot_key is null`)[0]!.n, 1);
      } finally { await p.context().close(); await t.sql`delete from requests where body = '멈춘 캡처 없이 저장'`; }
    });

    await step('핀 저장 후 응답이 끊겨도 재시도하면 같은 핀 하나로 남는다', async () => {
      const p = await widget();
      try {
        await p.evaluate('window.__gpCapture = { captureViewport: () => Promise.reject(new Error("capture failed")) }');
        await p.route('**/api/w/requests', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          await route.fetch(); await route.abort('failed'); await p.unroute('**/api/w/requests');
        });
        await p.locator('.bar button.primary').click();
        const target = (await p.locator('h1').boundingBox())!;
        await p.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
        const input = p.getByRole('textbox', { name: '요청 내용', exact: true });
        await input.fill('응답 유실 핀 재등록');
        await p.getByRole('button', { name: '남기기', exact: true }).click();
        await expect(p.locator('.pop .err')).toContainText('연결');
        await expect(input).toHaveValue('응답 유실 핀 재등록');
        await p.getByRole('button', { name: '남기기', exact: true }).click();
        await expect(p.getByRole('dialog', { name: '요청 남기기' })).toHaveCount(0);
        assert.equal((await t.sql`select count(*)::int as n from requests where body = '응답 유실 핀 재등록'`)[0]!.n, 1);
      } finally { await p.context().close(); await t.sql`delete from requests where body = '응답 유실 핀 재등록'`; }
    });

    await step('초대 조회 연결 오류는 유효하지 않은 링크로 오인하지 않고 다시 시도한다', async () => {
      const context = await newTestContext(browser); const p = await context.newPage();
      try {
        await p.route('**/api/share/*', (r) => r.abort('failed'), { times: 1 });
        await p.goto(`${MAIN}/r/${token}`);
        await expect(p.getByRole('heading', { name: '초대를 불러오지 못했어요' })).toBeVisible();
        await p.getByRole('button', { name: '미리보기 다시 연결' }).click();
        await new ReviewBrowser(p, invite).ready();
      } finally { await context.close(); }
    });

    await step('위젯 본체를 불러오지 못한 후 초대에서 다시 연결한다', async () => {
      const context = await newTestContext(browser); const p = await context.newPage();
      try {
        await p.route('**/w-core.*.js', route => route.abort('failed'), { times: 1 });
        await p.goto(invite);
        await openReviewPreview(p);
        await expect(p.getByRole('status').filter({ hasText: '핀 연결을 확인하지 못했어요' })).toBeVisible();
        const preview = new ReviewBrowser(p, invite);
        await expect(preview.getByRole('heading', { level: 1 })).toBeVisible();
        await p.getByRole('button', { name: '미리보기 다시 연결' }).click();
        await expect(preview.locator('.bar button.primary')).toBeVisible();
        await expect(p.getByRole('status').filter({ hasText: '핀 연결됨' })).toBeVisible();
      } finally { await context.close(); }
    });

    await step('위젯에서 내용을 고치는 중 새 댓글이 도착해도 초안과 포커스가 유지된다', async () => {
      const p = await widget();
      try {
        await openThread(p, 1); await p.getByRole('button', { name: '더 보기', exact: true }).click();
        await p.getByRole('button', { name: '내용 고치기', exact: true }).click();
        const edit = p.getByRole('textbox', { name: '요청 내용 수정' });
        await edit.fill('아직 작성 중인 수정 내용');
        await comment(ids[0]!, '수정 중에도 오는 새 댓글');
        await expect(p.locator('.ctext', { hasText: '수정 중에도 오는 새 댓글' })).toBeVisible({ timeout: 10000 });
        await expect(edit).toHaveValue('아직 작성 중인 수정 내용'); await expect(edit).toBeFocused();
      } finally { await p.context().close(); }
    });

    await step('위젯 댓글 전송을 기다리는 동안 쓴 다음 답글을 보존한다', async () => {
      const p = await widget(); const delayed = deferredResponse();
      try {
        await openThread(p, 1);
        await p.route(`**/api/w/requests/${ids[0]}/comments`, delayed.handle);
        const input = p.getByRole('textbox', { name: '댓글', exact: true });
        await input.fill('먼저 보내는 댓글'); await p.locator('.tpop').getByRole('button', { name: '보내기', exact: true }).click();
        await expect.poll(delayed.started).toBe(true);
        await input.fill('전송 도중 적은 다음 댓글'); delayed.release();
        await expect(p.locator('.tpop').getByRole('button', { name: '보내기', exact: true })).toBeEnabled();
        await expect(input).toHaveValue('전송 도중 적은 다음 댓글');
      } finally { delayed.release(); await p.context().close(); }
    });

    await step('위젯의 305번째 댓글과 이전 대화를 읽고, 새 댓글이 와도 이전 대화가 남는다', async () => {
      const p = await widget();
      try {
        await openThread(p, 3);
        await expect(p.locator('.ctext', { hasText: /^이전 대화 305$/ })).toHaveCount(1);
        await p.getByRole('button', { name: '이전 대화 보기' }).click();
        await expect(p.locator('.ctext', { hasText: /^이전 대화 1$/ })).toHaveCount(1);
        await comment(ids[2]!, '306번째 새 댓글');
        await expect(p.locator('.ctext', { hasText: '306번째 새 댓글' })).toHaveCount(1, { timeout: 10000 });
        await expect(p.locator('.ctext', { hasText: /^이전 대화 1$/ })).toHaveCount(1);
      } finally { await p.context().close(); }
    });

    await step('localStorage가 차단돼도 같은 탭에서 검수자의 본인 표시를 유지한다', async () => {
      const p = await widget(true);
      try { await openThread(p, 1); await expect(p.locator('.tpop .cm.first .cwho')).toContainText('검수자 (나)'); }
      finally { await p.context().close(); }
    });

    await step('관리 화면에서 다른 요청을 열면 앞 요청의 미전송 댓글이 섞이지 않는다', async () => {
      const p = await manager(ids[0]);
      try {
        await p.getByRole('textbox', { name: '댓글', exact: true }).fill('첫 요청에만 보낼 초안');
        await p.locator('table tr', { hasText: '요청 둘' }).evaluate((row) => (row as HTMLElement).click());
        await expect(p.locator('.drawer .reqtext').first()).toHaveText('요청 둘');
        await expect(p.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('');
      } finally { await p.context().close(); }
    });

    await step('늦게 도착한 이전 요청의 자동 갱신이 새로 연 상세를 덮어쓰지 않는다', async () => {
      const p = await manager(ids[0]); const delayed = deferredResponse();
      try {
        await p.route(`**/api/requests/${ids[0]}`, delayed.handle);
        await expect.poll(delayed.started, { timeout: 10000 }).toBe(true);
        await p.locator('table tr', { hasText: '요청 둘' }).evaluate((row) => (row as HTMLElement).click());
        await expect(p.locator('.drawer .reqtext').first()).toHaveText('요청 둘');
        const response = p.waitForResponse(`**/api/requests/${ids[0]}`); delayed.release(); await response;
        await p.waitForTimeout(100);
        await expect(p.locator('.drawer .reqtext').first()).toHaveText('요청 둘');
      } finally { delayed.release(); await p.context().close(); }
    });

    await step('관리 화면은 다른 사람의 담당 변경을 보여 주면서 작성 중인 메모를 보존한다', async () => {
      const p = await manager(ids[0]);
      try {
        const memo = p.locator('.drawer label', { hasText: '처리 메모' }).locator('textarea');
        await memo.fill('저장 전 내 메모');
        await t.app.inject({ method: 'PATCH', url: `/api/requests/${ids[0]}`, headers: admin.headers, payload: { assignee1: '새 담당자', resolutionNote: '다른 사람이 적은 메모' } });
        await expect(p.locator('.drawer label', { hasText: '1차 담당' }).locator('input')).toHaveValue('새 담당자', { timeout: 10000 });
        await expect(memo).toHaveValue('저장 전 내 메모');
        await p.locator('.drawer-head').click();
        await expect.poll(async () => (await t.sql`select resolution_note from requests where id = ${ids[0]!}`)[0]!.resolution_note).toBe('저장 전 내 메모');
      } finally { await p.context().close(); }
    });

    await step('관리 화면에서도 최신 댓글과 이전 대화를 모두 읽는다', async () => {
      const p = await manager(ids[2]);
      try {
        await expect(p.locator('.drawer .cm .txt', { hasText: '306번째 새 댓글' })).toHaveCount(1);
        await p.getByRole('button', { name: '이전 대화 보기' }).click();
        await expect(p.locator('.drawer .cm .txt', { hasText: /^이전 대화 1$/ })).toHaveCount(1);
      } finally { await p.context().close(); }
    });

    await step('관리 화면도 댓글 전송 중 새로 작성한 다음 답글을 보존한다', async () => {
      const p = await manager(ids[0]); const delayed = deferredResponse();
      try {
        await p.route(`**/api/requests/${ids[0]}/comments`, delayed.handle);
        const input = p.getByRole('textbox', { name: '댓글', exact: true });
        await input.fill('담당자가 먼저 보내는 댓글'); await p.getByRole('button', { name: '보내기', exact: true }).click();
        await expect.poll(delayed.started).toBe(true);
        await input.fill('담당자의 다음 답글'); delayed.release();
        await expect(p.getByRole('button', { name: '보내기', exact: true })).toBeEnabled();
        await expect(input).toHaveValue('담당자의 다음 답글');
      } finally { delayed.release(); await p.context().close(); }
    });

    await step('첫 목록 조회가 실패하면 계속 로딩하지 않고 재시도할 수 있다', async () => {
      const p = await manager();
      try {
        let fail = true;
        await p.route('**/api/sites/*/requests?*', (route) => {
          if (fail) { fail = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '시험 연결 오류' } }) }); }
          return route.continue();
        });
        await p.reload();
        await expect(p.getByRole('alert')).toContainText('시험 연결 오류');
        await p.getByRole('button', { name: '다시 시도' }).click();
        await expect(p.locator('table tbody tr')).toHaveCount(3);
      } finally { await p.context().close(); }
    });

    await step('검색 응답이 역순으로 도착해도 마지막 검색 결과를 유지한다', async () => {
      const p = await manager(); const delayed = deferredResponse();
      try {
        await p.route('**/api/sites/*/requests?*', (route) => new URL(route.request().url()).searchParams.get('q') === '하나' ? delayed.handle(route) : route.continue());
        const search = p.getByPlaceholder('내용·등록자 검색');
        await search.fill('하나'); await expect.poll(delayed.started).toBe(true);
        await search.fill('둘'); await expect(p.locator('table tbody tr')).toHaveCount(1);
        await expect(p.locator('table tbody tr')).toContainText('요청 둘');
        const response = p.waitForResponse((r) => new URL(r.url()).searchParams.get('q') === '하나');
        delayed.release(); await response; await p.waitForTimeout(100);
        await expect(p.locator('table tbody tr')).toContainText('요청 둘');
      } finally { delayed.release(); await p.context().close(); }
    });

    await step('요청이 200개를 넘어도 다음 페이지에서 빠짐없이 접근한다', async () => {
      await t.sql`insert into requests (site_id, round_id, no, reviewer_name, page_url, body)
        select ${site.id}, round_id, n, '검수자', ${SITE + '/'}, '대량 요청 ' || n from requests cross join generate_series(4, 205) as n where id = ${ids[0]!}`;
      const p = await manager();
      try {
        await expect(p.locator('table tbody tr')).toHaveCount(100);
        await p.getByRole('button', { name: '다음', exact: true }).click();
        await expect(p.getByRole('navigation', { name: '요청 목록 페이지' })).toContainText('101–200 / 205건');
        await p.getByRole('button', { name: '다음', exact: true }).click();
        await expect(p.locator('table tbody tr')).toHaveCount(5);
        await expect(p.locator('table tbody tr', { hasText: '요청 하나' })).toHaveCount(1);
      } finally { await p.context().close(); }
    });

    await step('핀 505개가 쌓여도 위젯에서 가장 오래된 요청에 접근한다', async () => {
      await t.sql`insert into requests (site_id, round_id, no, reviewer_name, page_url, body)
        select ${site.id}, round_id, n, '검수자', ${SITE + '/'}, '대량 요청 ' || n from requests cross join generate_series(206, 505) as n where id = ${ids[0]!}`;
      const p = await widget();
      try {
        await expect(p.locator('.bar .count')).toHaveText('505');
        await p.locator('.bar button', { hasText: '모두의 요청' }).click();
        await expect(p.locator('.panel .item')).toHaveCount(505);
        await p.locator('.panel .item', { hasText: '요청 하나' }).click();
        await expect(p.locator('.tpop .dbody')).toHaveText('요청 하나');
      } finally { await p.context().close(); }
    });
  } finally {
    await Promise.all(browser.contexts().map((context) => context.close()));
    demo.close();
    await t.close();
  }
});
