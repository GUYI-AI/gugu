import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { EncryptedAppSecretsStore } from '../secrets/encrypted-app-secrets-store';
import { ProviderAccountRegistry } from '../provider-accounts/provider-account-registry';
import { IntegrationCredentialStore } from './integration-credential-store';

/**
 * A token refresh or a connection check that is still on the network must not write its
 * credentials back over a change the person made meanwhile. Before this fix both paths
 * upserted unconditionally, so a disconnect during the refresh brought the account back
 * and a reauthorization during it was overwritten by the refreshed old grant.
 * Real SQLite, real registry and encrypted store; only safeStorage, the OAuth refresh and
 * the plugin's verify call are doubles (they are network).
 */

const ID = 'fixture-mcp';
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const doubles = vi.hoisted(() => ({
  store: null as unknown,
  refresh: null as null | ((credentials: unknown) => Promise<unknown>),
  verify: null as null | ((credentials: unknown) => Promise<unknown>),
}));
vi.mock('./integration-credential-store-instance', () => ({ get integrationCredentialStore() { return doubles.store; } }));
vi.mock('./platform-credentials-instance', () => ({ platformCredentials: { isPlatformProvider: () => false, custody: () => 'local' } }));
vi.mock('./mcp-oauth-flow', async original => ({
  ...(await original<typeof import('./mcp-oauth-flow')>()),
  refreshMcpCredentials: (credentials: unknown) => doubles.refresh!(credentials),
}));
vi.mock('@gugu/session-plugins/integrations', async original => {
  const actual = await original<typeof import('@gugu/session-plugins/integrations')>();
  const plugin = {
    capabilities: { auth: { methods: [{ kind: 'mcp-oauth', serverUrl: 'https://fixture.invalid/mcp' }] } },
    behavior: { auth: { verify: (_ctx: unknown, credentials: unknown) => doubles.verify!(credentials) } },
  };
  return { ...actual, integrationPluginRegistry: { ...actual.integrationPluginRegistry,
    get: (id: string) => id === ID ? plugin : actual.integrationPluginRegistry.get(id) } };
});
const { IntegrationConnectionService } = await import('./integration-connection-service');

const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`sealed:${value}`),
  decryptString: (value: Buffer) => value.toString().slice(7) };
const oauth = (access: string, expiresIn = 1) => ({ serverUrl: 'https://fixture.invalid/mcp', redirectUrl: 'http://127.0.0.1/callback',
  clientInformation: { client_id: 'fixture' }, tokens: { access_token: access, refresh_token: `${access}-refresh`, token_type: 'bearer', expires_in: expiresIn },
  obtainedAt: expiresIn === 1 ? 0 : Date.now() });
const CAPABILITIES = { requiresRepositoryUrl: false, supportsIssueContext: false };

let fixture: FixtureDb;
let store: IntegrationCredentialStore;
beforeEach(async () => {
  fixture = await openFixture('empty');
  const registry = new ProviderAccountRegistry(fixture.db, new EncryptedAppSecretsStore(fixture.db, safeStorage as never, 'darwin'));
  store = new IntegrationCredentialStore(registry, { secrets: { getSecret: async () => null, deleteSecret: async () => {} },
    kv: Object.fromEntries(['jira', 'gitlab', 'forgejo', 'plane'].map(k => [k, { get: async () => null, del: async () => {} }])) as never },
  { warn: () => {} });
  doubles.store = store;
  await store.upsertAccount(ID, { accountId: 'account', credentials: oauth('old') as never });
});
afterEach(() => fixture?.close());

const stored = async () => (await store.getAccount(ID, 'account'))?.credentials as { tokens?: { access_token?: string } } | undefined;

describe('token refresh racing a change by the person', () => {
  it('stores and returns the refreshed credentials when nothing changed meanwhile', async () => {
    doubles.refresh = async () => oauth('refreshed', 3600);
    const account = await new IntegrationConnectionService().getFreshAccount(ID, 'account');
    expect((account?.credentials as { tokens: { access_token: string } }).tokens.access_token).toBe('refreshed');
    expect((await stored())?.tokens?.access_token).toBe('refreshed');
  });

  it.each(['disconnect', 'reauthorize'] as const)('does not write the refresh back after a %s during it', async change => {
    const network = deferred<unknown>();
    doubles.refresh = () => network.promise;
    const request = new IntegrationConnectionService().getFreshAccount(ID, 'account');
    await new Promise(r => setTimeout(r, 0));
    if (change === 'disconnect') await store.delete(ID, 'account');
    else await store.upsertAccount(ID, { accountId: 'account', credentials: oauth('reauthorized', 3600) as never });
    network.resolve(oauth('refreshed-old-grant', 3600));
    const returned = await request;
    if (change === 'disconnect') {
      expect(returned).toBeNull();
      expect(await store.getAccount(ID, 'account')).toBeNull();
    } else {
      // The caller gets the person's new authorization, not the refreshed old grant.
      expect((returned?.credentials as { tokens: { access_token: string } }).tokens.access_token).toBe('reauthorized');
      expect((await stored())?.tokens?.access_token).toBe('reauthorized');
    }
  });
});

describe('connection check racing a change by the person', () => {
  beforeEach(async () => { await store.upsertAccount(ID, { accountId: 'account', credentials: oauth('current', 3600) as never }); });

  it('saves credentials the check returns when nothing changed meanwhile', async () => {
    doubles.verify = async () => ({ connected: true, credentials: oauth('verified', 3600) });
    const status = await new IntegrationConnectionService().checkConnection(ID, CAPABILITIES, 'account');
    expect(status.connected).toBe(true);
    expect((await stored())?.tokens?.access_token).toBe('verified');
  });

  it.each(['disconnect', 'reauthorize'] as const)('does not write the checked credentials back after a %s during it', async change => {
    const network = deferred<unknown>();
    doubles.verify = () => network.promise;
    const check = new IntegrationConnectionService().checkConnection(ID, CAPABILITIES, 'account');
    await new Promise(r => setTimeout(r, 0));
    if (change === 'disconnect') await store.delete(ID, 'account');
    else await store.upsertAccount(ID, { accountId: 'account', credentials: oauth('reauthorized', 3600) as never });
    network.resolve({ connected: true, credentials: oauth('checked-old-grant', 3600) });
    const status = await check;
    expect(status.connected).toBe(false);
    if (change === 'disconnect') expect(await store.getAccount(ID, 'account')).toBeNull();
    else expect((await stored())?.tokens?.access_token).toBe('reauthorized');
  });
});
