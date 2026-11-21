import { describe, expect, it } from 'vitest';
import { nativeListed, type ConnectionDetails } from './listed-connections';

const read = (status: unknown, plan: unknown = null) => ({ status, plan }) as ConnectionDetails;

/** What the CLI's own configuration reads as, per the credential it holds (Codex `auth.json` `auth_mode`, or an exported key). */
const chatgptLogin = read({ kind: 'authenticated', credentialKind: 'subscription', account: 'someone@example.test' }, { payer: 'subscription', plan: 'ChatGPT Plus' });
const apiKeyMode = read({ kind: 'authenticated', credentialKind: 'api-key' }, { payer: 'api-key' });

describe('the ChatGPT plan group lists the CLI configuration only for a ChatGPT sign-in', () => {
  it('lists a ChatGPT sign-in (auth_mode chatgpt), expired or not', () => {
    expect(nativeListed('codex', chatgptLogin)).toBe(true);
    expect(nativeListed('codex', read({ kind: 'unauthenticated', reason: 'expired' }))).toBe(true);
  });

  it('does not list a key (auth_mode apikey, or OPENAI_API_KEY): that connection belongs to the API group', () => {
    expect(nativeListed('codex', apiKeyMode)).toBe(false);
    expect(nativeListed('codex', read({ kind: 'unauthenticated' }, { payer: 'api-key' }))).toBe(false);
    expect(nativeListed('codex', read({ kind: 'unauthenticated' }, { payer: 'custom-endpoint', endpoint: 'acme.example.test' }))).toBe(false);
  });

  it('lists nothing while there is nothing, or nothing has been read yet', () => {
    expect(nativeListed('codex', read({ kind: 'unauthenticated' }, { payer: 'not-signed-in' }))).toBe(false);
    expect(nativeListed('codex', undefined)).toBe(false);
  });

  it('keeps a sign-in whose credential kind cannot be told, as before', () => {
    expect(nativeListed('codex', read({ kind: 'authenticated' }))).toBe(true);
  });

  it('leaves every other harness as it was: a configured key still counts there', () => {
    expect(nativeListed('claude', apiKeyMode)).toBe(true);
    expect(nativeListed('claude', chatgptLogin)).toBe(true);
    expect(nativeListed('claude', read({ kind: 'unauthenticated' }, { payer: 'not-signed-in' }))).toBe(false);
  });
});
