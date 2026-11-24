import type { BrowserContext, Frame, FrameLocator, Page } from '@playwright/test';
import { HOST, openReviewer, type TestApp } from './helpers.ts';

export async function openReviewPreview(page: Page) {
  const button = page.getByRole('button', { name: '브라우저에서 미리보기', exact: true });
  const iframe = page.locator('iframe[title="검수 사이트 미리보기"]');
  await button.or(iframe).first().waitFor();
  if (await button.isVisible()) await button.click();
}

/** 브라우저 입력과 네트워크는 실제 탭을 쓰고, 위젯 조회는 초대에 포함된 스테이징 프레임에서 한다. */
export class ReviewBrowser {
  readonly view: FrameLocator;
  readonly keyboard: Page['keyboard'];
  readonly mouse: Page['mouse'];

  constructor(readonly page: Page, readonly invite: string) {
    this.view = page.frameLocator('iframe[title="검수 사이트 미리보기"]');
    this.keyboard = page.keyboard;
    this.mouse = page.mouse;
  }

  locator(...args: Parameters<FrameLocator['locator']>) { return this.view.locator(...args); }
  getByRole(...args: Parameters<FrameLocator['getByRole']>) { return this.view.getByRole(...args); }
  getByText(...args: Parameters<FrameLocator['getByText']>) { return this.view.getByText(...args); }
  getByPlaceholder(...args: Parameters<FrameLocator['getByPlaceholder']>) { return this.view.getByPlaceholder(...args); }
  context() { return this.page.context(); }
  route(...args: Parameters<Page['route']>) { return this.page.route(...args); }
  unroute(...args: Parameters<Page['unroute']>) { return this.page.unroute(...args); }
  screenshot(...args: Parameters<Page['screenshot']>) { return this.page.screenshot(...args); }
  waitForTimeout(ms: number) { return this.page.waitForTimeout(ms); }
  setViewportSize(size: { width: number; height: number }) { return this.page.setViewportSize(size); }

  private frame() {
    const frame = this.page.frames().find(f => f.parentFrame() === this.page.mainFrame());
    if (!frame) throw new Error('미리보기 iframe이 열리지 않았습니다');
    return frame;
  }

  async ready() {
    await openReviewPreview(this.page);
    await this.locator('.bar button.primary').waitFor({ timeout: 15_000 });
    await this.page.getByText('핀 연결됨', { exact: true }).waitFor();
  }
  async goto(stageUrl?: string) {
    if (this.page.url() !== this.invite) {
      await this.page.goto(this.invite);
      await this.ready();
    }
    if (stageUrl && this.url() !== stageUrl) {
      const frame = this.frame();
      await Promise.all([frame.waitForURL(stageUrl), frame.evaluate(url => { location.href = url; }, stageUrl)]);
      await this.ready();
    }
  }
  async reload() { await this.page.reload(); await this.ready(); }
  url() { return this.frame().url(); }
  waitForURL(url: string | RegExp) { return this.frame().waitForURL(url); }
  goBack() { return this.frame().evaluate(() => history.back()); }
  get evaluate(): Frame['evaluate'] {
    const frame = this.frame();
    return frame.evaluate.bind(frame);
  }
}

export async function seedReviewer(t: TestApp, context: BrowserContext, key: string, token: string, stage: string, name: string, pid: string = crypto.randomUUID()) {
  const origin = new URL(stage).origin;
  const result = await openReviewer(t, { ...HOST, origin, 'x-gp-key': key }, token, { name, pid });
  if (result.statusCode !== 200) throw new Error(result.body);
  await context.addInitScript(({ origin, pid }) => {
    if (window.top !== window || location.origin !== origin) return;
    try { sessionStorage.setItem('gp:guide:pid', pid); } catch { /* 테스트에서 저장소를 제한할 수 있다. */ }
  }, { origin: t.ctx.config.publicOrigin, pid });
  return result.json().session as string;
}

export async function managerCookie(context: BrowserContext, origin: string, cookie: string) {
  const split = cookie.indexOf('=');
  await context.addCookies([{ url: origin, name: cookie.slice(0, split), value: cookie.slice(split + 1) }]);
}
