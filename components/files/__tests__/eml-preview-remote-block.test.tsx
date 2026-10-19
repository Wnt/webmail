import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { EmlPreview } from '../eml-preview';
import { useSettingsStore } from '@/stores/settings-store';

// The .eml attachment preview sanitized the body but never blocked remote
// content and set no CSP, so opening an attached message fired its trackers
// whatever the user's remote-content policy said.

const HTML = '<p>x</p><img src="https://t.example/pixel.gif"><img srcset="https://t.example/srcset.gif 1x">';

function srcdoc(): string {
  const { container } = render(
    <EmlPreview message={{ subject: 's', html: HTML, attachments: [] }} />,
  );
  return container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
}

afterEach(() => {
  useSettingsStore.setState({ externalContentPolicy: 'ask' });
});

describe('EmlPreview remote content', () => {
  it('blocks remote images and sets the strict CSP by default', () => {
    const doc = srcdoc();
    expect(doc).not.toMatch(/\s(src|srcset)="https:\/\/t\.example/);
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1] ?? '';
    expect(csp).toContain("img-src data: blob:;");
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('loads them when the user allows remote content everywhere', () => {
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    expect(srcdoc()).toContain('src="https://t.example/pixel.gif"');
  });
});

// Audit safari-links-1: the .eml preview shares the body link policy - no
// relative href, and a fragment written against the srcdoc document.
describe('EmlPreview links', () => {
  it.each(['ask', 'allow'] as const)('drops relative hrefs and keeps fragments local (policy %s)', (policy) => {
    useSettingsStore.setState({ externalContentPolicy: policy });
    const { container } = render(
      <EmlPreview message={{ subject: 's', html: '<a href="/oauth/end_session">r</a><a href="#part">f</a><p id="part">p</p>', attachments: [] }} />,
    );
    const doc = new DOMParser().parseFromString(container.querySelector('iframe')!.getAttribute('srcdoc')!, 'text/html');
    const [relative, fragment] = Array.from(doc.querySelectorAll('a'));
    expect(relative.hasAttribute('href')).toBe(false);
    expect(fragment.getAttribute('href')).toBe('about:srcdoc#part');
  });
});
