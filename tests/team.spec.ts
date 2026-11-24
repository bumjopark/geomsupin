import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { createSite, installManager, startTestApp } from './helpers.ts';
import { newTestContext } from './browser.ts';
import { startDemo } from '../demo/serve.mjs';
import { managerCookie, ReviewBrowser, seedReviewer } from './review-browser.ts';

test('팀장과 팀원의 여러 사이트 검수·돌발 상황', async ({ browser }) => {
  const step = test.step;
  const MAIN = 'http://127.0.0.1:8260';
  const SITE1 = 'http://127.0.0.1:8262'; // 연습 사이트(다른 origin)
  const MESSY = 'http://127.0.0.1:8268'; // 지저분한 사이트
  const OUT = 'test-results/team';
  mkdirSync(OUT, { recursive: true });


  // ── 지저분한 사이트 ──
  const rows = Array.from({ length: 80 }, (_, i) => `<div class="row" id="row-${i}">행 ${i} — 주문 항목 설명 <button class="edit">수정</button></div>`).join('');
  const MESSY_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>지저분한 사이트</title>
  <style>html{font-size:34px}*{margin:3px!important;letter-spacing:2px}button{all:unset;cursor:pointer;background:#ddd;padding:2px 8px}
  body{overflow:hidden;font-family:serif;margin:0}#hdr{position:fixed;top:0;left:0;right:0;height:50px;background:#223;color:#fff;z-index:100}
  #side{position:fixed;top:50px;left:0;bottom:0;width:140px;background:#eef}#scroller{position:absolute;top:50px;left:140px;right:0;bottom:0;overflow:auto}
  .row{padding:10px;border-bottom:1px solid #ccc}#dyn{padding:20px;background:#ffd}
  #cookie{position:fixed;left:10px;bottom:10px;z-index:2147483647;background:#333;color:#fff;padding:14px 22px;border-radius:8px}</style></head><body>
  <div id="hdr">관리 콘솔 (고정 헤더)</div><div id="side">사이드바</div><div id="scroller"><div id="dyn"></div>${rows}</div>
  <div id="cookie">쿠키를 허용하시겠습니까? (최대 z-index)</div>
  <script>let n=0;function render(){const d=document.getElementById('dyn');d.replaceChildren();const b=document.createElement('button');b.className='dynbtn';b.setAttribute('data-test','save-button');b.textContent='저장하기 #'+(++n);d.append('다시 그려지는 영역: ',b)}render();setInterval(render,1500);</script></body></html>`;
  const KEYS_CAPTURE = `<!doctype html><title>키 가로채는 사이트</title><body style="font:16px sans-serif"><h1 id="t">단축키가 많은 사이트</h1>
  <script>document.addEventListener('keydown',function(e){if(/^[a-zA-Z]$/.test(e.key)){e.preventDefault();window.__hot=(window.__hot||0)+1}},true)</script></body>`;
  const KEYS_BUBBLE = KEYS_CAPTURE.replace('},true)', '})');
  const MODAL = `<!doctype html><title>모달</title><body style="font:16px sans-serif"><button id="open" onclick="document.getElementById('m').style.display='block'">열기</button>
  <div id="m" style="display:none;position:fixed;left:200px;top:120px;width:360px;padding:20px;background:#fff;border:2px solid #333"><h2 id="mt">설정 모달</h2></div>
  <script>function outside(e){var m=document.getElementById('m');if(m.style.display==='block'&&!m.contains(e.target)&&e.target.id!=='open'){m.style.display='none';window.__closed=(window.__closed||0)+1}}
  document.addEventListener('mousedown',outside);document.addEventListener('click',outside)</script></body>`;
  const t = await startTestApp({ PUBLIC_URL: MAIN, ALLOWED_HOSTS: '127.0.0.1:8260,localhost:80' });
  await t.app.listen({ port: 8260, host: '127.0.0.1' });
  const admin = await installManager(t, '박팀장');
  const cookie = admin.cookie;
  const { site, token } = await createSite(t, admin.headers, '신규 리뉴얼 검수', SITE1);
  const { site: messySite, token: messyToken } = await createSite(t, admin.headers, '복잡한 스테이징', MESSY);
  const siteId = site.id as string;
  const demo = startDemo({ sitePort: 8262, cdnPort: 8263, log: false, preview: { appOrigin: MAIN, id: site.preview.id } });
  const messy = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const path = req.url ?? '/';
    const body = path.startsWith('/keys-bubble') ? KEYS_BUBBLE : path.startsWith('/keys') ? KEYS_CAPTURE : path.startsWith('/modal') ? MODAL : MESSY_PAGE;
    res.end(body.replace('</body>', `<script defer src="${MAIN}/w.js" data-gp-preview="${messySite.preview.id}"></script></body>`));
  }).listen(8268, '127.0.0.1');
  const api = (p: string, o: { method?: string; body?: unknown; cookie?: string } = {}) =>
    fetch(MAIN + p, { method: o.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });

  const pin = async (p: ReviewBrowser, selector: string, text: string, dx = 40, dy = 8) => {
    await p.evaluate((sel) => document.querySelector(sel)!.scrollIntoView({ block: 'center' }), selector);
    await p.waitForTimeout(250);
    await p.locator('.bar button.primary').click(); await p.locator('.banner').waitFor();
    const b = (await p.locator(selector).first().boundingBox())!;
    await p.mouse.click(b.x + Math.min(dx, b.width - 2), b.y + Math.min(dy, b.height - 2));
    await p.locator('.pop textarea').first().fill(text);
    await p.locator('.pop .thumb img').waitFor({ timeout: 25000 });
    await p.locator('.pop button.primary').click(); await p.locator('.toast', { hasText: /#\d+/ }).waitFor({ timeout: 20000 });
  };
  const marker = (p: ReviewBrowser, no: number) => p.locator('.marker', { hasText: new RegExp(`^${no}$`) });

  const names = ['김디자인', '이개발', '최기획', '정QA'];
  const people: { name: string; page: ReviewBrowser }[] = [];
  let leadPage: Page | null = null;

  async function open(name: string, stage = SITE1, path = '/', size = { width: 1440, height: 900 }) {
    const selected = stage === MESSY ? messySite : site;
    const ctx = await newTestContext(browser, { viewport: size });
    await seedReviewer(t, ctx, selected.widgetKey, stage === MESSY ? messyToken : token, stage, name);
    const review = new ReviewBrowser(await ctx.newPage(), selected.links[0].shareUrl);
    await review.goto(stage + path);
    return review;
  }

  try {
    await step('네 명이 초대를 열고 첫 핀을 확인한다', async () => {
      for (const name of names) people.push({ name, page: await open(name) });
      await pin(people[0]!.page, 'h1', '히어로 제목이 작아요');
    });
    const [A, B, C, D] = people as [typeof people[number], typeof people[number], typeof people[number], typeof people[number]];
    for (const x of people) { await x.page.evaluate(() => window.scrollTo(0, 0)); }
    await step('세 팀원이 동시에 답글을 달면 네 사람 모두 같은 대화를 본다', async () => {
      await Promise.all(people.map(async (x) => { await x.page.waitForTimeout(7000); await marker(x.page, 1).waitFor({ timeout: 15000 }); }));
      for (const x of people) { await marker(x.page, 1).click(); await x.page.locator('.tpop').waitFor(); }
      await Promise.all(people.slice(1).map(async (x) => { await x.page.locator('.tpop .compose textarea').fill(`${x.name}: 동시에 단 답글`); await x.page.keyboard.press('Enter'); }));
      for (const x of people) {
        await expect(x.page.locator('.tpop .thread .cm')).toHaveCount(4, { timeout: 15000 });
        for (const author of people.slice(1)) await expect(x.page.locator('.ctext', { hasText: `${author.name}: 동시에 단 답글` })).toHaveCount(1);
      }
      await A.page.screenshot({ path: `${OUT}/thread-4people.png` });
    });
    await step('쓰던 답글은 대화창을 닫았다 열어도 남아 있다 (바깥 클릭·Esc)', async () => {
      await C.page.locator('.tpop .compose textarea').fill('이건 보내려고 길게 쓰던 중인 글입니다');
      await C.page.mouse.click(700, 190);
      await C.page.locator('.tpop').waitFor({ state: 'detached' });
      await marker(C.page, 1).click(); await C.page.locator('.tpop').waitFor();
      assert.equal(await C.page.locator('.tpop .compose textarea').inputValue(), '이건 보내려고 길게 쓰던 중인 글입니다');
      await C.page.locator('.tpop .compose textarea').fill('');
      await C.page.keyboard.press('Escape');
    });
    await step('알림: 다른 사람이 내 대화창이 닫힌 핀에 댓글을 달면 "누가 무슨 말을" 알림이 오고, 누르면 그 대화가 열린다', async () => {
      await A.page.keyboard.press('Escape');
      await A.page.locator('.tpop').waitFor({ state: 'detached' });
      await B.page.locator('.tpop .compose textarea').fill('알림 시험: 이 제목 32px 로 키울게요'); await B.page.keyboard.press('Enter');
      const toast = A.page.locator('.toast.act', { hasText: '이개발' });
      await toast.waitFor({ timeout: 15000 });
      assert.match(await toast.innerText(), /알림 시험/);
      await toast.click();
      await A.page.locator('.tpop').waitFor();
      assert.ok(await A.page.locator('.tpop .cm', { hasText: '알림 시험' }).count() >= 1);
      await A.page.keyboard.press('Escape');
    });

    console.log('\n[6] 새로고침·탭 전환');
    await step('새로고침하면 검수 세션과 열려 있던 대화가 복원된다', async () => {
      await marker(A.page, 1).click(); await A.page.locator('.tpop').waitFor();
      await A.page.reload();
      await A.page.locator('.tpop').waitFor({ timeout: 10000 });
      assert.match(await A.page.locator('.tpop .cm.first .dbody').innerText(), /히어로 제목이 작아요/);
      await A.page.keyboard.press('Escape');
    });
    await step('탭이 숨겨졌다 돌아오면 바로 최신 목록으로 맞춘다', async () => {
      await D.page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:function(){return true}});document.dispatchEvent(new Event('visibilitychange'))");
      await pin(A.page, 'h1', '숨겨진 동안 올린 핀');
      await A.page.waitForTimeout(8000);
      const before = await D.page.locator('.bar .count').innerText();
      await D.page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:function(){return false}});document.dispatchEvent(new Event('visibilitychange'))");
      await D.page.waitForTimeout(3000);
      assert.notEqual(await D.page.locator('.bar .count').innerText(), before);
    });

    console.log('\n[7] 핀이 쌓였을 때 / 목록 응답');
    await step('해결된 핀은 흐리게 보이고, "완료 숨기기"를 켜면 핀도 사라진다', async () => {
      await B.page.evaluate(() => window.scrollTo(0, 0));
      await B.page.waitForTimeout(500);
      // 같은 요소의 같은 자리에 핀이 둘(#1, #2) 있어도 둘 다 눌러 볼 수 있다(겹치지 않게 펼쳐진다)
      const b1 = (await marker(B.page, 1).boundingBox())!; const b2 = (await marker(B.page, 2).boundingBox())!;
      assert.ok(Math.hypot(b1.x - b2.x, b1.y - b2.y) >= 18, `겹친 핀이 펼쳐지지 않았다(거리 ${Math.hypot(b1.x - b2.x, b1.y - b2.y).toFixed(1)}px)`);
      if (await B.page.locator('.tpop').count()) { await B.page.keyboard.press('Escape'); await B.page.locator('.tpop').waitFor({ state: 'detached' }); }
      await marker(B.page, 1).click(); await B.page.locator('.tpop').waitFor();
      await B.page.locator('.tpop .status .btn.ok').click();
      await B.page.locator('.tpop .sys', { hasText: '완료로 표시했어요' }).waitFor();
      await B.page.keyboard.press('Escape');
      await B.page.waitForTimeout(500);
      const op = await marker(B.page, 1).evaluate((el) => getComputedStyle(el).opacity);
      assert.ok(Number(op) < 0.9, `완료된 핀이 흐려지지 않았다(opacity ${op})`);
      await B.page.locator('.bar button.ghost').click();
      await B.page.locator('.chip', { hasText: '완료 숨기기' }).click();
      await B.page.waitForTimeout(300);
      assert.equal(await marker(B.page, 1).isVisible(), false, '완료 숨기기를 켜도 핀이 보인다');
      await B.page.locator('.chip', { hasText: '완료 숨기기' }).click();
      await B.page.locator('.panel .x[aria-label="닫기"]').click();
    });
    await step('바뀐 게 없으면 서버가 목록 본문을 다시 보내지 않는다(요청이 많을 때 폴링 부담)', async () => {
      let unchanged = 0; let full = 0;
      D.page.page.on('response', async (r) => { if (r.url().includes('/api/w/requests?v=')) { try { (await r.json()).unchanged ? unchanged++ : full++; } catch { /* */ } } });
      await D.page.waitForTimeout(20000);
      assert.ok(unchanged >= 2, `변경 없음 응답이 ${unchanged}번(전체 ${full}번)`);
    });

    console.log('\n[8] 팀장 화면은 열어 둔 채로 새 요청이 저절로 나타난다');
    await step('팀장이 관리 화면을 열어 둔 사이 팀원이 핀을 꽂으면 새로고침 없이 목록에 나타난다', async () => {
      const leadCtx = await newTestContext(browser, { viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
      await managerCookie(leadCtx, MAIN, cookie);
      leadPage = await leadCtx.newPage();
      await leadPage.goto(`${MAIN}/sites/${siteId}`);
      await leadPage.locator('table.tbl tbody tr').first().waitFor();
      const n0 = await leadPage.locator('table.tbl tbody tr').count();
      await pin(C.page, 'h1', '팀장이 자리를 비운 사이 올린 요청');
      await leadPage.locator('table.tbl tbody tr', { hasText: '자리를 비운 사이' }).waitFor({ timeout: 20000 });
      assert.equal(await leadPage.locator('table.tbl tbody tr').count(), n0 + 1);
      await leadPage.screenshot({ path: `${OUT}/lead-live.png`, fullPage: true });
    });

    console.log('\n[8b] 연결이 잠깐 끊기면');
    await step('연결이 끊긴 동안 새 요청이 와도 복구 안내와 새 소식을 함께 보여 주고 대화를 연다', async () => {
      await D.page.route('**/api/w/**', (r) => r.abort());
      await D.page.locator('.toast', { hasText: '연결이 끊겼어요' }).waitFor({ timeout: 25000 });
      const pending = '연결이 끊긴 동안 다른 팀원이 남긴 요청';
      await pin(A.page, 'h1', pending);
      await D.page.unroute('**/api/w/**');
      const restored = D.page.locator('.toast.act', { hasText: '다시 연결됐어요' });
      await expect(restored).toContainText(pending, { timeout: 25000 });
      await restored.click();
      await expect(D.page.locator('.tpop .dbody')).toHaveText(pending);
    });

    console.log('\n[9] 지저분한 사이트에서도 버틴다');
    let messyPage: ReviewBrowser;
    await step('공격적인 사이트 CSS 속에서도 막대 모양이 유지되고, 최대 z-index 쿠키 배너 위에 올라온다', async () => {
      const p = await open('김디자인', MESSY, '/', { width: 1280, height: 720 });
      const bb = (await p.locator('.bar').boundingBox())!;
      assert.ok(bb.height < 70 && bb.width < 420, `막대 크기 ${bb.width}x${bb.height}`);
      const top = await p.evaluate(() => { const r = document.querySelector('gp-widget')!.shadowRoot!.querySelector('.bar')!.getBoundingClientRect(); return document.elementFromPoint(r.left + 40, r.top + 20)?.tagName ?? ''; });
      assert.match(top, /GP-WIDGET/i, `막대 위치의 최상단 요소: ${top}`);
      await p.screenshot({ path: `${OUT}/messy-css.png` });
      messyPage = p;
    });
    const mp = () => messyPage;
    await step('안쪽 스크롤 영역: 스크롤하면 핀이 요소를 따라가고, 다시 그려지는 요소의 핀은 유지된다', async () => {
      const p = mp();
      await p.evaluate(() => document.getElementById('row-26')!.scrollIntoView({ block: 'center' }));
      await p.waitForTimeout(300);
      await pin(p, '#row-26 .edit', '이 수정 버튼 문구가 모호해요', 10, 8);
      await p.waitForTimeout(400);
      const y1 = (await p.locator('.marker').first().boundingBox())!.y;
      await p.evaluate(() => { document.getElementById('scroller')!.scrollTop -= 100; });
      await p.waitForTimeout(500);
      const y2 = (await p.locator('.marker').first().boundingBox())!.y;
      assert.ok(Math.abs(y2 - y1 - 100) <= 6, `안쪽 스크롤 100px 에 핀이 ${y2 - y1}px 움직였다`);
      await p.evaluate(() => { document.getElementById('scroller')!.scrollTop = 0; });
      await pin(p, '#dyn .dynbtn', '저장 버튼 위치가 어색해요');
      await p.waitForTimeout(4500);
      const [saved] = await t.sql`select no, selector from requests where site_id = ${messySite.id} and body = '저장 버튼 위치가 어색해요'`;
      assert.equal(saved!.selector, 'button[data-test="save-button"]');
      await expect(marker(p, saved!.no)).toBeVisible();
      const pinBox = (await marker(p, saved!.no).boundingBox())!;
      const targetBox = (await p.locator('[data-test="save-button"]').boundingBox())!;
      assert.ok(Math.abs(pinBox.y + pinBox.height / 2 - (targetBox.y + 8)) < 4, '다시 그린 요소와 핀의 위치가 달라졌다');
    });
    await step('긴 글·긴 주소·악성 입력(XSS)·많은 대화: 가로 스크롤 없이, 마지막으로 스크롤되고, 입력한 HTML 은 실행되지 않는다', async () => {
      const p = mp();
      await p.locator('.marker:visible').first().click(); await p.locator('.tpop').waitFor();
      for (const msg of ['https://example.com/' + 'a'.repeat(260), '<img src=x onerror="window.__xss=1"> <script>window.__xss=2</script>', ...Array.from({ length: 25 }, (_, i) => `대화 ${i + 1}번째 말`)]) {
        await expect(p.locator('.tpop .compose button')).toBeEnabled();
        await p.locator('.tpop .compose textarea').fill(msg); await p.keyboard.press('Enter');
        await expect(p.locator('.ctext').last()).toHaveText(msg);
      }
      await p.waitForTimeout(800);
      const g = await p.evaluate(() => { const sc = document.querySelector('gp-widget')!.shadowRoot!.querySelector('.tpop .tscroll') as HTMLElement; return { over: sc.scrollWidth > sc.clientWidth + 2, atEnd: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 30 }; });
      assert.equal(g.over, false, '긴 글 때문에 가로 스크롤이 생겼다');
      assert.equal(g.atEnd, true, '새 말풍선으로 스크롤되지 않았다');
      assert.equal(await p.evaluate('typeof window.__xss'), 'undefined', '입력한 HTML 이 실행됐다');
      await p.screenshot({ path: `${OUT}/messy-thread.png` });
      await p.keyboard.press('Escape');
    });
    await step('사이트가 글자 키를 가로채도(캡처·버블 단계 모두) 위젯 입력창에 글이 써지고, 사이트 단축키는 반응하지 않는다', async () => {
      for (const path of ['keys', 'keys-bubble']) {
        const p = await open('이개발', MESSY, `/${path}`, { width: 1280, height: 720 });
        await p.locator('.bar button.primary').click(); await p.locator('.banner').waitFor();
        const b = (await p.locator('#t').boundingBox())!; await p.mouse.click(b.x + 20, b.y + 10);
        await p.locator('.pop textarea').first().click(); await p.keyboard.type('hello world', { delay: 12 });
        assert.equal(await p.locator('.pop textarea').first().inputValue(), 'hello world', `${path}: 입력창 글`);
        assert.equal(await p.evaluate('window.__hot || 0'), 0, `${path}: 사이트 단축키가 위젯 입력에 반응했다`);
        await p.context().close();
      }
    });
    await step('바깥을 누르면 닫히는 사이트 모달 안의 요소에도 핀을 꽂을 수 있다(모달이 닫히지 않는다)', async () => {
      const p = await open('최기획', MESSY, `/modal`, { width: 1280, height: 720 });
      await p.locator('#open').click();
      await p.locator('.bar button.primary').click(); await p.locator('.banner').waitFor();
      const b = (await p.locator('#mt').boundingBox())!; await p.mouse.click(b.x + 20, b.y + 10);
      await p.locator('.pop textarea').first().waitFor();
      assert.equal(await p.locator('#m').isVisible(), true, '핀을 꽂으려는 클릭에 모달이 닫혔다');
      assert.equal(await p.evaluate('window.__closed || 0'), 0);
      await p.context().close();
    });
    await step('좁은 창(800×500)에서도 대화창이 화면 밖으로 나가거나 하단 막대와 겹치지 않는다', async () => {
      const vp = { width: 800, height: 500 };
      const p = await open('정QA', MESSY, '/', vp);
      await p.waitForTimeout(500);
      await p.locator('.marker:visible').first().click(); await p.locator('.tpop').waitFor();
      await p.waitForTimeout(400);
      const tp = (await p.locator('.tpop').boundingBox())!; const br = (await p.locator('.bar').boundingBox())!;
      assert.ok(tp.x >= 0 && tp.y >= 0 && tp.x + tp.width <= vp.width && tp.y + tp.height <= vp.height, '대화창이 화면 밖으로 나갔다');
      assert.ok(tp.x + tp.width <= br.x || tp.x >= br.x + br.width || tp.y + tp.height <= br.y || tp.y >= br.y + br.height, '대화창이 하단 막대와 겹친다');
      await p.context().close();
    });

    console.log('\n[10] 팀장이 검수를 종료하면');
    await step('팀원 화면에 "종료됐어요" 안내가 뜬다 (조용히 멈추지 않는다)', async () => {
      await api(`/api/sites/${siteId}`, { method: 'PATCH', cookie, body: { status: 'done' } });
      await C.page.page.getByRole('heading', { name: '검수가 끝났어요' }).waitFor({ timeout: 20000 });
      await api(`/api/sites/${siteId}`, { method: 'PATCH', cookie, body: { status: 'active' } });
    });
    await step('다시 연 프로젝트에 기존 초대로 복귀한다', async () => {
      await C.page.reload();
      assert.equal(await C.page.locator('.modal').count(), 0);
      assert.ok((await C.page.locator('.bar .count').innerText()) !== '0');
    });
  } finally {
    await Promise.all(browser.contexts().map((context) => context.close()));
    demo.close(); messy.close();
    await t.close();
  }

});
