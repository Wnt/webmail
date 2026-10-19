import { expect, test, type Frame, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

// Fork (Wnt/webmail), audit safari-links-1 and its fix review (r1): links in a
// message body must behave in a real engine with no event listener at all -
// which is what WebKit gives the sandboxed body frame (it runs none of the
// app's listeners there). The real sanitizer output goes into an iframe with
// each renderer's sandbox and CSP; the harness installs no click handler.
//
// - A relative link must not navigate: no request, the body stays.
// - A #fragment must scroll the body, not load the page around the frame.
// - Control: a raw, unsanitized #fragment does load the app page into the
//   frame - the harness sees the bug the sanitizer prevents.
//
// Every request is answered locally (context.route); nothing is fetched.
// WebKit on a host without some of its system libraries: point
// PW_WEBKIT_EXECUTABLE at a launcher that sets LD_LIBRARY_PATH and execs
// Playwright's minibrowser-wpe/bin/MiniBrowser.

const APP_URL = 'https://mail.example.test/en/mail/inbox';
const APP_SHELL = 'APP-SHELL-PAGE';
const BODY_MARK = 'ORIGINAL-BODY';
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const RENDERERS = [
  { name: 'reading pane', sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', keepStyleTags: true },
  { name: 'conversation card', sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', keepStyleTags: false },
  { name: 'HTML/.eml attachment preview', sandbox: '', keepStyleTags: true },
] as const;
type Renderer = (typeof RENDERERS)[number];

const RELATIVE_HREFS = ['/oauth/end_session', '../document', '?view=document', 'https:/oauth/end_session'];

let bundle = '';
test.beforeAll(async () => {
  const out = await build({
    entryPoints: [path.resolve(__dirname, '../email-sanitization.ts')],
    bundle: true, format: 'iife', globalName: 'BodySanitizer', write: false, logLevel: 'silent',
  });
  bundle = out.outputFiles[0].text;
});

/** The app page with one body frame; returns the requests made after `mark()`. */
async function openBody(page: Page, renderer: Renderer, blockExternal: boolean, html: string, sanitize = true) {
  const requests: string[] = [];
  await page.context().route('**/*', (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>app</title><body>${APP_SHELL}</body>` });
  });
  await page.goto(APP_URL);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(({ renderer, blockExternal, html, sanitize }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as any).BodySanitizer;
    const body = sanitize
      ? s.sanitizeEmailBodyForIframe(html, blockExternal, { keepStyleTags: renderer.keepStyleTags }).html
      : html;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', renderer.sandbox);
    frame.style.height = '150px';
    frame.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + `<meta http-equiv="Content-Security-Policy" content="${s.emailIframeCsp(blockExternal)}">`
      + `<meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`;
    document.body.replaceChildren(frame);
  }, { renderer, blockExternal, html, sanitize });
  const frame = await waitForBodyFrame(page);
  const start = requests.length;
  return { frame, requestsSinceOpen: () => requests.slice(start) };
}

async function waitForBodyFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.mainFrame().childFrames().length).toBe(1);
  const frame = page.mainFrame().childFrames()[0];
  await expect.poll(() => frame.evaluate(() => document.body?.textContent ?? '').catch(() => '')).toContain(BODY_MARK);
  return frame;
}

/** Where the body frame is now and what it shows (Playwright reaches sandboxed frames too). */
async function bodyState(page: Page) {
  const frame = page.mainFrame().childFrames()[0];
  return frame.evaluate(() => ({ url: location.href, text: document.body?.textContent ?? '', y: window.scrollY }));
}

function linkMarkup(tag: 'a' | 'area', href: string): string {
  const link = tag === 'a'
    ? `<a href="${href}" style="display:block;height:40px">click</a>`
    : `<map name="m"><area shape="rect" coords="0,0,40,40" href="${href}"></map><img usemap="#m" width="40" height="40" src="${PIXEL}">`;
  return `${link}<p>${BODY_MARK}</p><div style="height:1500px"></div><p id="part-2">PART-TWO</p>`;
}

async function clickLink(frame: Frame, tag: 'a' | 'area') {
  if (tag === 'a') await frame.locator('a').click();
  else await frame.locator('img').click({ position: { x: 10, y: 10 } });
}

for (const renderer of RENDERERS) {
  for (const blockExternal of [true, false]) {
    for (const tag of ['a', 'area'] as const) {
      const where = `${renderer.name}, external content ${blockExternal ? 'blocked' : 'allowed'}, <${tag}>`;

      test(`${where}: a #fragment scrolls the body and loads nothing`, async ({ page }) => {
        const { frame, requestsSinceOpen } = await openBody(page, renderer, blockExternal, linkMarkup(tag, '#part-2'));
        await clickLink(frame, tag);
        await expect.poll(async () => (await bodyState(page)).y).toBeGreaterThan(0);
        const state = await bodyState(page);
        expect(state.url).toBe('about:srcdoc#part-2');
        expect(state.text).toContain(BODY_MARK);
        expect(requestsSinceOpen()).toEqual([]);
      });

      for (const href of RELATIVE_HREFS) {
        test(`${where}: ${href} does not navigate`, async ({ page }) => {
          const { frame, requestsSinceOpen } = await openBody(page, renderer, blockExternal, linkMarkup(tag, href));
          await clickLink(frame, tag);
          await page.waitForTimeout(300);
          const state = await bodyState(page);
          expect(state.url).toBe('about:srcdoc');
          expect(state.text).toContain(BODY_MARK);
          expect(requestsSinceOpen()).toEqual([]);
        });
      }
    }
  }
}

test('control: an unsanitized #fragment loads the app page into the frame', async ({ page }) => {
  const { frame, requestsSinceOpen } = await openBody(page, RENDERERS[0], true, linkMarkup('a', '#part-2'), false);
  await clickLink(frame, 'a');
  await expect.poll(() => requestsSinceOpen()).toContain(APP_URL);
  await expect.poll(async () => (await bodyState(page).catch(() => ({ text: '' }))).text).toContain(APP_SHELL);
});
