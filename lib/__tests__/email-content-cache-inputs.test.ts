import { describe, expect, it } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { cachedEmailContent, emailContentCacheKey, prepareEmailHtml, __clearEmailContentCache } from '@/lib/email-content-cache';

// Fork (Wnt/webmail), review swipe-preload r2 R2-D (the reviewer's probe): a
// sanitized body is handed out only for exactly the inputs it was made from -
// the shown parts' text, ids and media types, and whether there are
// attachments - not just the same text under the same ids.

describe('sanitized-body cache inputs', () => {
  it('the same text as text/plain parts is not given the cached HTML', () => {
    __clearEmailContentCache();
    const a = { id: 'same-id', htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [{ partId: '1', type: 'text/html' }], attachments: [],
      bodyValues: { '1': { value: '<p>Literal example</p><img src="https://tracker.example.test/pixel">' } } } as unknown as Email;
    expect(prepareEmailHtml(a, false, {})).not.toBeNull();
    const b = { ...a, htmlBody: [{ partId: '1', type: 'text/plain' }], textBody: [{ partId: '1', type: 'text/plain' }] } as unknown as Email;
    expect(prepareEmailHtml(b, false, {})).toBeNull();
    expect(cachedEmailContent(emailContentCacheKey(b, false, {}), b)).toBeUndefined();
  });

  it('a distinct text part or attachments that change the selection are part of the check', () => {
    __clearEmailContentCache();
    const a = { id: 'm', htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [{ partId: '1', type: 'text/html' }],
      bodyValues: { '1': { value: '<p>Hello</p>' } } } as unknown as Email;
    expect(prepareEmailHtml(a, false, {})).not.toBeNull();
    expect(cachedEmailContent(emailContentCacheKey(a, false, {}), a)).toBeDefined();
    const withText = { ...a, textBody: [{ partId: '2', type: 'text/plain' }], bodyValues: { '1': { value: '<p>Hello</p>' }, '2': { value: 'Hello' } } } as unknown as Email;
    expect(cachedEmailContent(emailContentCacheKey(withText, false, {}), withText)).toBeUndefined();
    const withParts = { ...a, attachments: [] } as unknown as Email;
    expect(cachedEmailContent(emailContentCacheKey(withParts, false, {}), withParts)).toBeUndefined();
  });
});
