import { test, expect, chromium, firefox } from '@playwright/test';
import { createServer } from 'node:http';
import { join } from 'node:path';
import sharp from 'sharp';
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { startTestApp, installManager, createSite } from './helpers.ts';
import { newTestContext } from './browser.ts';
import { ReviewBrowser, seedReviewer } from './review-browser.ts';
declare const selectorTest: typeof import('../widget/env.ts');

const fixture = (script: string) => `<!doctype html><html><meta charset="utf-8"><title>Modal integration</title>
<style>body{font:18px sans-serif}dialog,.trap{background:#fff;padding:24px;width:500px}dialog{background:#8be6ae;transform:translateX(10px);contain:paint;overflow:hidden}h2{margin:20px}</style>
<body><input id="outside" aria-label="사이트 입력"><div class="trap" id="trap"><h2 id="target">수정할 제목</h2><input id="inside" aria-label="모달 입력"></div>
<dialog id="second"><h2>두 번째 창</h2><input></dialog><div style="transform:translate(80px,120px);contain:paint;overflow:hidden;width:100px;height:100px"><dialog id="first"><h2 id="native-target">네이티브 모달 제목</h2><input></dialog></div>
<script>
if(['/focus','/window','/window-container'].includes(location.pathname)){
  const redirected=location.pathname==='/window-container' ? document.getElementById('trap') : document.getElementById('inside');
  redirected.tabIndex=0;
  (location.pathname.startsWith('/window') ? window : document).addEventListener('focusin',e=>{if(!document.getElementById('trap').contains(e.target))redirected.focus()},true);
  redirected.focus();
}
if(location.pathname==='/legacy'){
  const original=Element.prototype.matches;
  Element.prototype.matches=function(selector){if(/:modal|:popover-open/.test(selector))throw new DOMException('unsupported selector','SyntaxError');return original.call(this,selector)};
}
if(location.pathname==='/native')document.getElementById('first').showModal();
if(location.pathname==='/shadow'){
  const component=document.createElement('x-modal');document.body.append(component);
  component.attachShadow({mode:'open'}).innerHTML='<dialog id="shadow-dialog" style="background:#8be6ae;width:500px;padding:24px"><h2 id="shadow-target">웹 컴포넌트 제목</h2><input aria-label="컴포넌트 입력"></dialog>';
  component.shadowRoot.querySelector('dialog').showModal();
}
if(location.pathname==='/library'){
  const script=document.createElement('script');script.src='/focus-trap.js';document.head.append(script);
}
</script>${script}</body></html>`;

async function compose(page: ReviewBrowser, selector: string) {
  await page.locator('.bar button.primary').click({ timeout: 3000 });
  const bounds = (await page.locator(selector).boundingBox())!;
  await page.mouse.click(bounds.x + 20, bounds.y + 10);
  await page.getByRole('textbox', { name: '요청 내용', exact: true }).waitFor();
}

test('가림 영역 옆에 있는 웹 컴포넌트의 핀을 같은 요소에서 다시 찾는다', async ({ page }) => {
  await page.setContent('<review-form></review-form>');
  const bundle = await build({ entryPoints: ['widget/env.ts'], bundle: true, write: false, format: 'iife', globalName: 'selectorTest' });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const matches = await page.evaluate(() => {
    const root = document.querySelector('review-form')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<section><button>Save</button><input type="password"></section><section><button>Cancel</button></section>';
    const save = root.querySelector('button')!;
    return selectorTest.findBySelector(selectorTest.buildSelector(save)) === save;
  });
  expect(matches).toBe(true);
});

for (const engine of ['chromium', 'firefox', ...(process.env.PLAYWRIGHT_EDGE_EXECUTABLE ? ['edge'] : [])]) for (const kind of ['focus', 'native', 'library', 'window', 'window-container', 'shadow', 'legacy']) {
  test(`${engine}: 사이트 ${kind} 모달 위에서 요청·댓글을 실제 키보드로 입력한다`, async ({ browser }) => {
    const other = engine === 'firefox'
      ? await firefox.launch({ executablePath: firefox.executablePath() })
      : engine === 'edge' ? await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EDGE_EXECUTABLE }) : null;
    const base = 'http://127.0.0.1:8286';
    const t = await startTestApp({ PUBLIC_URL: base, ALLOWED_HOSTS: '127.0.0.1:8286,localhost:80' });
    const library = await build({ stdin: { contents: "import { createFocusTrap } from 'focus-trap';createFocusTrap('#trap').activate();", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
    const stage = `http://127.0.0.1:8288/${kind}`;
    const owner = await installManager(t);
    const { site, token } = await createSite(t, owner.headers, '모달 검수', stage);
    const script = `<script defer src="${base}/w.js" data-gp-preview="${site.preview.id}"></script>`;
    const fixtureServer = createServer((req, res) => {
      const js = req.url === '/focus-trap.js';
      res.writeHead(200, { 'content-type': js ? 'application/javascript' : 'text/html; charset=utf-8' });
      res.end(js ? library.outputFiles[0]!.text : fixture(script));
    });
    await new Promise<void>(resolve => fixtureServer.listen(8288, '127.0.0.1', resolve));
    const context = await newTestContext(other ?? browser, { viewport: { width: 1366, height: 768 } });
    try {
      await t.app.listen({ port: 8286, host: '127.0.0.1' });
      await seedReviewer(t, context, site.widgetKey, token, stage, '김검수');
      const page = new ReviewBrowser(await context.newPage(), site.links[0].shareUrl);
      await page.goto();
      await expect(page.page.getByRole('complementary', { name: '검수핀 접속 방식' })).toHaveCount(0);
      await compose(page, kind === 'native' ? '#native-target' : kind === 'shadow' ? '#shadow-target' : '#target');
      const input = page.getByRole('textbox', { name: '요청 내용', exact: true });
      await input.click();
      // fill()은 포커스가 곧바로 다른 곳으로 옮겨지는 결함을 놓칠 수 있다.
      await page.keyboard.type('Please fix this title');
      await expect(input).toHaveValue('Please fix this title', { timeout: 2000 });
      await page.locator('.pop .thumb img').waitFor({ timeout: 25000 });
      await page.locator('.pop button.primary').click();
      await page.locator('.toast', { hasText: /#1/ }).waitFor();
      if (kind === 'native' || kind === 'shadow') {
        const bounds = await page.locator(kind === 'shadow' ? '#shadow-dialog' : '#first').evaluate(el => { const { x, y } = el.getBoundingClientRect(); return { x, y }; });
        const [stored] = await t.sql`select screenshot_key from requests where no=1`;
        await mkdir('test-results/modals', { recursive: true });
        await copyFile(join(t.dir, stored!.screenshot_key), `test-results/modals/${engine}-capture.webp`);
        await page.screenshot({ path: `test-results/modals/${engine}-screen.png` });
        const pixel = await sharp(join(t.dir, stored!.screenshot_key)).extract({ left: Math.round(bounds.x + 10), top: Math.round(bounds.y + 10), width: 1, height: 1 }).removeAlpha().raw().toBuffer();
        expect(pixel[1]! - pixel[0]!, '모달 배경이 캡처의 실제 화면 위치에 있어야 한다').toBeGreaterThan(50);
        const backdrop = await sharp(join(t.dir, stored!.screenshot_key)).extract({ left: 100, top: 250, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
        expect(backdrop[0], '모달 뒤 반투명 배경도 저장돼야 한다').toBeLessThan(245);
        expect(backdrop[0]).toBeGreaterThan(210);
      }
      await page.locator('.marker').click();
      await page.locator('.compose textarea').click();
      await page.keyboard.type('A second thought');
      await expect(page.locator('.compose textarea')).toHaveValue('A second thought');
      await page.keyboard.press('Enter');
      await expect(page.locator('.thread')).toContainText('A second thought');
      if (kind === 'native') {
        await test.step('같은 태스크에서 모달을 닫았다 다시 열어도 위젯을 누를 수 있다', async () => {
          await page.evaluate(() => { const dialog = document.querySelector<HTMLDialogElement>('#first')!; dialog.close(); dialog.showModal(); });
          await page.locator('.compose textarea').click({ timeout: 3000 });
        });
        await test.step('Esc는 위젯 대화만 닫고 사이트 모달은 유지한다', async () => {
          await page.locator('.compose textarea').click();
          await page.keyboard.press('Escape');
          await expect(page.locator('.tpop')).toHaveCount(0);
          await expect(page.locator('#first')).toBeVisible();
        });
        await test.step('DOM 순서와 반대로 열린 두 번째 모달에서 초안을 유지한다', async () => {
          await page.locator('.marker').click();
          await page.locator('.compose textarea').click();
          await page.keyboard.type('Unsent draft');
          await page.evaluate(() => document.querySelector<HTMLDialogElement>('#second')!.showModal());
          await expect(page.locator('#second gp-widget')).toHaveCount(1);
          await expect(page.locator('.compose textarea')).toHaveValue('Unsent draft');
          await page.locator('.compose textarea').click();
          await page.keyboard.press('End');
          await page.keyboard.type(' preserved');
          await expect(page.locator('.compose textarea')).toHaveValue('Unsent draft preserved');
          await page.evaluate(() => document.querySelector<HTMLDialogElement>('#second')!.close());
          await expect(page.locator('#first gp-widget')).toHaveCount(1);
          await expect(page.locator('.compose textarea')).toHaveValue('Unsent draft preserved');
        });
        await test.step('모달이 삭제돼도 위젯을 되살리고 다시 열린 모달에서 요청을 남긴다', async () => {
          await page.evaluate(() => document.querySelector('#first')!.remove());
          await expect(page.locator('html > gp-widget')).toHaveCount(1);
          await page.locator('.compose textarea').click();
          await page.keyboard.press('Enter');
          await expect(page.locator('.thread')).toContainText('Unsent draft preserved');
          await page.locator('.tpop').getByRole('button', { name: '닫기', exact: true }).click();
          await page.locator('#outside').fill('사이트 입력도 정상');
          await expect(page.locator('#outside')).toHaveValue('사이트 입력도 정상');
          await page.evaluate(() => document.querySelector<HTMLDialogElement>('#second')!.showModal());
          await compose(page, '#second h2');
          await page.getByRole('textbox', { name: '요청 내용', exact: true }).click();
          await page.keyboard.type('Another modal');
          await page.locator('.pop .thumb img').waitFor({ timeout: 25000 });
          await page.locator('.pop button.primary').click();
          await page.locator('.toast', { hasText: /#2/ }).waitFor();
          await expect(page.locator('#second')).toBeVisible();
          await page.locator('#second > input').click();
          await page.keyboard.press('Escape');
          await expect(page.locator('#second')).not.toBeVisible();
          await expect(page.locator('html > gp-widget')).toHaveCount(1);
        });
      }
      if (kind === 'library' || kind.startsWith('window')) {
        await page.locator('.tpop').getByRole('button', { name: '닫기', exact: true }).click();
        await page.locator('#inside').click();
        await page.keyboard.type('Site input still works');
        await expect(page.locator('#inside')).toHaveValue('Site input still works');
        await page.locator('#outside').click();
        await expect(page.locator(kind === 'window-container' ? '#trap' : '#inside')).toBeFocused();
      }
      if (kind === 'shadow') {
        const [saved] = await t.sql`select selector from requests where no=1`;
        expect(saved!.selector).toContain(' >>> #shadow-target');
        await page.evaluate(() => document.querySelector('x-modal')!.shadowRoot!.querySelector('dialog')!.close());
        await expect(page.locator('html > gp-widget')).toHaveCount(1);
        await page.evaluate(() => document.querySelector('x-modal')!.shadowRoot!.querySelector('dialog')!.showModal());
        await page.locator('.compose textarea').click();
        await page.keyboard.type('Reopened shadow modal');
        await expect(page.locator('.compose textarea')).toHaveValue('Reopened shadow modal');
      }
      const [row] = await t.sql`select count(*)::int as n from requests`;
      expect(row!.n).toBe(kind === 'native' ? 2 : 1);
    } finally { await context.close(); await other?.close(); await t.close(); await new Promise<void>((resolve, reject) => fixtureServer.close(error => error ? reject(error) : resolve())); }
  });
}
