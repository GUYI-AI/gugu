import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NEUTRAL_ASSISTANT_RULES } from './neutralRules'
import { assistantRulesFiles } from '@gugu/core/shared/assistantRulesFormat'
import { GUGU_APPS_REPO_FORMER_NAME } from '@shared/extensions/market'
import { assistantRulesLastGoodStore } from '../../../../apps/desktop/electron/assistant-rules-last-good'
import { assistantRules, createAssistantRulesResolver, installAssistantRulesResolver, NO_ASSISTANT_RULES } from '../../../../apps/desktop/electron/assistant-rules-resolver'
import { assistantRulesDistrust, hearAssistantAppChanges, installedAssistantRulesProvider, type AssistantRulesProvider } from '../../../../apps/desktop/electron/assistant-rules-trust'
import { FIXTURE_TRUST, fixtureBundle, fixtureHost, installBundle, markedRules, OFFICIAL_SOURCE, signedRecord } from './fixtureApp'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'assistant-rules-resolver-')) })
afterEach(async () => {
  installAssistantRulesResolver(null)
  await rm(root, { recursive: true, force: true })
})

const lastGoodDir = () => join(root, 'last-good')
const bundle = (name: string, app: Parameters<typeof fixtureBundle>[1] = {}) => fixtureBundle(join(root, 'bundles', name), app)
const MARKED = markedRules('V2MARK', '2.0.0')

describe('whom the host believes', () => {
  it('ignores the App when it was not installed from the market, or its code is not in gugu\'s market repository', async () => {
    for (const [origin, source, reason] of [
      ['folder', undefined, /installed from folder, not the market/],
      ['market', { repo: 'someone/gugu-apps', path: 'sources/gugu-assistant', commit: 'b'.repeat(40) }, /its code is at someone\/gugu-apps/],
      ['market', undefined, /no record of where in the market its code was/],
    ] as const) {
      const host = fixtureHost(join(root, origin + (source?.repo ?? 'none')), lastGoodDir())
      installBundle(host.service, await bundle(`${origin}-${source?.repo ?? 'none'}`), origin, source)
      expect(await host.resolver.refresh()).toMatchObject({ source: 'none', rules: null })
      await host.resolver.refresh()
      expect(host.warnings).toHaveLength(1)
      expect(host.warnings[0]!.detail.reason).toMatch(reason)
    }
  })

  it('ignores an App with another id even from the official source, and a switched-on fork', async () => {
    const host = fixtureHost(root, lastGoodDir())
    installBundle(host.service, await bundle('other', { id: 'not-the-assistant' }), 'market', OFFICIAL_SOURCE('0.0.1'))
    expect(await host.resolver.refresh()).toMatchObject({ source: 'none', rules: null })
    const signed = await bundle('signed')
    const provider = (overrides: Partial<AssistantRulesProvider>): AssistantRulesProvider => ({
      manifest: { id: 'gugu-assistant', version: '0.0.1', contributes: { assistantRules: 'rules' } as never }, rootDir: signed, manifestDigest: 'x',
      origin: 'market', marketSource: signedRecord(signed, OFFICIAL_SOURCE('0.0.1')), activeVariant: 'upstream', enabled: true, ...overrides,
    })
    expect(await assistantRulesDistrust(provider({}), FIXTURE_TRUST)).toBeNull()
    expect(await assistantRulesDistrust(provider({ manifest: { id: 'other', version: '1', contributes: {} as never } }), FIXTURE_TRUST)).toMatch(/not gugu-assistant/)
    expect(await assistantRulesDistrust(provider({ activeVariant: 'mine' }), FIXTURE_TRUST)).toMatch(/fork "mine" is in use/)
    // One more condition (a release signature, #1931) is one more entry: the callers stay as they are.
    expect(await assistantRulesDistrust(provider({}), [async () => 'the signature does not verify'])).toBe('the signature does not verify')
  })

  it('takes the trusted App\'s rules over the kept copy, from either name of the market repository', async () => {
    for (const repo of [OFFICIAL_SOURCE('0.0.1').repo, GUGU_APPS_REPO_FORMER_NAME]) {
      const host = fixtureHost(join(root, repo), join(root, repo, 'last-good'))
      await assistantRulesLastGoodStore(() => join(root, repo, 'last-good')).write({ rules: NEUTRAL_ASSISTANT_RULES, appVersion: '0.0.0' })
      installBundle(host.service, await bundle(repo, { version: '2.0.0', files: assistantRulesFiles(MARKED) }), 'market', { ...OFFICIAL_SOURCE('2.0.0'), repo })
      const resolved = await host.resolver.refresh()
      expect(resolved).toMatchObject({ source: 'app', appVersion: '2.0.0' })
      expect(resolved.rules).toEqual(MARKED)
    }
  })
})

describe('the last good copy', () => {
  it('is used when a later version\'s folder is not valid — logged once, read once, never half-applied', async () => {
    const host = fixtureHost(root, lastGoodDir())
    installBundle(host.service, await bundle('v1'), 'market', OFFICIAL_SOURCE('0.0.1'))
    expect(await host.resolver.refresh()).toMatchObject({ source: 'app', appVersion: '0.0.1' })
    const broken = { ...assistantRulesFiles(MARKED), 'recovery.md': 'one line\r\n' }
    installBundle(host.service, await bundle('v2', { version: '2.0.0', files: broken }), 'market', OFFICIAL_SOURCE('2.0.0'))
    for (let turn = 0; turn < 3; turn++) {
      const resolved = await host.resolver.refresh()
      expect(resolved).toMatchObject({ source: 'last-good', appVersion: '0.0.1' })
      expect(resolved.rules).toEqual(NEUTRAL_ASSISTANT_RULES)
    }
    expect(host.warnings.map(warning => warning.message)).toEqual(['the assistant App\'s rules are not valid; they are ignored'])
    expect(String(host.warnings[0]!.detail.error)).toMatch(/recovery\.md: has a carriage return/)
  })

  it('keeps the behaviour when the App is switched off or uninstalled', async () => {
    const host = fixtureHost(root, lastGoodDir())
    installBundle(host.service, await bundle('v2', { version: '2.0.0', files: assistantRulesFiles(MARKED) }), 'market', OFFICIAL_SOURCE('2.0.0'))
    const loaded = await host.resolver.refresh()
    expect(loaded.source).toBe('app')
    host.service.setEnabled('gugu-assistant', false)
    const off = await host.resolver.refresh()
    expect(off).toMatchObject({ source: 'last-good', appVersion: '2.0.0' })
    expect(off.rules).toBe(loaded.rules)
    host.service.uninstall('gugu-assistant')
    expect((await host.resolver.refresh()).rules).toBe(loaded.rules)
    // And across a restart: the copy on disk, validated again, is the same rules.
    const next = fixtureHost(join(root, 'next'), lastGoodDir())
    const restarted = await next.resolver.refresh()
    expect(restarted).toMatchObject({ source: 'last-good', appVersion: '2.0.0' })
    expect(restarted.rules).toEqual(MARKED)
  })

  it('is not used when it no longer validates: logged once, then none', async () => {
    const store = assistantRulesLastGoodStore(lastGoodDir)
    await store.write({ rules: MARKED, appVersion: '2.0.0' })
    const file = join(lastGoodDir(), '2.0.0', 'first-task.md')
    await writeFile(file, `${await readFile(file, 'utf8')}{{memoryIndex}}\n`)
    const host = fixtureHost(root, lastGoodDir())
    expect(await host.resolver.refresh()).toMatchObject({ source: 'none', rules: null })
    await host.resolver.refresh()
    expect(host.warnings).toHaveLength(1)
    expect(String(host.warnings[0]!.detail.error)).toMatch(/first-task\.md/)
  })

  it('keeps one folder, named by the rules version', async () => {
    const store = assistantRulesLastGoodStore(lastGoodDir)
    await store.write({ rules: NEUTRAL_ASSISTANT_RULES, appVersion: '0.0.1' })
    await store.write({ rules: MARKED, appVersion: '2.0.0' })
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(lastGoodDir())).sort()).toEqual(['2.0.0', 'last-good.json'])
    expect(await store.read()).toEqual({ rules: MARKED, appVersion: '2.0.0' })
  })
})

describe('cheap to read', () => {
  it('reads an App version\'s folder once: later refreshes and every turn answer from memory', async () => {
    const host = fixtureHost(root, lastGoodDir())
    const app = await bundle('v1')
    installBundle(host.service, app, 'market', OFFICIAL_SOURCE('0.0.1'))
    const first = await host.resolver.refresh()
    // Unchanged: its folder is not read again (an edit to it is caught by the signed release instead: assistantRulesSignedRelease.test.ts).
    expect(await host.resolver.refresh()).toBe(first)
    const reads = host.providerReads()
    for (let turn = 0; turn < 20; turn++) expect(await host.resolver.current()).toBe(first)
    expect(host.providerReads()).toBe(reads)
    expect(host.warnings).toEqual([])
  })

  it('answers concurrent refreshes with one look', async () => {
    const host = fixtureHost(root, lastGoodDir())
    installBundle(host.service, await bundle('v1'), 'market', OFFICIAL_SOURCE('0.0.1'))
    const [a, b] = await Promise.all([host.resolver.refresh(), host.resolver.refresh()])
    expect(a).toBe(b)
    expect(host.providerReads()).toBe(1)
  })
})

describe('a new version swaps in between renders, never inside one', () => {
  it('replaces the snapshot whole; one taken before keeps its rules', async () => {
    const host = fixtureHost(root, lastGoodDir())
    installBundle(host.service, await bundle('v1'), 'market', OFFICIAL_SOURCE('0.0.1'))
    const before = await host.resolver.refresh()
    installBundle(host.service, await bundle('v2', { version: '2.0.0', files: assistantRulesFiles(MARKED) }), 'market', OFFICIAL_SOURCE('2.0.0'))
    const after = await host.resolver.refresh()
    expect(after).toMatchObject({ source: 'app', appVersion: '2.0.0' })
    expect(before.rules).toEqual(NEUTRAL_ASSISTANT_RULES)
    if (!before.rules) throw new Error('no rules')
    expect(Object.isFrozen(before) && Object.isFrozen(before.rules) && Object.isFrozen(before.rules.texts)).toBe(true)
    expect(await host.resolver.current()).toBe(after)
  })
})

// D2 (verify pass 1): after the person updated an untrusted copy to the signed release, its rules were used only after a
// restart — the resolver answered every read from the one snapshot of the process, which only an assistant start or setup
// replaced; nothing told it the App changed.
describe('trust is decided again when the App changes, without a restart', () => {
  /** The service tells its listeners once the change is written (a microtask); the look it starts runs on. */
  const told = () => new Promise(resolve => { setTimeout(resolve, 0) })

  it('an update from an untrusted copy to the signed release is what the next session start uses', async () => {
    const host = fixtureHost(root, lastGoodDir())
    hearAssistantAppChanges(host.service, host.resolver)
    installBundle(host.service, await bundle('old', { version: '0.1.0' }), 'market', OFFICIAL_SOURCE('0.1.0'), { unsigned: true })
    expect((await host.resolver.refresh()).source).toBe('none')
    expect(host.warnings[0]?.detail.reason).toMatch(/no signed release was recorded/)
    // The person's 更新: the market writes the signed release and its record.
    installBundle(host.service, await bundle('new', { version: '1.0.0', files: assistantRulesFiles(MARKED) }), 'market', OFFICIAL_SOURCE('1.0.0'))
    await told()
    // Every read point that answers from memory (a task agent's start, a dispatch, the windows) has the new answer.
    expect(await host.resolver.current()).toMatchObject({ source: 'app', appVersion: '1.0.0', rules: MARKED })
    expect(await assistantRulesLastGoodStore(lastGoodDir).read()).toMatchObject({ appVersion: '1.0.0' })
  })

  it('switched off, back on, removed: each decided again when it happens', async () => {
    const host = fixtureHost(root, lastGoodDir())
    hearAssistantAppChanges(host.service, host.resolver)
    installBundle(host.service, await bundle('v2', { version: '2.0.0', files: assistantRulesFiles(MARKED) }), 'market', OFFICIAL_SOURCE('2.0.0'))
    expect((await host.resolver.current()).source).toBe('app')
    host.service.setEnabled('gugu-assistant', false)
    await told()
    expect(await host.resolver.current()).toMatchObject({ source: 'last-good', appVersion: '2.0.0' })
    host.service.setEnabled('gugu-assistant', true)
    await told()
    expect((await host.resolver.current()).source).toBe('app')
    host.service.uninstall('gugu-assistant')
    await told()
    expect((await host.resolver.current()).source).toBe('last-good')
    // Another App's change is not the assistant App's.
    const reads = host.providerReads()
    installBundle(host.service, await bundle('other', { id: 'other-app' }), 'folder')
    await told()
    await host.resolver.current()
    expect(host.providerReads()).toBe(reads)
  })

  it('a look begun before the change does not answer for after it', async () => {
    const host = fixtureHost(root, lastGoodDir())
    installBundle(host.service, await bundle('old', { version: '0.1.0' }), 'market', OFFICIAL_SOURCE('0.1.0'), { unsigned: true })
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    const resolver = createAssistantRulesResolver({
      // What the look saw of the App is taken when it starts; it answers after the gate.
      provider: async () => { const seen = installedAssistantRulesProvider(host.service); await gate; return seen },
      lastGood: assistantRulesLastGoodStore(lastGoodDir), trust: FIXTURE_TRUST, warn: () => {},
    })
    const stale = resolver.refresh()
    await told()
    installBundle(host.service, await bundle('new', { version: '1.0.0' }), 'market', OFFICIAL_SOURCE('1.0.0'))
    const changed = resolver.appChanged()
    open()
    expect((await stale).source).toBe('none')
    expect(await changed).toMatchObject({ source: 'app', appVersion: '1.0.0' })
    expect(await resolver.current()).toMatchObject({ source: 'app', appVersion: '1.0.0' })
  })
})

describe('the installed record keeps where in the market an App\'s code was', () => {
  it('from a market install on, until the App is installed from elsewhere or uninstalled', async () => {
    const { service } = fixtureHost(root, lastGoodDir())
    const app = await bundle('v1')
    installBundle(service, app, 'market', OFFICIAL_SOURCE('0.0.1'))
    expect(service.marketSource('gugu-assistant')).toEqual({ ...OFFICIAL_SOURCE('0.0.1'), release: expect.objectContaining({ keyId: 'gugu-assistant-test' }) })
    installBundle(service, app, 'folder')
    expect(service.marketSource('gugu-assistant')).toBeNull()
    installBundle(service, app, 'market', OFFICIAL_SOURCE('0.0.1'))
    service.uninstall('gugu-assistant')
    installBundle(service, app, 'market')
    expect(service.marketSource('gugu-assistant')).toBeNull()
  })
})

describe('no rules anywhere (#1931: the open repository carries no words of its own)', () => {
  it('answers none, and a wait for rules ends at the refresh that finds them — once the App is in', async () => {
    const host = fixtureHost(root, lastGoodDir())
    expect(await host.resolver.refresh()).toBe(NO_ASSISTANT_RULES)
    const changes: string[] = []
    host.resolver.subscribe(answer => changes.push(answer.source))
    let arrived: unknown = null
    const waiting = host.resolver.available().then(answer => { arrived = answer; return answer })
    await host.resolver.refresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(arrived).toBeNull()
    installBundle(host.service, await bundle('v1'), 'market', OFFICIAL_SOURCE('0.0.1'))
    await host.resolver.refresh()
    expect(await waiting).toMatchObject({ source: 'app', appVersion: '0.0.1' })
    expect((await waiting).rules).toEqual(NEUTRAL_ASSISTANT_RULES)
    expect(changes).toEqual(['app'])
  })

  it('starts the kept copy from the one packaged with the release, which an installed App then overrides', async () => {
    const seed = async () => ({ rules: MARKED, appVersion: '2.0.0' })
    const resolver = (service = fixtureHost(join(root, 'h'), lastGoodDir()).service) => ({ service, resolver: createAssistantRulesResolver({
      provider: async () => (await import('../../../../apps/desktop/electron/assistant-rules-trust')).installedAssistantRulesProvider(service),
      lastGood: assistantRulesLastGoodStore(lastGoodDir), seed, trust: FIXTURE_TRUST, warn: () => {},
    }) })
    const first = resolver()
    expect(await first.resolver.refresh()).toMatchObject({ source: 'last-good', appVersion: '2.0.0' })
    // Kept: a later start finds it on disk even without the packaged copy.
    expect(await assistantRulesLastGoodStore(lastGoodDir).read()).toEqual({ rules: MARKED, appVersion: '2.0.0' })
    installBundle(first.service, await bundle('v3', { version: '3.0.0' }), 'market', OFFICIAL_SOURCE('3.0.0'))
    expect(await resolver(first.service).resolver.refresh()).toMatchObject({ source: 'app', appVersion: '3.0.0' })
  })

  it('a packaged copy that does not validate is said once and not used', async () => {
    const warnings: string[] = []
    const resolver = createAssistantRulesResolver({ provider: () => null, lastGood: assistantRulesLastGoodStore(lastGoodDir),
      seed: async () => { throw new Error('rules.json: is not JSON') }, warn: message => warnings.push(message) })
    expect(await resolver.refresh()).toBe(NO_ASSISTANT_RULES)
    expect(await resolver.refresh()).toBe(NO_ASSISTANT_RULES)
    expect(warnings).toEqual(['the assistant rules packaged with this release are not valid; they are not used'])
  })
})

describe('the process resolver', () => {
  it('has no rules until main installs one, and a wait on it is an error, never a hang', async () => {
    expect(await assistantRules().current()).toBe(NO_ASSISTANT_RULES)
    await expect(assistantRules().available()).rejects.toThrow(/no assistant rules resolver/)
    const resolver = createAssistantRulesResolver({ provider: () => null, lastGood: assistantRulesLastGoodStore(lastGoodDir), warn: () => {} })
    installAssistantRulesResolver(resolver)
    expect(assistantRules()).toBe(resolver)
  })
})
