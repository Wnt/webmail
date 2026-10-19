import { describe, expect, it } from 'vitest';
import { getWkdHash } from '@/lib/plugin-sandbox/host-api';

// The WKD local-part hash (SHA-1, z-base-32), now from Web Crypto instead of
// Node's crypto polyfill (lib/__tests__/start-bundle-imports.test.ts).
describe('getWkdHash', () => {
  it('matches the Web Key Directory example (Joe.Doe@Example.ORG)', async () => {
    await expect(getWkdHash('Joe.Doe')).resolves.toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
  });
});
