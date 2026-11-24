import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, BrowserContextOptions } from '@playwright/test';

const font = readFileSync(new URL('./fixtures/fixture.woff2', import.meta.url));
const css = `@font-face{font-family: 'Pretendard';font-style: normal;font-weight: 100 900;font-display: swap;src: url('https://cdn.jsdelivr.net/geomsupin-fixture.woff2') format('woff2')}`;

/** 교차 출처 CSS·웹폰트 동작은 유지하면서 외부 CDN의 속도·장애에 의존하지 않는다. */
export async function installTestFonts(context: BrowserContext) {
  await context.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({
    contentType: route.request().url().endsWith('.woff2') ? 'font/woff2' : 'text/css',
    body: route.request().url().endsWith('.woff2') ? font : css,
    headers: { 'Access-Control-Allow-Origin': '*' },
  }));
}

export async function newTestContext(browser: Browser, options?: BrowserContextOptions) {
  const context = await browser.newContext(options);
  await installTestFonts(context);
  return context;
}
