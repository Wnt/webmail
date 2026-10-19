// Fork (Wnt/webmail): an iPhone launch image (lib/pwa-launch.ts): the app's
// background with its icon (the same one /api/pwa-icon serves) in the middle,
// at the screen's pixel size. Only the listed screens are rendered.
import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { configManager } from '@/lib/admin/config-manager';
import { fetchBrandingAsset } from '@/lib/admin/branding-asset';
import { matchDomainBranding, parseDomainBranding, pickRequestHost } from '@/lib/admin/domain-branding';
import { LAUNCH_BACKGROUND, parseLaunchSpec } from '@/lib/pwa-launch';

/** Icon edge in CSS px (iOS's own launch icons are about this size). */
const ICON_PT = 96;
const cache = new Map<string, Blob>();

export async function GET(req: NextRequest, { params }: { params: Promise<{ spec: string }> }) {
  const parsed = parseLaunchSpec((await params).spec);
  if (!parsed) return new NextResponse('Unknown launch screen', { status: 404 });
  const { w, h, dpr, scheme } = parsed;

  await configManager.ensureLoaded();
  const overrides = matchDomainBranding(pickRequestHost(req), parseDomainBranding(configManager.get<unknown>('domainBranding', [])));
  const sources = configManager.getAllWithSources();
  const iconUrl =
    overrides.pwaIconUrl ||
    (sources.pwaIconUrl?.source !== 'default' ? (sources.pwaIconUrl?.value as string) : '') ||
    '/icon-512x512.png';

  const headers = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', Vary: 'Host, X-Forwarded-Host' };
  const key = `${w}x${h}@${dpr}|${scheme}|${iconUrl}`;
  try {
    const hit = cache.get(key);
    if (hit) return new NextResponse(hit, { headers });
    const edge = ICON_PT * dpr;
    const icon = await sharp(await fetchBrandingAsset(iconUrl, 'PWA launch icon'))
      .resize(edge, edge, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const png = await sharp({ create: { width: w * dpr, height: h * dpr, channels: 3, background: LAUNCH_BACKGROUND[scheme] } })
      .composite([{ input: icon, gravity: 'center' }])
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    const ab = new ArrayBuffer(png.byteLength);
    new Uint8Array(ab).set(png);
    const blob = new Blob([ab], { type: 'image/png' });
    cache.set(key, blob);
    return new NextResponse(blob, { headers });
  } catch (err) {
    console.error('Failed to render a PWA launch image:', err);
    return new NextResponse('Failed to render the launch image', { status: 500 });
  }
}
