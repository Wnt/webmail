import { render, waitFor } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Fork (Wnt/webmail), with upstream bf64f4d4: opening a message downloads and
// decodes a winmail.dat or message/rfc822 part on its own only up to 5 MiB;
// a bigger one stays an attachment chip. Synthetic messages only.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('@/components/email/email-viewer');
const { JMAPClient } = await import('@/lib/jmap/client');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const session = {
  capabilities: {}, accounts: { a: { name: 'owner', isPersonal: true, accountCapabilities: {} } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' }, apiUrl: 'https://mail.example.test/jmap/api',
  downloadUrl: 'https://mail.example.test/download/{blobId}', uploadUrl: 'https://mail.example.test/upload',
  eventSourceUrl: 'https://mail.example.test/events',
};

const withPart = (id: string, part: { name: string; type: string; size: number; cid?: string }): Email => ({
  id, blobId: `b-${id}`, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], to: [{ name: 'Bob', email: 'bob@example.test' }],
  subject: 'Synthetic', receivedAt: '2026-01-01T00:00:00Z', preview: '', hasAttachment: true, size: part.size + 100,
  textBody: [], htmlBody: [], bodyValues: {},
  attachments: [{ partId: '2', blobId: `blob-${id}`, name: part.name, type: part.type, size: part.size, ...(part.cid ? { cid: part.cid } : {}) }],
} as unknown as Email);

async function blobReads(email: Email): Promise<number> {
  const c = new JMAPClient('https://mail.example.test', 'owner', 'p');
  c.adoptSession(session);
  const read = vi.spyOn(c, 'fetchBlobArrayBuffer').mockResolvedValue(new ArrayBuffer(0));
  // The cid: loader (review upstream-backport-bulwark r2 R2-2).
  const cidRead = vi.spyOn(c, 'fetchBlob').mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
  try {
    const view = render(<EmailViewer email={email} blobSource={{ client: c, clientAccountId: 'owner-login' }} mailboxes={mailboxes} />);
    // Let the extraction effects run (they start the download synchronously when they do).
    await waitFor(() => expect(view.container.textContent).toContain('Synthetic'));
    await new Promise((r) => setTimeout(r, 20));
    view.unmount();
    return read.mock.calls.length + cidRead.mock.calls.length;
  } finally {
    read.mockRestore();
    cidRead.mockRestore();
    c.disconnect();
  }
}

const MiB = 1024 * 1024;

it('decodes a small winmail.dat and message/rfc822 part on open', async () => {
  expect(await blobReads(withPart('tnef-small', { name: 'winmail.dat', type: 'application/ms-tnef', size: 64 * 1024 }))).toBe(1);
  expect(await blobReads(withPart('rfc822-small', { name: 'fwd.eml', type: 'message/rfc822', size: 64 * 1024 }))).toBe(1);
});

it('leaves a winmail.dat or message/rfc822 part over 5 MiB as an attachment', async () => {
  expect(await blobReads(withPart('tnef-big', { name: 'winmail.dat', type: 'application/ms-tnef', size: 6 * MiB }))).toBe(0);
  expect(await blobReads(withPart('rfc822-big', { name: 'fwd.eml', type: 'message/rfc822', size: 6 * MiB }))).toBe(0);
});

it('does not fetch a winmail.dat or message/rfc822 part for a Content-ID, but does an inline picture', async () => {
  expect(await blobReads(withPart('tnef-cid', { name: 'winmail.dat', type: 'application/ms-tnef', size: 6 * MiB, cid: '<w@example.test>' }))).toBe(0);
  expect(await blobReads(withPart('rfc822-cid', { name: 'fwd.eml', type: 'message/rfc822', size: 6 * MiB, cid: '<m@example.test>' }))).toBe(0);
  expect(await blobReads(withPart('img-cid', { name: 'logo.png', type: 'image/png', size: 2048, cid: '<logo@example.test>' }))).toBeGreaterThan(0);
});
