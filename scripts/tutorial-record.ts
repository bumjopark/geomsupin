// Run in an isolated 1440×810 X11 display with a disposable *_test PostgreSQL database.
// Build to a separate DIST_DIR first. Chromium and OpenSSL are required.
// --language=en chooses the English edition. --dry-run checks the workflow without replacing media.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { startDemo } from '../demo/serve.mjs';
import { installManager, startTestApp } from '../tests/helpers.ts';
import { managerCookie } from '../tests/review-browser.ts';
import { tutorialHttps } from './tutorial-https.ts';
import { translate } from '../admin/src/messages.ts';
import { widgetText, type WidgetLabel } from '../widget/locale.ts';

const root = resolve(import.meta.dirname, '..');
const display = process.env.DISPLAY;
assert(display, '촬영 전용 DISPLAY가 필요합니다.');
assert(process.env.DIST_DIR, '촬영 전용 DIST_DIR이 필요합니다.');
const dist = await realpath(resolve(root, process.env.DIST_DIR));
assert.notEqual(dist, resolve(root, 'dist'), '운영 빌드로는 촬영하지 않습니다.');
const dry = process.argv.includes('--dry-run');
const locale = process.argv.includes('--language=en') ? 'en' : 'ko';
const en = locale === 'en';
const output = resolve(root, process.env.TUTORIAL_OUTPUT_DIR || 'admin/public/tutorial');
const port = Number(process.env.TUTORIAL_PORT || 8460);
assert(Number.isInteger(port) && port > 1024 && port <= 65532);
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const width = 1440;
const height = 810;
const origin = 'https://review.example.com';
const destination = 'https://studio.example.com/';
const assetsOrigin = 'https://assets.example.com/demo-cdn';
const project = en ? 'Studio website review' : '한결 웹사이트 검수';
const requestBody = en ? 'Could we shorten the homepage headline?' : '첫 화면 제목을 한 줄로 줄여 주세요.';
const reply = en ? 'Done. The headline now fits on one line.' : '확인했어요. 제목을 한 줄로 수정했습니다.';
const a = (label: string) => translate(locale, label);
const w = (label: WidgetLabel) => widgetText(locale, label);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pace = (ms: number) => sleep(dry ? ms / 8 : ms);
const xdo = (...args: string[]) => execFileSync(process.env.XDOTOOL || 'xdotool', args, { encoding: 'utf8' }).trim();
assert.equal(xdo('getdisplaygeometry'), `${width} ${height}`);

const work = await mkdtemp(join(tmpdir(), 'geomsupin-tutorial-'));
const profile = join(work, 'browser-profile');
let browser: BrowserContext | undefined;
let demo: ReturnType<typeof startDemo> | undefined;
let https: Awaited<ReturnType<typeof tutorialHttps>> | undefined;
let t: Awaited<ReturnType<typeof startTestApp>> | undefined;
let recorder: ChildProcess | undefined;
let done: Promise<unknown[]> | undefined;
const raw = join(work, 'screen.mkv');
const cues: { start: number; text: string; chapter?: string }[] = [];
let started = 0;
let posterAt = 0;
let inviteStart = 0;
let inviteEnd = 0;
let lastMouse = { x: 1200, y: 100 };
const elapsed = () => (performance.now() - started) / 1000;

async function cue(text: string, chapter?: string) {
  const previous = cues.at(-1);
  if (previous && !dry) {
    const remaining = Math.max(3.8, previous.text.length / (en ? 14 : 7)) - elapsed() + previous.start;
    if (remaining > 0) await sleep(remaining * 1000);
  }
  const start = cues.length === 0 ? 0 : elapsed();
  cues.push({ start, text, chapter });
  console.log(`${start.toFixed(1)} ${text}`);
}

async function move(x: number, y: number, steps = 16) {
  const from = lastMouse;
  for (let i = 1; i <= steps; i++) {
    xdo('mousemove', String(Math.round(from.x + (x - from.x) * i / steps)), String(Math.round(from.y + (y - from.y) * i / steps)));
    await sleep(dry ? 3 : 15);
  }
  lastMouse = { x, y };
}

const chromeHeight = (page: Page) => page.evaluate(() => outerHeight - innerHeight);
async function point(page: Page, element: Locator, nearLeft = false) {
  await element.scrollIntoViewIfNeeded();
  const box = (await element.boundingBox())!;
  await move(Math.round(box.x + (nearLeft ? Math.min(95, box.width / 2) : box.width / 2)), Math.round(box.y + box.height / 2 + await chromeHeight(page)));
}

async function click(page: Page, element: Locator, nearLeft = false) {
  await point(page, element, nearLeft);
  xdo('click', '1');
  await pace(320);
}

async function enter(page: Page, element: Locator, value: string, initialLength = 0) {
  await click(page, element);
  if (initialLength) await page.keyboard.insertText(value.slice(0, initialLength));
  for (const character of value.slice(initialLength)) {
    await page.keyboard.insertText(character);
    await pace(48);
  }
}

async function stopRecording() {
  if (!recorder) return;
  if (recorder.exitCode === null) recorder.stdin!.write('q\n');
  const [code, signal] = await done!;
  recorder = undefined;
  assert.equal(code, 0, `녹화 종료 실패 (${String(signal)})`);
}

function timeCode(seconds: number) {
  const ms = Math.floor(seconds * 1000);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

function assTime(seconds: number) {
  return timeCode(seconds).slice(1, -1);
}

function subtitles(duration: number) {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1440\nPlayResY: 810\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Caption,Pretendard,39,&H00F7FBFA,&H00FFFFFF,&H000B211C,&H000B211C,-1,0,0,0,100,100,0,0,1,0,0,2,60,60,10,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  return header + cues.map((item, i) => `Dialogue: 0,${assTime(item.start)},${assTime(cues[i + 1]?.start ?? duration)},Caption,,0,0,0,,${item.text}`).join('\n') + '\n';
}

try {
  t = await startTestApp({ DIST_DIR: dist, PUBLIC_URL: origin, ALLOWED_HOSTS: 'review.example.com,localhost:80' });
  await t.app.listen({ host: '127.0.0.1', port });
  delete process.env.DEMO_CSP;
  demo = startDemo({ sitePort: port + 2, cdnPort: port + 3, cdnOrigin: assetsOrigin, log: false });
  const homepage = en ? { host: 'studio.example.com', html: await readFile(join(import.meta.dirname, 'tutorial-stage.en.html')) } : undefined;
  https = await tutorialHttps(work, { 'review.example.com': port, 'studio.example.com': port + 2, 'assets.example.com': port + 3 }, homepage);
  const owner = await installManager(t, en ? 'Studio team' : '디자인 팀');
  await mkdir(join(profile, 'Default'), { recursive: true });
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
    bookmark_bar: { show_on_all_tabs: false }, browser: { check_default_browser: false }, translate: { enabled: false },
  }));
  browser = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    headless: false, viewport: null, locale: en ? 'en-US' : 'ko-KR', ignoreDefaultArgs: ['--enable-automation'],
    // Trust only the key generated for these disposable recording hosts.
    args: ['--no-sandbox', '--no-proxy-server', `--ignore-certificate-errors-spki-list=${https.publicKeyPin}`, `--host-resolver-rules=${https.resolver}`, '--test-type', '--disable-features=Translate,TranslateUI', '--window-position=0,0', '--window-size=1440,810', '--force-device-scale-factor=1', `--lang=${locale}`],
  });
  const localRequests = new Set<string>();
  browser.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' || ['localhost', '127.0.0.1'].includes(url.hostname)) localRequests.add(url.origin);
  });
  await browser.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/css', body: '/* native recording fonts */' }));
  await browser.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await browser.addInitScript(({ appOrigin, locale, inviteLabel, shareLabel }) => {
    if (location.origin !== appOrigin) return;
    localStorage.setItem('geomsupin.locale', locale);
    // The synthetic share URL is sent normally, but its secret is not part of the recording.
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = `input[aria-label=${JSON.stringify(inviteLabel)}], input[aria-label=${JSON.stringify(shareLabel)}]{-webkit-text-security:disc}`;
      document.head.append(style);
    });
  }, { appOrigin: origin, locale, inviteLabel: a('초대 링크'), shareLabel: a('공유 링크') });
  await managerCookie(browser, origin, owner.cookie);
  const admin = browser.pages()[0]!;
  const adminResponse = await admin.goto(origin + '/sites');
  assert((await adminResponse?.securityDetails())?.protocol?.startsWith('TLS'));
  assert(await admin.evaluate(() => window.isSecureContext));
  await expect(admin.getByLabel(a('프로젝트 이름'))).toBeVisible();
  await expect(admin.locator('html')).toHaveAttribute('lang', locale);
  xdo('mousemove', String(lastMouse.x), String(lastMouse.y));

  started = performance.now();
  if (!dry) {
    recorder = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '24', '-video_size', `${width}x${height}`, '-draw_mouse', '1', '-i', display + '+0,0', '-c:v', 'libx264', '-threads', '4', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', raw], { stdio: ['pipe', 'ignore', 'inherit'] });
    done = once(recorder, 'close');
    await sleep(360);
  }
  await cue(en ? 'Create a review project.' : '관리 화면에서 검수 프로젝트를 만드세요.', en ? 'Connect a project' : '프로젝트 연결');
  await pace(1500);
  await enter(admin, admin.getByLabel(a('프로젝트 이름')), project);
  await click(admin, admin.getByRole('button', { name: a('만들기'), exact: true }));
  await cue(en ? 'Save the site address to connect it.' : '검수할 사이트 주소를 저장하세요.');
  const settings = admin.getByRole('region', { name: a('미리보기 연결') });
  // Start with a syntactically valid URL, then type the rest in view.
  await enter(admin, settings.getByLabel(a('미리보기 주소')), destination, 'https://s'.length);
  await pace(650);
  await click(admin, settings.getByRole('button', { name: a('저장'), exact: true }));

  await cue(en ? 'Copy the invitation link and share it with your team.' : '초대 링크를 복사해 팀원에게 보내세요.', en ? 'Share an invitation' : '초대 공유');
  const invitation = admin.getByRole('region', { name: a('초대 링크') });
  await click(admin, invitation.getByRole('button', { name: a('링크 복사'), exact: true }));
  const inviteUrl = await admin.evaluate(() => navigator.clipboard.readText());
  assert.match(inviteUrl, /^https:\/\/review\.example\.com\/r\//);
  await pace(2100);

  const guest = await browser.newPage();
  inviteStart = elapsed();
  await guest.goto(inviteUrl);
  await guest.bringToFront();
  const bookmark = guest.locator('a[data-bookmarklet]');
  await expect(bookmark).toBeVisible();
  const href = await bookmark.getAttribute('href');
  assert(href?.startsWith('javascript:'));
  await cue(en ? 'Open your invitation. Press Ctrl + Shift + B to show the bookmarks bar.' : '초대를 열고 Ctrl + Shift + B로 북마크바를 켜세요.', en ? 'Install the bookmark' : '북마크 설치');
  await pace(1600);
  const beforeBar = await chromeHeight(guest);
  xdo('key', 'ctrl+shift+b');
  const bar = await chromeHeight(guest);
  await expect.poll(() => chromeHeight(guest)).toBeGreaterThan(beforeBar + 15);
  await cue(en ? 'Drag Geomsupin onto the bookmarks bar.' : '검수핀을 브라우저 북마크바로 끌어 놓으세요.');
  // Temporarily suppress the long bookmarklet URL in Chromium's hover status text.
  await bookmark.evaluate(node => node.removeAttribute('href'));
  await point(guest, bookmark);
  await pace(650);
  await bookmark.evaluate((node, saved) => node.setAttribute('href', saved), href!);
  xdo('mousedown', '1');
  try { await move(100, Math.max(bar, await chromeHeight(guest)) - 17, 42); }
  finally { xdo('mouseup', '1'); }
  await move(250, 130, 7);
  await pace(1300);

  await cue(en ? 'Open the site and click the saved bookmark.' : '검수할 사이트에서 저장한 북마크를 누르세요.');
  const newPage = guest.waitForEvent('popup');
  await click(guest, guest.getByRole('link', { name: a('검수할 사이트 열기') }));
  const site = await newPage;
  inviteEnd = elapsed();
  await site.bringToFront();
  await expect(site).toHaveURL(destination);
  await expect(site.locator('html')).toHaveAttribute('lang', locale);
  assert(await site.evaluate(() => window.isSecureContext));
  const stageHeading = site.locator('main h1, .hero h1').first();
  await expect(stageHeading).toBeVisible();
  await pace(950);
  await move(100, await chromeHeight(site) - 17);
  xdo('click', '1');
  await move(250, 145, 7);
  const pin = site.locator('.bar button.primary');
  await expect(pin).toContainText(w('요청 남기기'));
  await pace(1250);

  await cue(en ? 'Select Leave a request, then click the spot you want to review.' : '요청 남기기를 누른 뒤 고칠 곳을 클릭하세요.', en ? 'Pin and comment' : '핀과 의견');
  await click(site, pin);
  await expect(site.locator('.shield')).toBeVisible();
  await pace(500);
  await click(site, stageHeading, true);
  const composer = site.getByRole('dialog', { name: w('요청 남기기') });
  await expect(composer).toBeVisible();
  await cue(en ? 'Add your name and feedback. The screenshot is saved with your request.' : '별명과 의견을 남기면 화면 캡처도 저장됩니다.');
  await enter(site, composer.getByRole('textbox', { name: w('내 별명') }), en ? 'Alex' : '디자인 검수');
  await enter(site, composer.getByRole('textbox', { name: w('요청 내용') }), requestBody);
  await expect(composer.locator('.thumb img')).toBeVisible({ timeout: 25_000 });
  await pace(1200);
  await click(site, composer.getByRole('button', { name: w('남기기'), exact: true }));
  const marker = site.locator('.marker', { hasText: /^1$/ });
  await expect(marker).toBeVisible();
  const thread = site.locator('.tpop');
  if (!await thread.isVisible()) await click(site, marker);
  await expect(thread).toContainText(requestBody);
  await pace(1500);

  await cue(en ? 'Open Requests to see the feedback and screenshot.' : '관리자는 요청 탭에서 의견과 캡처를 확인합니다.', en ? 'Replies and status' : '답글과 상태');
  await admin.bringToFront();
  await click(admin, admin.locator('.subnav').getByRole('link', { name: a('요청'), exact: true }));
  const row = admin.locator('table.tbl tbody tr').filter({ hasText: requestBody });
  await expect(row).toHaveCount(1);
  await pace(900);
  await click(admin, row.locator('.body-cell'));
  const detail = admin.getByRole('dialog', { name: a('요청 상세') });
  await expect(detail.locator('img.shot').first()).toBeVisible();
  await cue(en ? 'Reply to the request and mark it Resolved.' : '답글을 남기고 요청을 완료로 바꾸세요.');
  await enter(admin, detail.getByRole('textbox', { name: a('댓글'), exact: true }), reply);
  await click(admin, detail.getByRole('button', { name: a('보내기'), exact: true }));
  await expect(detail).toContainText(reply);
  await admin.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  const status = row.getByRole('combobox', { name: a('상태') });
  await click(admin, status);
  await admin.keyboard.press('Home');
  await admin.keyboard.press('ArrowDown');
  await admin.keyboard.press('ArrowDown');
  await admin.keyboard.press('Enter');
  await expect(status).toHaveValue('완료');
  await cue(en ? 'The reply and status appear on the reviewer’s page.' : '팀원 화면에도 답글과 완료 상태가 바로 보여요.');
  await site.bringToFront();
  await expect(thread).toContainText(reply);
  await expect(thread.locator('.thead .st')).toContainText(a('완료'));
  await pace(2500);
  await cue(en ? 'After navigating or refreshing, click the bookmark again.' : '페이지를 다시 열면 북마크를 한 번 더 누르세요.');
  posterAt = elapsed() + 2.15;
  await pace(6000);
  const duration = elapsed();
  await stopRecording();
  await browser.close();
  assert.deepEqual([...localRequests], [], '녹화 브라우저가 HTTP 또는 루프백 주소로 요청했습니다.');
  assert.equal(JSON.parse(await readFile(join(profile, 'Default', 'Bookmarks'), 'utf8')).roots.bookmark_bar.children[0].url, href);
  assert.equal((await t.sql`select count(*)::int as n from requests where status = '완료' and screenshot_key is not null`)[0]!.n, 1);
  assert.equal((await t.sql`select count(*)::int as n from comments where body = ${reply}`)[0]!.n, 1);
  const chapters = cues.flatMap(({ start, chapter }) => chapter ? [{ seconds: start, title: chapter }] : []);
  console.log(JSON.stringify({ duration, chapters, posterAt }));

  if (!dry) {
    await mkdir(output, { recursive: true });
    const video = join(work, 'review-guide.mp4');
    const poster = join(work, 'review-guide-poster.jpg');
    await writeFile(join(work, 'captions.ass'), subtitles(duration));
    // Hide the invitation address while its tab is active. Place captions below the browser image.
    const redactAddress = `drawbox=x=142:y=46:w=1160:h=30:color=0xf1f3f4:t=fill:enable='between(t,${Math.max(0, inviteStart - 0.3).toFixed(2)},${(inviteEnd + 0.8).toFixed(2)})'`;
    const filter = `${redactAddress},scale=1328:746,pad=1440:810:56:0:color=0x142822,setsar=1,ass=captions.ass,tpad=stop_mode=clone:stop_duration=1`;
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', raw, '-vf', filter, '-t', duration.toFixed(3), '-an', '-c:v', 'libx264', '-threads', '4', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], { cwd: work, stdio: 'inherit' });
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', posterAt.toFixed(2), '-i', raw, '-vf', 'crop=1440:694:0:116,pad=1440:810:0:58:color=0x102820', '-frames:v', '1', '-q:v', '3', poster], { stdio: 'inherit' });
    const captions = 'WEBVTT\n\n' + cues.map((item, i) => `${item.chapter ? `${item.chapter}\n` : ''}${timeCode(item.start)} --> ${timeCode(cues[i + 1]?.start ?? duration)}\n${item.text}`).join('\n\n') + '\n';
    await Promise.all([
      readFile(video).then(data => writeFile(join(output, en ? 'review-guide.en.mp4' : 'review-guide.mp4'), data)),
      readFile(poster).then(data => writeFile(join(output, en ? 'review-guide-poster.en.jpg' : 'review-guide-poster.jpg'), data)),
      writeFile(join(output, `review-guide.${locale}.vtt`), captions),
    ]);
  }
} finally {
  try { await stopRecording(); }
  finally {
    await browser?.close().catch(() => {});
    await https?.close();
    demo?.close();
    await t?.close();
    await rm(work, { recursive: true, force: true });
  }
}
