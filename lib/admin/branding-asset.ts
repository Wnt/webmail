/**
 * Loading of branding image sources for server-side image generation.
 *
 * A branding URL can point at three different places, and every route that
 * renders a branded image (PWA icon, PWA screenshot, OG image) has to resolve
 * all three the same way.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { getConfigDir } from '@/lib/admin/paths';
import { fetchPublicUrl, type PublicFetchResponse } from '@/lib/security/url-guard';

/** Admin-uploaded assets are served from here but stored under getConfigDir()/branding/. */
const ADMIN_BRANDING_PREFIX = '/api/admin/branding/';

const REMOTE_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
/**
 * Fork (Wnt/webmail): the most a remote branding source may send (admin
 * uploads are capped at 2 MiB). A public image route renders from it, so an
 * oversized or endless body is refused while reading, not buffered whole.
 */
export const MAX_REMOTE_ASSET_BYTES = 4 * 1024 * 1024;

/** Reads at most `max` bytes of `res`, or throws (cancelling the rest). */
async function readCapped(res: PublicFetchResponse, max: number, label: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${label} is larger than ${max} bytes`);
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} is larger than ${max} bytes`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/**
 * Fork (Wnt/webmail): the file behind a local branding URL - an admin upload
 * or a path inside public/ - or null when it would leave its directory.
 */
export function localBrandingPath(url: string): string | null {
  if (url.startsWith(ADMIN_BRANDING_PREFIX)) {
    return path.join(getConfigDir(), 'branding', path.basename(url.slice(ADMIN_BRANDING_PREFIX.length)));
  }
  const root = path.resolve(process.cwd(), 'public');
  const file = path.resolve(root, url.replace(/^\/+/, ''));
  return file.startsWith(root + path.sep) ? file : null;
}

/**
 * Remote branding URLs come from admin config, but they are still fetched by
 * this process and rendered by public routes, so they go through the
 * rebinding-safe fetch: only public addresses, every redirect hop
 * re-validated. Private-network logos should be uploaded via the admin
 * branding upload instead of linked.
 */
async function fetchRemoteAsset(url: string, label: string): Promise<Buffer> {
  let currentUrl = url;
  let res: PublicFetchResponse | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetchPublicUrl(currentUrl, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      await res.body?.cancel().catch(() => {});
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    throw new Error(`Failed to fetch ${label}: ${res?.status ?? 'too many redirects'}`);
  }
  return readCapped(res, MAX_REMOTE_ASSET_BYTES, label);
}

/**
 * Read the bytes behind a branding URL: a remote http(s) URL, an
 * admin-uploaded asset, or a path relative to public/.
 *
 * `label` only shapes the error message for remote fetch failures.
 */
export async function fetchBrandingAsset(url: string, label = 'branding asset'): Promise<Buffer> {
  // Absolute URL (http/https)
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return fetchRemoteAsset(url, label);
  }

  // An admin upload, or a path inside public/ (never outside it).
  const file = localBrandingPath(url);
  if (!file) throw new Error(`${label} path leaves the public directory`);
  return readFile(file);
}
