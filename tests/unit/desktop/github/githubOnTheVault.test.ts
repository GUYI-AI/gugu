import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeVaultForHost } from './fakeVaultForHost'

/**
 * The GitHub connector on the password vault: its accounts are the vault's GitHub credentials; which one the host uses is the
 * vault's grant (the connector's current one, or a project's own pick); requests go out through the vault, never a token.
 */
const vault = vi.hoisted(() => ({ current: null as ReturnType<typeof import('./fakeVaultForHost').fakeVaultForHost> | null }))
vi.mock('../../../../apps/desktop/electron/password-vault/beta-host', () => ({
  passwordVaultForHost: new Proxy({}, { get: (_target, key) => (vault.current as unknown as Record<string, unknown>)[key as string] }),
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/github/github-migration', () => ({ migrateLegacyGitHubAccounts: async () => {} }))
const { githubVaultAccountStore } = await import('../../../../apps/desktop/electron/session/main/core/github/accounts/github-vault-accounts')
const { GitHubApiAuthService } = await import('../../../../apps/desktop/electron/session/main/core/github/services/github-api-auth-service')
const { CONNECTOR_SUBJECT, projectSubject } = await import('../../../../apps/desktop/electron/session/main/core/github/github-credential')
const { vaultProblem } = await import('../../../../apps/desktop/electron/session/main/core/github/services/github-api-auth-errors')
const { VaultError } = await import('../../../../apps/desktop/electron/password-vault/contracts')
const { toSerializedError } = await import('@gugu/session-shared/result')

const PROJECT = '11111111-2222-4333-8444-555555555555'
const connect = (login: string, id: string, host = 'github.com', source = 'device_flow') => githubVaultAccountStore.upsertAccount({
  providerId: 'github', accountId: `${host}:${id}`, secret: `token-${login}`, meta: { providerAccountId: id, host, login, avatarUrl: '', credentialSource: source } })

beforeEach(() => { vault.current = fakeVaultForHost() })

describe('the GitHub accounts are the vault\'s GitHub credentials', () => {
  it('a connected token becomes a credential; the first on a website is the connector\'s, the same user again updates it', async () => {
    const first = await connect('monalisa', '42')
    const second = await connect('octocat', '84', 'github.com', 'pat')
    expect(vault.current!.items).toHaveLength(2)
    expect(first.account.isDefault).toBe(true)
    expect(second.account.isDefault).toBe(false)
    expect(vault.current!.items[0]).toMatchObject({ origin: 'https://github.com', account: 'monalisa', fields: { 'GitHub ID': '42', 'Connected by': 'device_flow' } })
    const again = await connect('monalisa', '42')
    expect(again.status).toBe('updated')
    expect(vault.current!.items).toHaveLength(2)
    expect(vault.current!.items[0]!.password).toBe('token-monalisa')
  })

  it('how it was connected is one of the known sources: free text the person typed in the vault reads as "vault"', async () => {
    const pasted = await connect('octocat', '84', 'github.com', 'pat')
    expect(pasted.account.meta).toMatchObject({ credentialSource: 'pat' })
    vault.current!.items[0]!.fields['Connected by'] = 'my laptop'
    expect((await githubVaultAccountStore.getAccount('github', pasted.account.accountId))!.meta).toMatchObject({ credentialSource: 'vault' })
  })

  it('switching the current one moves the connector\'s grant; disconnecting stops the connector and projects, the credential stays', async () => {
    const first = await connect('monalisa', '42'), second = await connect('octocat', '84')
    await githubVaultAccountStore.setDefaultAccount('github', second.account.accountId)
    expect(await githubVaultAccountStore.getDefaultAccountId('github')).toBe(second.account.accountId)
    await vault.current!.assign(projectSubject(PROJECT), 'github.com', second.account.accountId)
    await githubVaultAccountStore.removeAccount('github', second.account.accountId)
    expect(vault.current!.items.find(item => item.id === second.account.accountId)!.users).toEqual([])
    expect(vault.current!.items).toHaveLength(2)
    expect(await githubVaultAccountStore.getDefaultAccountId('github')).toBeNull()
    expect(first.account.accountId).toBeTruthy()
  })
})

describe('requests go through the vault with the chosen credential', () => {
  const auth = () => new GitHubApiAuthService(githubVaultAccountStore)

  it('a project\'s own pick, else the connector\'s, else the one being picked on screen', async () => {
    const daily = await connect('monalisa', '42'), review = await connect('reviewer', '84')
    const service = auth()
    const plain = await service.resolve('github.com', { projectId: PROJECT })
    expect(plain).toMatchObject({ success: true, data: { account: { id: daily.account.accountId } } })
    await vault.current!.assign(projectSubject(PROJECT), 'github.com', review.account.accountId)
    const picked = await service.resolve('github.com', { projectId: PROJECT })
    expect(picked).toMatchObject({ success: true, data: { account: { id: review.account.accountId } } })
    if (!picked.success) throw new Error()
    const answer = await picked.data.fetch('https://api.github.com/user', { headers: { Accept: 'application/vnd.github+json', Authorization: 'token leaked?' } })
    expect(await answer.json()).toEqual({ login: 'reviewer' })
    expect(vault.current!.requests.at(-1)).toMatchObject({ subject: projectSubject(PROJECT), site: 'github.com', request: { header: 'Authorization', hosts: ['api.github.com'] } })
    const onScreen = await service.resolve('github.com', { accountId: daily.account.accountId })
    if (!onScreen.success) throw new Error()
    await onScreen.data.fetch('https://api.github.com/user/orgs')
    expect(vault.current!.requests.at(-1)).toMatchObject({ subject: CONNECTOR_SUBJECT, credentialId: daily.account.accountId })
  })

  it('no credential: auth required; an Enterprise host uses its own credentials and API host', async () => {
    expect(await auth().resolve('github.com')).toMatchObject({ success: false, error: { type: 'auth_required' } })
    await connect('enterprise', '7', 'ghe.example.com', 'pat')
    const ghes = await auth().resolve('ghe.example.com')
    if (!ghes.success) throw new Error(JSON.stringify(ghes.error))
    await ghes.data.fetch('https://ghe.example.com/api/v3/user')
    expect(vault.current!.requests.at(-1)).toMatchObject({ site: 'ghe.example.com', request: { hosts: ['ghe.example.com'] } })
  })

  it('an unreadable vault is said, never an empty account list taken for 「not connected」', async () => {
    await connect('monalisa', '42')
    vault.current!.fail('SYSTEM_STORAGE_UNAVAILABLE')
    const result = await auth().resolve('github.com')
    expect(result).toMatchObject({ success: false, error: { type: 'token_missing', message: expect.stringContaining('keyring') } })
  })
})

describe('the vault\'s failure reaches the person as what it is', () => {
  it('a system key storage failure still reads as such after crossing a Result boundary (serialized)', () => {
    const thrown = new VaultError('SYSTEM_STORAGE_UNAVAILABLE')
    expect(vaultProblem(thrown)).toMatch(/system key storage/)
    expect(vaultProblem(toSerializedError(thrown))).toMatch(/system key storage/)
    expect(vaultProblem(toSerializedError(new Error('GitHub does not accept this token')))).toBeNull()
  })
})
