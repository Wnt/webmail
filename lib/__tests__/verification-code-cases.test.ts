import { describe, it, expect } from 'vitest';
import { findVerificationCode } from '@/lib/verification-code';
// Invented mails only. The same file is in webmail-gateway (test/fixtures/verification-code-cases.json), whose port
// of this detector finds the codes for the iPhone app's notifications: both must agree on every case.
import cases from './fixtures/verification-code-cases.json';

describe('findVerificationCode on the shared synthetic cases', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(findVerificationCode(c.subject, c.text)).toBe(c.code);
  });
});

// The shared body cases: what the reader shows, without hidden elements or
// prior correspondence. webmail-gateway runs the same file through its reader.
import bodyCases from './fixtures/verification-code-body-cases.json';
import { verificationCodeBodyText } from '@/lib/verification-code';

describe('the body as the reader shows it (shared body cases)', () => {
  const part = (partId: string, type: string) => ({ partId, blobId: `blob-${partId}`, size: 1, type });
  it.each(bodyCases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const type = c.html !== null ? 'text/html' : 'text/plain';
    const email = {
      htmlBody: [part('1', type)],
      textBody: [part('1', type)],
      bodyValues: { 1: { value: c.html ?? c.text ?? '', isEncodingProblem: false, isTruncated: false } },
    };
    expect(findVerificationCode(c.subject, verificationCodeBodyText(email))).toBe(c.code);
  });
});
