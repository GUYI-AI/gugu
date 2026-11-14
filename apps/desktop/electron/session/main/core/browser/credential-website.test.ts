import { describe, expect, it } from 'vitest';
import { assertCredentialWebsite, credentialWebsiteOrigin, isCredentialWebsiteOrSubdomain } from './credential-website';

describe('exact credential HTTPS website', () => {
  it('canonicalizes case and effective default port without broadening the host', () => {
    const origin = credentialWebsiteOrigin('HTTPS://Example.TEST:443/login?next=private');
    expect(origin).toBe('https://example.test');
    expect(() => assertCredentialWebsite('https://EXAMPLE.test:443/login', origin)).not.toThrow();
    expect(credentialWebsiteOrigin('https://example.test:8443/')).toBe('https://example.test:8443');
  });
  it.each(['http://example.test/', 'https://sub.example.test/', 'https://example.test.evil/',
    'https://example.test:8443/', 'https://examp1e.test/', 'https://example.test./',
    'https://user:password@example.test/', 'https://example.test\n.evil/', 'file:///private/fixture',
    'https://*.example.test/'])('rejects %s with no raw URL in the error', actual => {
    expect(() => assertCredentialWebsite(actual, 'https://example.test')).toThrow('credential_website_unavailable');
    try { assertCredentialWebsite(actual, 'https://example.test'); } catch (error) {
      expect(String(error)).not.toContain(actual);
    }
  });
  it('requires an origin rather than allowing a caller to smuggle query/path matching rules', () => {
    expect(() => assertCredentialWebsite('https://example.test/', 'https://example.test/allowed')).toThrow();
  });
  it('accepts the website and its subdomains only, over HTTPS on the default port', () => {
    expect(isCredentialWebsiteOrSubdomain('https://example.test/a', 'https://example.test')).toBe(true);
    expect(isCredentialWebsiteOrSubdomain('https://api.example.test/a', 'https://example.test')).toBe(true);
    for (const url of ['https://example.test.evil/', 'https://badexample.test/', 'http://api.example.test/', 'https://api.example.test:8443/', 'https://other.test/'])
      expect(isCredentialWebsiteOrSubdomain(url, 'https://example.test')).toBe(false);
    expect(isCredentialWebsiteOrSubdomain('https://api.example.test/', 'https://example.test:8443')).toBe(false);
  });
});

