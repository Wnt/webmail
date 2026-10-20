import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

// Fork (Wnt/webmail), review swipe-preload r3 R3-E / r4 R4-C: a swipe
// neighbour pane's body frame (lib/peek-frame-size.ts, used by
// components/email/swipe-peek.tsx) must settle in a real engine, also for a
// body that sizes itself by the frame: viewport units make it grow with the
// frame, and a height media query whose width changes the fit-to-width scale
// makes it cycle. An ordinary body is sized to its content. The frame is in
// an inert, clipped parent with the reading pane's sandbox and no script, as
// in the app; every request is answered locally.

let bundle = '';
test.beforeAll(async () => {
  const out = await build({
    stdin: {
      contents: `export { sizePeekFrame } from './lib/peek-frame-size';\nexport { fitEmailBodyWidth } from './lib/email-fit-width';`,
      resolveDir: path.resolve(__dirname, '../..'), loader: 'ts',
    },
    bundle: true, format: 'iife', globalName: 'PeekSize', write: false, logLevel: 'silent',
  });
  bundle = out.outputFiles[0].text;
});

const BODIES = {
  ordinary: '<p>Hello from Examplepaja.</p><p>Second paragraph of an invented message.</p>',
  grows: '<div style="height:calc(100vh + 100px)"><p>Hello</p></div>',
  cycles: '<style>.probe{width:300px;height:1200px} @media (min-height:500px){.probe{width:700px;height:100px}}</style><div class="probe">Hello</div>',
};

/** Mounts one pane frame with `body`, sizes it, and returns its heights over time. */
async function size(page: Page, body: string) {
  await page.context().route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app</title><body></body>' }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://mail.example.test/en/mail/inbox');
  await page.addScriptTag({ content: bundle });
  return page.evaluate(async (body) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lib = (window as any).PeekSize;
    const pane = document.createElement('div');
    pane.setAttribute('inert', '');
    pane.style.cssText = 'width:390px;height:700px;overflow:hidden';
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.style.cssText = 'width:100%;border:0;display:block;min-height:100px';
    frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<style>html{overflow:hidden;height:auto!important}body{margin:0;overflow-x:auto;overflow-y:hidden}</style></head><body>${body}</body></html>`;
    pane.appendChild(frame);
    document.body.appendChild(pane);
    await new Promise((r) => frame.addEventListener('load', r, { once: true }));
    const doc = frame.contentDocument!;
    const heights: string[] = [];
    new MutationObserver(() => heights.push(frame.style.height)).observe(frame, { attributes: true, attributeFilter: ['style'] });
    lib.sizePeekFrame(frame, doc, { maxHeight: 1688, fit: (d: Document) => lib.fitEmailBodyWidth(d, { enabled: true }) });
    await new Promise((r) => setTimeout(r, 800));
    const settledAt = heights.length;
    await new Promise((r) => setTimeout(r, 800));
    return { changes: heights.length, lateChanges: heights.length - settledAt, final: frame.style.height,
      content: Math.ceil(doc.body.scrollHeight) };
  }, body);
}

test.describe('swipe neighbour pane: body frame height', () => {
  test('an ordinary body: sized to its content, once', async ({ page }) => {
    const r = await size(page, BODIES.ordinary);
    expect(r.lateChanges).toBe(0);
    expect(r.changes).toBeLessThanOrEqual(2);
    expect(parseInt(r.final, 10)).toBeLessThan(400);
  });

  test('a body that grows with the frame (viewport units) stops at the cap', async ({ page }) => {
    const r = await size(page, BODIES.grows);
    expect(r.lateChanges).toBe(0);
    expect(r.final).toBe('1688px');
  });

  test('a body that cycles with the frame (height media query, fit-to-width) settles at the fixed height', async ({ page }) => {
    const r = await size(page, BODIES.cycles);
    expect(r.lateChanges).toBe(0);
    expect(r.changes).toBeLessThanOrEqual(25);
    expect(r.final).toBe('1688px');
  });
});
