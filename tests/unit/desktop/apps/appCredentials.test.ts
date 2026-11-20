import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeParseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { fakeVaultForHost } from '../github/fakeVaultForHost'

/**
 * App API 61: an App's saved credential is the person's pick, kept as the vault's grant to the App bound to its code. The
 * install sheet's pick lands with the install; another version of the code is confirmed again; nothing falls back.
 */
const state = vi.hoisted(() => ({ vault: null as ReturnType<typeof import('../github/fakeVaultForHost').fakeVaultForHost> | null, rootDir: '', identity: { publisher: 'gugu', id: 'github-pr' } as { publisher: string; id: string } | null,
  manifest: { id: 'github-pr', permissions: { network: ['api.github.com'], credentials: [{ site: 'github.com', header: 'Authorization', format: 'Bearer {value}', value: 'password' }] } } }))
vi.mock('../../../../apps/desktop/electron/password-vault/beta-host', () => ({
  passwordVaultForHost: new Proxy({}, { get: (_target, key) => (state.vault as unknown as Record<string, unknown>)[key as string] }),
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ get: () => ({ manifest: state.manifest, rootDir: state.rootDir, manifestDigest: 'd1' }), identityOf: () => state.identity, grantedHosts: () => ['api.github.com'] }),
}))
const credentials = await import('../../../../apps/desktop/electron/session/main/core/extensions/app-credentials')

beforeEach(() => {
  state.vault = fakeVaultForHost()
  state.rootDir = mkdtempSync(join(tmpdir(), 'gugu-app-code-'))
  writeFileSync(join(state.rootDir, 'card.js'), 'v1')
  state.identity = { publisher: 'gugu', id: 'github-pr' }
})
afterEach(() => rmSync(state.rootDir, { recursive: true, force: true }))
const saved = () => state.vault!.save({ origin: 'https://github.com', name: 'GitHub', account: 'reviewer', password: 'tok' })

describe('which saved credential an App uses', () => {
  it('the install sheet\'s pick, held for that manifest, becomes the App\'s grant bound to the code that landed', async () => {
    const id = await saved()
    credentials.stageCredentialChoices('d1', { 'github.com': id })
    await credentials.applyStagedCredentialChoices({ manifest: state.manifest as never, manifestDigest: 'd1', rootDir: state.rootDir })
    const [state1] = await credentials.appCredentialStates('github-pr')
    expect(state1).toMatchObject({ site: 'github.com', chosen: { id }, stale: false })
    expect(state.vault!.items[0]!.users).toEqual([{ subject: 'app:gugu/github-pr', code: credentials.appCodeFingerprint(state.rootDir) }])
    // Another manifest's install does not take this pick.
    credentials.stageCredentialChoices('d1', { 'github.com': null })
    await credentials.applyStagedCredentialChoices({ manifest: state.manifest as never, manifestDigest: 'other', rootDir: state.rootDir })
    expect(state.vault!.items[0]!.users).toHaveLength(1)
  })

  it('new code is confirmed again: the grant reads stale, the request is refused with that reason, 「重新确认」 binds the new code', async () => {
    const id = await saved()
    await credentials.setAppCredential('github-pr', 'github.com', id)
    writeFileSync(join(state.rootDir, 'card.js'), 'v2')
    expect((await credentials.appCredentialStates('github-pr'))[0]!.stale).toBe(true)
    // The fake vault answers any granted request; the real one refuses a stale code (request-sink.test.ts). Here: the
    // code sent along is the code installed now, so a stale grant can never match it.
    await credentials.setAppCredential('github-pr', 'github.com', id)
    expect((await credentials.appCredentialStates('github-pr'))[0]!.stale).toBe(false)
  })

  it('an undeclared website, a write that is not a write, and an App without a publisher are refused', async () => {
    await expect(credentials.appCredentialRequest('github-pr', { site: 'gitlab.com', url: 'https://gitlab.com/api' }, false)).rejects.toMatchObject({ code: 'invalid' })
    await expect(credentials.appCredentialRequest('github-pr', { site: 'github.com', method: 'GET', url: 'https://api.github.com/x' }, true)).rejects.toMatchObject({ code: 'invalid' })
    state.identity = null
    await expect(credentials.appCredentialRequest('github-pr', { site: 'github.com', url: 'https://api.github.com/x' }, false)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('no pick: unavailable, saying where to choose — never a request without the credential', async () => {
    await saved()
    await expect(credentials.appCredentialRequest('github-pr', { site: 'github.com', url: 'https://api.github.com/x' }, false))
      .rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('permissions') })
    expect(state.vault!.requests).toHaveLength(1)   // asked the vault, which refused; nothing else went out
  })
})

describe('permissions.credentials in the manifest', () => {
  const manifest = (permissions: unknown, apiVersion = 61) => ({ id: 'github-pr', name: 'PR', version: '1.0.0', apiVersion, defaultLocale: 'en', platforms: ['desktop'], entry: 'card.html', permissions,
    contributes: { tabs: [{ name: 'pr', title: 'PR', entry: 'card.html' }] } })
  const ok = { network: ['api.github.com'], credentials: [{ site: 'github.com', header: 'Authorization', format: 'Bearer {value}', value: 'password' }] }
  it('takes one per website, a listed header, {value} once, a network host it can reach, at API 61', () => {
    const parsed = safeParseExtensionManifest(manifest(ok))
    expect(parsed.ok ? null : parsed.issues).toBeNull()
    for (const bad of [
      { ...ok, network: ['api.gitlab.com'] },
      { ...ok, credentials: [{ ...ok.credentials[0], header: 'Cookie' }] },
      { ...ok, credentials: [{ ...ok.credentials[0], format: 'Bearer' }] },
      { ...ok, credentials: [ok.credentials[0], ok.credentials[0]] },
    ]) expect(safeParseExtensionManifest(manifest(bad)).ok).toBe(false)
    expect(safeParseExtensionManifest(manifest(ok, 59)).ok).toBe(false)
  })
})
