// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('@/lib/security/url-guard', () => ({ fetchPublicUrl: vi.fn() }));
import { fetchPublicUrl } from '@/lib/security/url-guard';
import { fetchBrandingAsset, localBrandingPath, MAX_REMOTE_ASSET_BYTES } from '@/lib/admin/branding-asset';

// Fork (Wnt/webmail): the public branding image routes render from these
// sources (review of perf/pwa-start r4): a remote body is read with a byte cap
// and a local path never leaves public/.
afterEach(() => vi.restoreAllMocks());

function streamed(chunks: number, size = 1024 * 1024, headers: Record<string, string> = {}) {
  let sent = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (sent === chunks) { controller.close(); return; }
      sent++;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() { cancelled = true; },
  });
  return { response: new Response(body, { headers }), sent: () => sent, cancelled: () => cancelled };
}

it('a remote body over the cap is refused while it streams, and the rest is cancelled', async () => {
  const s = streamed(64);
  vi.mocked(fetchPublicUrl).mockResolvedValue(s.response as never);
  await expect(fetchBrandingAsset('https://cdn.example.test/logo.png')).rejects.toThrow(/larger than/);
  expect(s.sent()).toBeLessThanOrEqual(MAX_REMOTE_ASSET_BYTES / (1024 * 1024) + 2);
  expect(s.cancelled()).toBe(true);
});

it('a declared length over the cap is refused before reading', async () => {
  const s = streamed(1, 16, { 'content-length': String(MAX_REMOTE_ASSET_BYTES + 1) });
  vi.mocked(fetchPublicUrl).mockResolvedValue(s.response as never);
  await expect(fetchBrandingAsset('https://cdn.example.test/logo.png')).rejects.toThrow(/larger than/);
  expect(s.cancelled(), 'the body is cancelled unread').toBe(true);
  expect(s.sent(), 'at most what the stream queued by itself').toBeLessThanOrEqual(1);
});

it('a body within the cap is read whole', async () => {
  const s = streamed(2);
  vi.mocked(fetchPublicUrl).mockResolvedValue(s.response as never);
  expect((await fetchBrandingAsset('https://cdn.example.test/logo.png')).byteLength).toBe(2 * 1024 * 1024);
});

it('a local path stays inside public/', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'branding-path-'));
  try {
    await mkdir(path.join(dir, 'public'));
    await writeFile(path.join(dir, 'outside.txt'), 'fixture outside public');
    await writeFile(path.join(dir, 'public', 'logo.png'), 'inside');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await expect(fetchBrandingAsset('/../outside.txt')).rejects.toThrow(/leaves the public directory/);
    expect(localBrandingPath('/../outside.txt')).toBeNull();
    expect((await fetchBrandingAsset('/logo.png')).toString()).toBe('inside');
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
