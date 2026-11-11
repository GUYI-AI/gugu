import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILT_IN_ASSISTANT_RULES } from '@gugu/core/shared/assistantProductRules/builtIn'
import { assistantRulesFiles } from '@gugu/core/shared/assistantRulesFormat'
import { GUGU_APPS_REPO_FORMER_NAME } from '@shared/extensions/market'
import { assistantRulesLastGoodStore } from '../../../../apps/desktop/electron/assistant-rules-last-good'
import { assistantRules, createAssistantRulesResolver, installAssistantRulesResolver } from '../../../../apps/desktop/electron/assistant-rules-resolver'
import { assistantRulesDistrust, type AssistantRulesProvider } from '../../../../apps/desktop/electron/assistant-rules-trust'
import { fixtureBundle, fixtureHost, installBundle, markedRules, OFFICIAL_SOURCE } from './fixtureApp'

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
      expect(await host.resolver.refresh()).toMatchObject({ source: 'built-in' })
      await host.resolver.refresh()
      expect(host.warnings).toHaveLength(1)
      expect(host.warnings[0]!.detail.reason).toMatch(reason)
    }
  })

  it('ignores an App with another id even from the official source, and a switched-on fork', async () => {
    const host = fixtureHost(root, lastGoodDir())
    installBundle(host.service, await bundle('other', { id: 'not-the-assistant' }), 'market', OFFICIAL_SOURCE('0.0.1'))
    expect(await host.resolver.refresh()).toMatchObject({ source: 'built-in' })
    const provider = (overrides: Partial<AssistantRulesProvider>): AssistantRulesProvider => ({
      manifest: { id: 'gugu-assistant', version: '0.0.1', contributes: { assistantRules: 'rules' } as never }, rootDir: root, manifestDigest: 'x',
      origin: 'market', marketSource: OFFICIAL_SOURCE('0.0.1'), activeVariant: 'upstream', enabled: true, ...overrides,
    })
    expect(await assistantRulesDistrust(provider({}))).toBeNull()
    expect(await assistantRulesDistrust(provider({ manifest: { id: 'other', version: '1', contributes: {} as never } }))).toMatch(/not gugu-assistant/)
    expect(await assistantRulesDistrust(provider({ activeVariant: 'mine' }))).toMatch(/fork "mine" is in use/)
    // One more condition (a release signature, #1931) is one more entry: the callers stay as they are.
    expect(await assistantRulesDistrust(provider({}), [async () => 'the signature does not verify'])).toBe('the signature does not verify')
  })

  it('takes the trusted App\'s rules over the kept copy and the built-in copy, from either name of the market repository', async () => {
    for (const repo of [OFFICIAL_SOURCE('0.0.1').repo, GUGU_APPS_REPO_FORMER_NAME]) {
      const host = fixtureHost(join(root, repo), join(root, repo, 'last-good'))
      await assistantRulesLastGoodStore(() => join(root, repo, 'last-good')).write({ rules: BUILT_IN_ASSISTANT_RULES, appVersion: '0.0.0' })
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
      expect(resolved.rules).toEqual(BUILT_IN_ASSISTANT_RULES)
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

  it('is not used when it no longer validates: logged once, then the built-in copy', async () => {
    const store = assistantRulesLastGoodStore(lastGoodDir)
    await store.write({ rules: MARKED, appVersion: '2.0.0' })
    const file = join(lastGoodDir(), '2.0.0', 'first-task.md')
    await writeFile(file, `${await readFile(file, 'utf8')}{{memoryIndex}}\n`)
    const host = fixtureHost(root, lastGoodDir())
    expect(await host.resolver.refresh()).toMatchObject({ source: 'built-in' })
    await host.resolver.refresh()
    expect(host.warnings).toHaveLength(1)
    expect(String(host.warnings[0]!.detail.error)).toMatch(/first-task\.md/)
  })

  it('keeps one folder, named by the rules version', async () => {
    const store = assistantRulesLastGoodStore(lastGoodDir)
    await store.write({ rules: BUILT_IN_ASSISTANT_RULES, appVersion: '0.0.1' })
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
    // The installed copy's folder changed underneath without a new version: not read again, so not noticed.
    await writeFile(join(host.service.get('gugu-assistant').rootDir, 'rules', 'notes.md'), 'x\n')
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
    expect(before.rules).toEqual(BUILT_IN_ASSISTANT_RULES)
    expect(Object.isFrozen(before) && Object.isFrozen(before.rules) && Object.isFrozen(before.rules.texts)).toBe(true)
    expect(await host.resolver.current()).toBe(after)
  })
})

describe('the installed record keeps where in the market an App\'s code was', () => {
  it('from a market install on, until the App is installed from elsewhere or uninstalled', async () => {
    const { service } = fixtureHost(root, lastGoodDir())
    const app = await bundle('v1')
    installBundle(service, app, 'market', OFFICIAL_SOURCE('0.0.1'))
    expect(service.marketSource('gugu-assistant')).toEqual(OFFICIAL_SOURCE('0.0.1'))
    installBundle(service, app, 'folder')
    expect(service.marketSource('gugu-assistant')).toBeNull()
    installBundle(service, app, 'market', OFFICIAL_SOURCE('0.0.1'))
    service.uninstall('gugu-assistant')
    installBundle(service, app, 'market')
    expect(service.marketSource('gugu-assistant')).toBeNull()
  })
})

describe('the process resolver', () => {
  it('is the built-in copy until main installs one', async () => {
    expect(await assistantRules().current()).toMatchObject({ source: 'built-in', appVersion: null })
    const resolver = createAssistantRulesResolver({ provider: () => null, lastGood: assistantRulesLastGoodStore(lastGoodDir), warn: () => {} })
    installAssistantRulesResolver(resolver)
    expect(assistantRules()).toBe(resolver)
  })
})
