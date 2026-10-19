// Fork (Wnt/webmail): launch images for the iPhone Home Screen app.
//
// iOS draws a Home Screen web app's launch screen only from an
// <link rel="apple-touch-startup-image"> whose media query matches the device
// exactly (CSS size, pixel ratio, orientation); without one it shows black,
// then a white page until the page's first frame (checked in the iOS 26.3
// simulator). The images (app/api/pwa-launch/[spec]) are the app's own
// background with its icon in the middle, light and dark. iPhones only, portrait
// (the manifest's orientation).

/** [CSS width, CSS height, device pixel ratio] of each iPhone screen. */
export const LAUNCH_SCREENS: readonly (readonly [number, number, number])[] = [
  [440, 956, 3], // 16 Pro Max, 17 Pro Max
  [430, 932, 3], // 14 Pro Max, 15 Plus / Pro Max, 16 Plus
  [428, 926, 3], // 12 / 13 Pro Max, 14 Plus
  [420, 912, 3], // Air
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [414, 736, 3], // 6 / 7 / 8 Plus
  [402, 874, 3], // 16 Pro, 17, 17 Pro
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [390, 844, 3], // 12, 13, 14, 12 / 13 Pro, 16e
  [375, 812, 3], // X, XS, 11 Pro, 12 / 13 mini
  [375, 667, 2], // SE (2nd, 3rd), 6 / 7 / 8
];

export type LaunchScheme = 'light' | 'dark';

/** The app's own page background (app/globals.css --color-background). */
export const LAUNCH_BACKGROUND: Record<LaunchScheme, string> = { light: '#ffffff', dark: '#0a0a0a' };

export function launchSpec(w: number, h: number, dpr: number, scheme: LaunchScheme): string {
  return `${w}x${h}@${dpr}-${scheme}.png`;
}

/** The screen and scheme of a spec, if it is one of LAUNCH_SCREENS. */
export function parseLaunchSpec(spec: string): { w: number; h: number; dpr: number; scheme: LaunchScheme } | null {
  const m = /^(\d{3})x(\d{3})@([23])-(light|dark)\.png$/.exec(spec);
  if (!m) return null;
  const [w, h, dpr] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!LAUNCH_SCREENS.some(([a, b, c]) => a === w && b === h && c === dpr)) return null;
  return { w, h, dpr, scheme: m[4] as LaunchScheme };
}

/** The <link rel="apple-touch-startup-image"> list: light and dark for every screen. */
export function launchImageLinks(basePath = ''): { href: string; media: string }[] {
  const out: { href: string; media: string }[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    for (const [w, h, dpr] of LAUNCH_SCREENS) {
      out.push({
        href: `${basePath}/api/pwa-launch/${launchSpec(w, h, dpr, scheme)}`,
        media: `screen and (device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr})`
          + ` and (orientation: portrait) and (prefers-color-scheme: ${scheme})`,
      });
    }
  }
  return out;
}
