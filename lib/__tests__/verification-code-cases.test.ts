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
