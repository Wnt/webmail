import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { configManager } from '@/lib/admin/config-manager';
import { fetchBrandingAsset } from '@/lib/admin/branding-asset';
import { brandingSourceRevision, cachedImage, imageErrorStatus, SOURCE_PIXEL_LIMIT } from '@/lib/admin/generated-image-cache';
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
} from '@/lib/admin/domain-branding';

/**
 * Variant → target output size + admin config key.
 * Matches the sizes declared in app/manifest.ts so the rendered PNG fits
 * the slot the manifest tells the browser about.
 */
const VARIANTS = {
  mobile: { width: 540, height: 720, configKey: 'pwaScreenshotMobileUrl' as const },
  desktop: { width: 1280, height: 720, configKey: 'pwaScreenshotDesktopUrl' as const },
} as const;

type Variant = keyof typeof VARIANTS;

// Renders are shared, bounded and expire (lib/admin/generated-image-cache.ts);
// the key carries the source URL and its revision, so a re-upload renders again.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ variant: string }> },
) {
  const { variant: variantParam } = await params;
  if (!(variantParam in VARIANTS)) {
    return new NextResponse('Invalid variant. Allowed: mobile, desktop', { status: 400 });
  }
  const { width, height, configKey } = VARIANTS[variantParam as Variant];

  await configManager.ensureLoaded();
  const host = pickRequestHost(req);
  const domainOverrides = matchDomainBranding(
    host,
    parseDomainBranding(configManager.get<unknown>('domainBranding', [])),
  );
  const sources = configManager.getAllWithSources();
  const sourceEntry = sources[configKey];
  const screenshotUrl =
    domainOverrides[configKey] ||
    (sourceEntry?.source !== 'default' ? (sourceEntry?.value as string | undefined) : undefined);
  if (!screenshotUrl) {
    return new NextResponse('No PWA screenshot configured', { status: 404 });
  }

  const pngHeaders = {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
    Vary: 'Host, X-Forwarded-Host',
  };
  const cacheKey = `pwa-screenshot|${variantParam}|${screenshotUrl}|${await brandingSourceRevision(screenshotUrl)}`;

  try {
    const blob = await cachedImage(cacheKey, async () => {
      const sourceBuffer = await fetchBrandingAsset(screenshotUrl, 'PWA screenshot');
      // 'cover' fills the target box without letterboxing - screenshots benefit
      // more from cropping than from a transparent frame around them. Users get
      // a hint about the recommended aspect ratio in the admin UI.
      const resized = await sharp(sourceBuffer, { limitInputPixels: SOURCE_PIXEL_LIMIT })
        .resize(width, height, { fit: 'cover', position: 'center' })
        .png()
        .toBuffer();
      const ab = new ArrayBuffer(resized.byteLength);
      new Uint8Array(ab).set(resized);
      return new Blob([ab], { type: 'image/png' });
    });
    return new NextResponse(blob, { headers: pngHeaders });
  } catch (err) {
    console.error('Failed to generate PWA screenshot:', err);
    return new NextResponse('Failed to generate screenshot', { status: imageErrorStatus(err) });
  }
}
