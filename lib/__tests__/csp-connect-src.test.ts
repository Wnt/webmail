// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildConnectSrc, httpOrigin } from '@/lib/security/csp-connect-src';

const base = { isDev: false, allowCustomJmapEndpoint: false, pluginsEnabled: false };

describe('buildConnectSrc (fork privacy hardening)', () => {
  it('names only self and the configured origins', () => {
    expect(buildConnectSrc({
      ...base,
      urls: ['https://mail.madekivi.fi', 'https://mail.madekivi.fi/relay', '', undefined, 'not a url'],
    })).toBe(`'self' https://mail.madekivi.fi`);
  });

  it('never allows every https origin by default', () => {
    expect(buildConnectSrc({ ...base, urls: [] })).toBe(`'self'`);
  });

  it('keeps https: when users may pick their own JMAP server or plugins run', () => {
    expect(buildConnectSrc({ ...base, allowCustomJmapEndpoint: true, urls: [] })).toBe(`'self' https:`);
    expect(buildConnectSrc({ ...base, pluginsEnabled: true, urls: [] })).toBe(`'self' https:`);
  });

  it('adds valid CSP_CONNECT_SRC_EXTRA origins only', () => {
    expect(buildConnectSrc({ ...base, urls: [], extra: ' https://jmap.example:8443/x  javascript:alert(1) *' }))
      .toBe(`'self' https://jmap.example:8443`);
  });

  it('stays permissive in development', () => {
    expect(buildConnectSrc({ ...base, isDev: true, urls: [] })).toBe(`'self' http: https: ws: wss:`);
  });

  it('extracts http(s) origins only', () => {
    expect(httpOrigin('https://a.example/relay/')).toBe('https://a.example');
    expect(httpOrigin('wss://a.example')).toBeNull();
    expect(httpOrigin('data:text/plain,x')).toBeNull();
  });
});
