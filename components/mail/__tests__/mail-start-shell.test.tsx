import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MailStartShell } from '../mail-start-shell';
import { launchImageLinks, parseLaunchSpec, LAUNCH_SCREENS } from '@/lib/pwa-launch';

// Fork patch (Wnt/webmail): the server's markup for a page start must be
// something WebKit paints at once (LocalFrameView::qualifiesAsVisuallyNonEmpty:
// > 200 characters, > 32x32 px of image or <svg>, or the whole HTML parsed with
// nothing loading). The old spinner with "Loading..." met none of these, so an
// iPhone showed white until the end of the HTML and its 1.8 MB of script.
describe('MailStartShell', () => {
  it.each(['message', 'list'] as const)('%s view: an <svg> larger than 32x32 px, the render-blocking end marker, one status line', (view) => {
    const html = renderToString(<MailStartShell view={view} label="Loading..." />);
    const sizes = [...html.matchAll(/<svg[^>]*width="(\d+)"[^>]*height="(\d+)"/g)].map((m) => Number(m[1]) * Number(m[2]));
    expect(Math.max(...sizes)).toBeGreaterThan(32 * 32);
    expect(html).toMatch(/<link rel="expect" href="#mm-start-shell-end" blocking="render"\/>/);
    expect(html).toContain('id="mm-start-shell-end"');
    expect(html.indexOf('id="mm-start-shell-end"')).toBeGreaterThan(html.lastIndexOf('<svg'));
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('Loading...');
    // nothing to tap or read before the app runs: the outline is inert and hidden
    expect(html).toMatch(/<div class="h-full" inert="" aria-hidden="true">/);
    expect(html).not.toMatch(/<(button|a|input)\b/);
  });
});

describe('launch images', () => {
  it('a light and a dark link per listed iPhone screen, in portrait', () => {
    const links = launchImageLinks();
    expect(links).toHaveLength(LAUNCH_SCREENS.length * 2);
    const iphone11Pro = links.filter((l) => l.media.includes('(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)'));
    expect(iphone11Pro.map((l) => l.href).sort()).toEqual(['/api/pwa-launch/375x812@3-dark.png', '/api/pwa-launch/375x812@3-light.png']);
    expect(links.every((l) => l.media.includes('(orientation: portrait)'))).toBe(true);
  });
  it('renders only the listed screens', () => {
    expect(parseLaunchSpec('402x874@3-dark.png')).toEqual({ w: 402, h: 874, dpr: 3, scheme: 'dark' });
    for (const bad of ['402x874@2-dark.png', '999x999@3-light.png', '402x874@3-blue.png', '../402x874@3-dark.png', '402x874@3-dark.png?x']) {
      expect(parseLaunchSpec(bad)).toBeNull();
    }
  });
});
