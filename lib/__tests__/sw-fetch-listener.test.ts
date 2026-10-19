import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

// Fork patch (Wnt/webmail): WebKit sends every request of a controlled page to
// a worker that has a fetch listener, even an empty one - a cold start of the
// iPhone Home Screen app paid a fetch event for each of its ~40 scripts,
// styles and fonts and every API call. The worker registers its empty listener
// only on Chromium, whose automatic install prompt still asks for one and which
// skips an empty listener when loading.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

function listenerTypes(userAgent: string): string[] {
  const types: string[] = [];
  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    navigator: { userAgent },
    addEventListener: (type: string) => types.push(type),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
    registration: {},
  };
  vm.runInContext(SW_SOURCE, vm.createContext({ self, URL, URLSearchParams, Response, Date, console, setTimeout, clearTimeout }));
  return types;
}

describe('service worker fetch listener', () => {
  it.each([
    ['iPhone Home Screen app / Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1'],
    ['Safari on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15'],
    ['Chrome on iOS (WebKit)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1'],
    ['Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0'],
  ])('%s: no fetch listener', (_name, ua) => {
    const types = listenerTypes(ua);
    expect(types).toContain('push');
    expect(types).toContain('notificationclick');
    expect(types).not.toContain('fetch');
  });

  it.each([
    ['Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'],
    ['Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'],
  ])('%s: the empty fetch listener for the install prompt', (_name, ua) => {
    expect(listenerTypes(ua)).toContain('fetch');
  });
});
