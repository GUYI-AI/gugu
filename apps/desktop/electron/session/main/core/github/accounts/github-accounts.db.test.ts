import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GITHUB_PROVIDER_ID,
  moveGitHubTokensIntoVault,
  toGitHubAccount,
  upsertGitHubAccount,
} from './github-accounts';

describe('github account helpers', () => {
  let fixture: RegistryFixture;

  beforeEach(async () => {
    fixture = await openRegistryFixture('empty');
  });

  afterEach(() => {
    fixture?.close();
  });

  async function upsert(login: string, providerAccountId: string, host = 'github.com') {
    return upsertGitHubAccount(fixture.registry, {
      accessToken: `gho_${login}`,
      credentialSource: 'emdash_oauth',
      providerAccount: {
        providerId: 'github',
        providerAccountId,
        host,
        login,
        avatarUrl: `https://avatars.githubusercontent.com/u/${providerAccountId}`,
      },
    }, fixture.vault);
  }

  it('stores identity metadata in the row and the token behind the credentialRef', async () => {
    const { account, status } = await upsert('monalisa', '42');

    expect(status).toBe('created');
    expect(account).toMatchObject({
      id: 'github.com:42',
      providerAccountId: '42',
      host: 'github.com',
      login: 'monalisa',
      avatarUrl: 'https://avatars.githubusercontent.com/u/42',
      credentialSource: 'emdash_oauth',
    });
    await expect(fixture.registry.resolveSecret(GITHUB_PROVIDER_ID, 'github.com:42')).resolves.toBe(
      'gho_monalisa'
    );
  });

  it('keeps the token in the password vault, one credential per account', async () => {
    await upsert('monalisa', '42');
    await upsert('mona', '42');

    const row = await fixture.registry.getAccount(GITHUB_PROVIDER_ID, 'github.com:42');
    expect(row?.credentialRef).toBe('vault:cred-1');
    expect([...fixture.vault.saved]).toEqual([
      ['cred-1', { origin: 'https://github.com', name: 'GitHub', account: 'mona' }],
    ]);
  });

  it('moves tokens the app store kept into the vault, leaving gh accounts, ids and the default alone', async () => {
    const legacy = (accountId: string, credentialSource: string, secret?: string) =>
      fixture.registry.upsertAccount({
        providerId: GITHUB_PROVIDER_ID,
        accountId,
        credentialRef: `github-account-token:${accountId}`,
        ...(secret ? { secret } : {}),
        meta: { providerAccountId: accountId.split(':')[1], host: 'github.com', login: accountId, avatarUrl: '', credentialSource },
      });
    await legacy('github.com:7', 'device_flow', 'gho_old');
    await legacy('github.com:8', 'cli');
    await legacy('github.com:9', 'device_flow');
    await fixture.registry.setDefaultAccount(GITHUB_PROVIDER_ID, 'github.com:7');

    await expect(moveGitHubTokensIntoVault(fixture.registry, fixture.vault)).resolves.toBe(1);

    const rows = await fixture.registry.listAccounts(GITHUB_PROVIDER_ID);
    expect(rows.map((row) => [row.accountId, row.credentialRef])).toEqual(
      expect.arrayContaining([
        ['github.com:7', 'vault:cred-1'],
        ['github.com:8', 'github-account-token:github.com:8'],
        ['github.com:9', 'github-account-token:github.com:9'],
      ])
    );
    await expect(fixture.registry.resolveSecret(GITHUB_PROVIDER_ID, 'github.com:7')).resolves.toBe('gho_old');
    expect(fixture.secretStore.secrets.has('github-account-token:github.com:7')).toBe(false);
    await expect(fixture.registry.getDefaultAccountId(GITHUB_PROVIDER_ID)).resolves.toBe('github.com:7');
    // A second run finds nothing left to move.
    await expect(moveGitHubTokensIntoVault(fixture.registry, fixture.vault)).resolves.toBe(0);
  });

  it('updates an existing account instead of duplicating it', async () => {
    await upsert('monalisa', '42');
    const { account, status } = await upsert('mona', '42');

    expect(status).toBe('updated');
    expect(account).toMatchObject({ id: 'github.com:42', login: 'mona' });
    await expect(fixture.registry.listAccounts(GITHUB_PROVIDER_ID)).resolves.toHaveLength(1);
    await expect(fixture.registry.resolveSecret(GITHUB_PROVIDER_ID, 'github.com:42')).resolves.toBe(
      'gho_mona'
    );
  });

  it('normalizes www.github.com account hosts to github.com', async () => {
    const { account } = await upsert('monalisa', '42', 'www.github.com');

    expect(account.id).toBe('github.com:42');
    expect(account.host).toBe('github.com');
  });

  it('keeps accounts with the same provider account id on different hosts separate', async () => {
    const dotCom = await upsert('monalisa', '42', 'github.com');
    const enterprise = await upsert('enterprise-monalisa', '42', 'ghe.example.com');

    expect(dotCom.account.id).toBe('github.com:42');
    expect(enterprise.account.id).toBe('ghe.example.com:42');
    await expect(fixture.registry.listAccounts(GITHUB_PROVIDER_ID)).resolves.toHaveLength(2);
  });

  it('maps generic rows back to the flat GitHub shape', async () => {
    await upsert('monalisa', '42');

    const [row] = await fixture.registry.listAccounts(GITHUB_PROVIDER_ID);
    expect(toGitHubAccount(row)).toEqual({
      id: 'github.com:42',
      providerAccountId: '42',
      host: 'github.com',
      login: 'monalisa',
      avatarUrl: 'https://avatars.githubusercontent.com/u/42',
      credentialSource: 'emdash_oauth',
      connectedAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  it('falls back to the account id convention when meta is missing', () => {
    expect(
      toGitHubAccount({
        providerId: 'github',
        accountId: 'ghe.example.com:42',
        credentialRef: 'ref',
        isDefault: false,
        meta: null,
        createdAt: 1,
        updatedAt: 2,
      })
    ).toEqual({
      id: 'ghe.example.com:42',
      providerAccountId: '42',
      host: 'ghe.example.com',
      login: '',
      avatarUrl: '',
      credentialSource: 'secure_storage',
      connectedAt: 1,
      updatedAt: 2,
    });
  });
});
