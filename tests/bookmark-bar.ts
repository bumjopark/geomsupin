import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { installTestFonts } from './browser.ts';

/** Optional Linux desktop run with an isolated DISPLAY and Chromium profile. */
export class BookmarkBar {
  constructor(private readonly profile: string) {}

  async create(): Promise<BrowserContext> {
    const preferences = join(this.profile, 'Default');
    await mkdir(preferences, { recursive: true });
    await writeFile(join(preferences, 'Preferences'), JSON.stringify({
      bookmark_bar: { show_on_all_tabs: false }, browser: { check_default_browser: false }, translate: { enabled: false },
    }));
    return this.launch();
  }

  private async launch(): Promise<BrowserContext> {
    const context = await chromium.launchPersistentContext(this.profile, {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      headless: false,
      viewport: null,
      args: ['--no-sandbox', '--test-type', '--disable-features=Translate,TranslateUI', '--window-position=0,0', '--window-size=1440,1000', '--force-device-scale-factor=1'],
    });
    await installTestFonts(context);
    return context;
  }

  async install(context: BrowserContext, invite: Page, bookmark: Locator, href: string) {
    await invite.bringToFront();
    const before = await this.chromeHeight(invite);
    const name = await bookmark.textContent();
    await invite.getByRole('heading', { level: 1 }).click();
    this.xdo('key', 'ctrl+shift+b');
    await expect.poll(() => this.chromeHeight(invite)).toBeGreaterThan(before + 15);
    await bookmark.scrollIntoViewIfNeeded();
    const box = (await bookmark.boundingBox())!;
    const chrome = await this.chromeHeight(invite);
    const startX = Math.round(box.x + box.width / 2);
    const startY = Math.round(box.y + box.height / 2 + chrome);
    this.xdo('mousemove', String(startX), String(startY), 'mousedown', '1');
    try {
      for (let i = 1; i <= 20; i++) {
        this.xdo('mousemove', String(Math.round(startX + (100 - startX) * i / 20)), String(Math.round(startY + (chrome - 17 - startY) * i / 20)));
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    } finally { this.xdo('mouseup', '1'); }
    await expect.poll(async () => (await this.saved()).some(entry => entry.url === href && entry.name === name)).toBe(true);
    await context.close();
    return this.launch();
  }

  async run(page: Page) {
    await page.bringToFront();
    const chrome = await this.chromeHeight(page);
    const isEdge = await page.evaluate(() => navigator.userAgent.includes('Edg/'));
    this.xdo('mousemove', isEdge ? '260' : '100', String(chrome - 17), 'click', '1');
  }

  private async saved(): Promise<{ url: string; name: string }[]> {
    try {
      const raw = await readFile(join(this.profile, 'Default', 'Bookmarks'), 'utf8');
      return JSON.parse(raw).roots.bookmark_bar.children;
    } catch { return []; }
  }

  private chromeHeight(page: Page) {
    return page.evaluate(() => outerHeight - innerHeight);
  }

  private xdo(...args: string[]) {
    execFileSync(process.env.XDOTOOL || 'xdotool', args, { stdio: 'pipe' });
  }
}
