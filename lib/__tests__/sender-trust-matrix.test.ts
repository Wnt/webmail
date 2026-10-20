// Fork (Wnt/webmail), review swipe-trust r3 (the reviewer's probes kept as
// regression tests): which Authentication-Results authenticate a trusted From
// (aligned DKIM / SPF MAIL FROM / DMARC for the From domain) and which do not,
// header case and order, and an order-unknown record.
import { expect, it } from 'vitest';
import { authenticationResultsValues, parseAuthenticationResults, senderTrustCheck } from '@/lib/email-headers';
import { shouldBlockExternalFor } from '@/lib/email-content-cache';

const from = [{email: 'letters@trusted-sender.test'}];
const options = { externalContentPolicy: 'ask', allowExternalContent: false,
  isSenderTrusted: () => true, trustedSendersAddressBook: false, isTrustedAddressBookSender: () => false };
const failure = 'receiver.test; dmarc=fail header.from=trusted-sender.test';
const forged = 'attacker.test; dmarc=pass header.from=trusted-sender.test';
it.each(['authentication-results', 'AUTHENTICATION-RESULTS', 'Authentication-results'])('case %s keeps receiver failure first', name => {
  const list = [{name, value: failure}, {name: 'Authentication-Results', value: forged}, {name, value: forged}];
  expect(authenticationResultsValues(list)).toEqual([failure, forged, forged]);
  expect(shouldBlockExternalFor({from, headers: list as never}, options)).toBe(true);
  expect(shouldBlockExternalFor({from, headers: {[name]: failure}}, options)).toBe(true);
});
it('ambiguous records cannot grant automatic permission', () => {
  const headers = {'Authentication-Results': forged, 'authentication-results': failure};
  expect(authenticationResultsValues(headers)).toBeNull();
  expect(shouldBlockExternalFor({from, headers}, options)).toBe(true);
});
it.each([
  'dkim=pass header.d=eviltrusted-sender.test',
  'dkim=pass header.d=trusted-sender.test.attacker.test',
  'spf=pass smtp.mailfrom=attacker.test',
  'spf=pass smtp.helo=trusted-sender.test',
  'dmarc=pass header.from=attacker.test',
  'dkim=fail header.d=trusted-sender.test; dmarc=none',
  'spf=temperror smtp.mailfrom=trusted-sender.test; dmarc=none',
])('does not authenticate %s', value => {
  expect(senderTrustCheck(parseAuthenticationResults(`receiver.test; ${value}`), from[0].email)).toBe('unauthenticated');
});
it.each([
  'dkim=pass header.d=trusted-sender.test',
  'dkim=pass header.d=mx.trusted-sender.test',
  'spf=pass smtp.mailfrom=bounce@trusted-sender.test',
  'spf=pass smtp.mailfrom=bounce@mx.trusted-sender.test',
  'dmarc=pass header.from=trusted-sender.test',
])('authenticates %s', value => {
  expect(senderTrustCheck(parseAuthenticationResults(`receiver.test; ${value}`), from[0].email)).toBe('authenticated');
});
