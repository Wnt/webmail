import { beforeAll, describe, it, expect, vi } from 'vitest';

// Fork patch (Wnt/webmail): a page start at a mail route restores its session
// while React hydrates (components/mail/mail-app.tsx startAuthCheckEarly);
// other routes that import the mail client (the Pro shell) keep their own
// mount-time restore.
vi.mock('@/stores/auth-store', () => {
  const state = { isAuthenticated: false, client: null, checkAuth: vi.fn(async () => {}) };
  const hook = Object.assign(() => state, { getState: () => state });
  return { useAuthStore: hook, redirectToLogin: () => {}, saveRedirectAfterLogin: () => {} };
});

let isMailRoutePath: (pathname: string, basePath?: string) => boolean;
beforeAll(async () => {
  ({ isMailRoutePath } = await import('../mail-app'));
}, 120_000);

describe('isMailRoutePath', () => {
  it.each([
    ['/', true], ['/en', true], ['/de/', true], ['/fi/mail', false], ['/mail', true], ['/mail/message/Ab12', true],
    ['/en/mail/folder/inbox', true], ['/webmail/mail/message/x', true, '/webmail'],
    ['/pro', false], ['/en/pro', false], ['/settings', false], ['/en/contacts', false], ['/en/calendar/x', false],
    ['/mailbox', false], ['/admin', false],
  ])('%s -> %s', (path, expected, base = '') => {
    expect(isMailRoutePath(path as string, base as string)).toBe(expected);
  });
});
