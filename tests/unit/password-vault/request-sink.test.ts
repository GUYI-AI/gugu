import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import type { VaultDependencies, VaultKeyProtector } from '../../../apps/desktop/electron/password-vault/contracts'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'
import type { CredentialRequest } from '../../../apps/desktop/electron/password-vault/request-sink'

/**
 * App API 60 / the GitHub connector on the vault: an App's or the connector's choice is the vault's grant (one credential per
 * user and website, on this device only), and the value only ever goes into one header of one request the vault sends.
 */
const owner = randomUUID(), person = {}
const roots: string[] = [], vaults: LocalPasswordVault[] = []
afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const APP = 'app:gugu/github-pr', CODE = 'a'.repeat(64), OTHER_CODE = 'b'.repeat(64), CONNECTOR = 'host:connector:github'
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-request-')); roots.push(root)
  const wrappingKey = randomBytes(32)
  const keys: VaultKeyProtector = {
    verifyPerson: vi.fn(async () => undefined),
    wrap: vi.fn(async (key, binding) => JSON.stringify(seal(wrappingKey, key, binding))),
    unwrap: vi.fn(async (wrapped, binding) => unseal(wrappingKey, JSON.parse(wrapped), binding)),
  }
  const http = vi.fn(async (_url: URL, _init: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } }))
  const published: { kind: string; value?: { grants: { subject: string }[] } }[] = []
  const dependencies: VaultDependencies = { root: join(root, 'v1'), accountId: owner, installationBinding: randomUUID(),
    assertLocalPerson: context => { if (context !== person) throw new Error('forged principal') },
    assertPrivateStorageReady: async () => undefined,
    acquireFeatureGuard: async () => ({ status: 'ready' as const, signal: new AbortController().signal, assertCurrent() {} }),
    invalidate: async () => undefined, keys, http: http as unknown as typeof fetch,
    sync: { publish: async change => { published.push(change as never) } } }
  const vault = new LocalPasswordVault(dependencies); vaults.push(vault)
  const save = (account: string, token: string, origin = 'https://github.com') => vault.save(person, randomUUID(), { origin, account, password: token })
  return { root, vault, http, published, save }
}
const request = (overrides: Partial<CredentialRequest> = {}): CredentialRequest => ({
  method: 'GET', url: 'https://api.github.com/repos/GUYI-AI/gugu/pulls/1', hosts: ['api.github.com'], header: 'Authorization', format: 'Bearer {value}', value: 'password', ...overrides,
})
async function filesUnder(root: string): Promise<Buffer[]> {
  const items = await readdir(root, { withFileTypes: true })
  return (await Promise.all(items.map(item => item.isDirectory() ? filesUnder(join(root, item.name)) : readFile(join(root, item.name)).then(value => [value])))).flat()
}

describe('choosing: the grant, one per user and website', () => {
  it('assigning another credential takes the grant off the first in the same write; null takes it away', async () => {
    const { vault, save } = await fixture()
    const daily = await save('monalisa', 'tok-daily'), review = await save('reviewer', 'tok-review')
    await vault.assignSiteGrant(person, APP, 'github.com', daily.reference, CODE)
    let items = await vault.list(person)
    expect(items.find(item => item.reference.id === daily.reference.id)!.grants).toEqual([{ subject: APP, level: 'read', code: CODE }])
    await vault.assignSiteGrant(person, APP, 'github.com', items.find(item => item.reference.id === review.reference.id)!.reference, CODE)
    items = await vault.list(person)
    expect(items.flatMap(item => item.grants.filter(grant => grant.subject === APP).map(() => item.reference.id))).toEqual([review.reference.id])
    await vault.assignSiteGrant(person, APP, 'github.com', null)
    expect((await vault.list(person)).some(item => item.grants.length)).toBe(false)
  })

  it('refuses a credential for another website, an App grant that could write, and unknown users', async () => {
    const { vault, save } = await fixture()
    const other = await save('x', 'tok', 'https://gitlab.com')
    await expect(vault.assignSiteGrant(person, APP, 'github.com', other.reference, CODE)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.assignSiteGrant(person, 'agent:' + randomUUID(), 'github.com', null)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.setGrants(person, other.reference, [{ subject: APP, level: 'write' }])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('this device\'s choices never leave it: nothing is published for them, and an older client\'s schema reads what is', async () => {
    const { vault, save, published } = await fixture()
    const daily = await save('monalisa', 'tok-daily')
    const agent = 'agent:' + randomUUID()
    await vault.assignSiteGrant(person, CONNECTOR, 'github.com', daily.reference)
    await vault.assignSiteGrant(person, APP, 'github.com', (await vault.list(person))[0]!.reference, CODE)
    const before = published.length
    await vault.setGrants(person, (await vault.list(person))[0]!.reference, [...(await vault.list(person))[0]!.grants, { subject: agent, level: 'read' }])
    // The one publish carries the Agent grant alone: an older client's strict grant schema (agent/project only) reads it.
    const olderGrant = z.strictObject({ subject: z.string().regex(/^(?:agent|project):[0-9a-f-]{36}$/i), level: z.enum(['read', 'write']) })
    const sent = published.slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.value!.grants.map(grant => olderGrant.parse(grant))).toEqual([{ subject: agent, level: 'read' }])
    expect((await vault.syncExport(person))[0]!.grants).toEqual([{ subject: agent, level: 'read' }])
    // And what comes back from the cloud keeps this device's own choices.
    const [exported] = await vault.syncExport(person)
    await vault.syncApply(person, [{ id: daily.reference.id, value: { ...exported!, name: 'renamed', grants: [] } as never }])
    expect((await vault.list(person))[0]!.grants.map(grant => grant.subject).sort()).toEqual([APP, CONNECTOR].sort())
  })
})

describe('using: one header of one request, sent by the vault', () => {
  it('sends the chosen credential in the declared header only, and answers status, data and allowed headers', async () => {
    const { vault, save, http, root } = await fixture()
    const token = 'ghp_' + randomBytes(16).toString('hex')
    const saved = await save('monalisa', token)
    await vault.assignSiteGrant(person, APP, 'github.com', saved.reference, CODE)
    const answer = await vault.request(APP, 'github.com', CODE, request({ method: 'PUT', url: 'https://api.github.com/repos/GUYI-AI/gugu/pulls/1/merge', body: '{"sha":"abc"}', headers: { Accept: 'application/vnd.github+json', Cookie: 'no' } as never }))
      .catch(error => error)
    // A plain header outside the list is refused, never dropped silently.
    expect(answer).toMatchObject({ code: 'INVALID_INPUT' })
    const ok = await vault.request(APP, 'github.com', CODE, request({ method: 'PUT', url: 'https://api.github.com/repos/GUYI-AI/gugu/pulls/1/merge', body: '{"sha":"abc"}', headers: { Accept: 'application/vnd.github+json' } }))
    expect(ok).toEqual({ status: 200, data: { ok: true }, headers: { 'content-type': 'application/json' } })
    const [url, init] = http.mock.calls.at(-1)!
    expect(String(url)).toBe('https://api.github.com/repos/GUYI-AI/gugu/pulls/1/merge')
    expect(init).toMatchObject({ method: 'PUT', body: '{"sha":"abc"}', redirect: 'manual' })
    expect((init.headers as Record<string, string>).authorization).toBe('')   // wiped after the send
    expect(String(url).includes(token) || String(init.body).includes(token)).toBe(false)
    expect((await filesUnder(root)).some(bytes => bytes.includes(token))).toBe(false)
  })

  it('goes nowhere it should not: another host, a host the credential does not serve, plain http, an address', async () => {
    const { vault, save, http } = await fixture()
    await vault.assignSiteGrant(person, APP, 'github.com', (await save('monalisa', 'tok')).reference, CODE)
    for (const [url, hosts] of [['https://evil.example/x', ['evil.example']], ['https://api.github.com.evil.example/x', ['api.github.com.evil.example']],
      ['http://api.github.com/x', ['api.github.com']], ['https://140.82.112.6/x', ['140.82.112.6']], ['https://gitlab.com/api', ['gitlab.com']], ['https://api.github.com:8443/x', ['api.github.com']]] as const) {
      await expect(vault.request(APP, 'github.com', CODE, request({ url, hosts: [...hosts] }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    await expect(vault.request(APP, 'github.com', CODE, request({ url: 'https://uploads.github.com/x', hosts: ['api.github.com'] }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.request(APP, 'github.com', CODE, request({ header: 'Cookie' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(http).not.toHaveBeenCalled()
  })

  it('no choice: NOT_GRANTED; code changed since the person confirmed: GRANT_STALE; an agent subject: refused', async () => {
    const { vault, save, http } = await fixture()
    const saved = await save('monalisa', 'tok')
    await expect(vault.request(APP, 'github.com', CODE, request())).rejects.toMatchObject({ code: 'NOT_GRANTED' })
    await vault.assignSiteGrant(person, APP, 'github.com', saved.reference, CODE)
    await expect(vault.request(APP, 'github.com', OTHER_CODE, request())).rejects.toMatchObject({ code: 'GRANT_STALE' })
    await expect(vault.request('agent:' + randomUUID(), 'github.com', undefined, request())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // An App may never name a credential itself; the host's own screens may (the one the person is picking).
    await expect(vault.request(APP, 'github.com', CODE, request(), undefined, saved.reference.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.request(CONNECTOR, 'github.com', undefined, request(), undefined, saved.reference.id)).resolves.toMatchObject({ status: 200 })
    expect(http).toHaveBeenCalledOnce()
  })

  it('a value that would end the header line is refused, never sent', async () => {
    const { vault, save, http } = await fixture()
    await vault.assignSiteGrant(person, APP, 'github.com', (await save('monalisa', 'tok\r\nX-Injected: 1')).reference, CODE)
    await expect(vault.request(APP, 'github.com', CODE, request())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(http).not.toHaveBeenCalled()
  })
})
