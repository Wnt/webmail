import { describe, expect, it } from 'vitest';
import { readReceiptRequestAddress } from '@/lib/read-receipt-request';

describe('readReceiptRequestAddress', () => {
  it('reads the address in angle brackets, case-insensitively, first value of a list', () => {
    expect(readReceiptRequestAddress({ 'Disposition-Notification-To': 'Liisa Esimerkki <liisa@example.test>' })).toBe('liisa@example.test');
    expect(readReceiptRequestAddress({ 'disposition-notification-to': ['<a@example.test>', '<b@example.test>'] })).toBe('a@example.test');
    expect(readReceiptRequestAddress({ 'DISPOSITION-NOTIFICATION-TO': '  bare@example.test ' })).toBe('bare@example.test');
  });

  it('gives null without a usable header', () => {
    expect(readReceiptRequestAddress(undefined)).toBeNull();
    expect(readReceiptRequestAddress({ Subject: 'x' })).toBeNull();
    expect(readReceiptRequestAddress({ 'Disposition-Notification-To': '' })).toBeNull();
    expect(readReceiptRequestAddress({ 'Disposition-Notification-To': '   ' })).toBeNull();
  });

  it('gives null for a header cut at 1000 characters without a whole <address>', () => {
    expect(readReceiptRequestAddress({ 'Disposition-Notification-To': `${'x'.repeat(995)} <late@example.test>` })).toBeNull();
    expect(readReceiptRequestAddress({ 'Disposition-Notification-To': `<r@example.test> ${'x'.repeat(2000)}` })).toBe('r@example.test');
  });

  it('skips an unclosed `<` before the address', () => {
    expect(readReceiptRequestAddress({ 'Disposition-Notification-To': 'x < y <z@example.test>' })).toBe('z@example.test');
  });
});
