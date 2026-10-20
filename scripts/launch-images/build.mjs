// Fork (Wnt/webmail): the iPhone launch images (lib/pwa-launch.ts), rendered
// once and shipped as static files: the app's page background with the app
// icon (public/icon-512x512.png) in the middle, light and dark, per screen.
// Re-run after changing the icon or the screen list:
//   node scripts/launch-images/build.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Keep in sync with LAUNCH_SCREENS / LAUNCH_BACKGROUND in lib/pwa-launch.ts (a unit test checks the files).
const SCREENS = [[440, 956, 3], [430, 932, 3], [428, 926, 3], [420, 912, 3], [414, 896, 3], [414, 896, 2],
  [414, 736, 3], [402, 874, 3], [393, 852, 3], [390, 844, 3], [375, 812, 3], [375, 667, 2]];
const BACKGROUND = { light: "#ffffff", dark: "#0a0a0a" };
const ICON_PT = 96;

const out = path.join(root, "public", "branding", "launch");
mkdirSync(out, { recursive: true });
const source = path.join(root, "public", "icon-512x512.png");
for (const [w, h, dpr] of SCREENS) {
  const edge = ICON_PT * dpr;
  const icon = await sharp(source).resize(edge, edge, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  for (const [scheme, background] of Object.entries(BACKGROUND)) {
    const png = await sharp({ create: { width: w * dpr, height: h * dpr, channels: 3, background } })
      .composite([{ input: icon, gravity: "center" }])
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    writeFileSync(path.join(out, `${w}x${h}@${dpr}-${scheme}.png`), png);
  }
}
console.log(`wrote ${SCREENS.length * 2} launch images to ${path.relative(root, out)}`);
