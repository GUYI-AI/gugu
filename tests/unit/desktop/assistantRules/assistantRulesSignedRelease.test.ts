import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assistantRulesFiles } from '@gugu/core/shared/assistantRulesFormat'
import { GUGU_APPS_REPO } from '@shared/extensions/market'
import { ASSISTANT_RULES_TRUST } from '../../../../apps/desktop/electron/assistant-rules-trust'
import { fixtureBundle, fixtureHost, installBundle, markedRules, OFFICIAL_SOURCE, signedRecord } from './fixtureApp'

// #1931 The host believes the assistant App's rules only while they are its signed release: the proof kept at install
// verifies again with a key this build trusts, and the manifest and rules folder on disk are still the signed bytes. When
// they are not, the App is not believed and the last good copy is used (else none: nothing that needs the rules proceeds).
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'assistant-rules-signed-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const MARKED = markedRules('SIGNEDMARK', '2.0.0')
const bundle = (name: string, app: Parameters<typeof fixtureBundle>[1] = {}) => fixtureBundle(join(root, 'bundles', name), app)

/** A host with the signed v2 (marked rules) installed and read once, so the last good copy is v2's. */
async function trustedHost() {
  const host = fixtureHost(join(root, 'host'), join(root, 'last-good'))
  installBundle(host.service, await bundle('v2', { version: '2.0.0', files: assistantRulesFiles(MARKED) }), 'market', OFFICIAL_SOURCE('2.0.0'))
  expect(await host.resolver.refresh()).toMatchObject({ source: 'app', appVersion: '2.0.0', rules: MARKED })
  return { host, rootDir: host.service.get('gugu-assistant').rootDir }
}

describe('edited on disk after it was installed', () => {
  const firstRulesFile = async (dir: string) => (await readdir(join(dir, 'rules'))).sort()[0]!
  for (const [label, edit, problem] of [
    ['a rules file changed', async (dir: string) => writeFile(join(dir, 'rules', await firstRulesFile(dir)), 'changed\n'), /^rules\/[^ ]+ differs from the signed release/],
    ['a file added to the rules folder', (dir: string) => writeFile(join(dir, 'rules', 'extra.md'), 'x\n'), /^rules\/extra\.md is not in the signed release/],
    ['a rules file removed', async (dir: string) => rm(join(dir, 'rules', await firstRulesFile(dir))), /^rules\/[^ ]+ is missing/],
    ['the manifest changed', async (dir: string) => {
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, name: 'Edited' }))
    }, /^manifest\.json differs from the signed release/],
  ] as const) {
    it(`${label}: the App is not believed, the last good copy is used`, async () => {
      const { host, rootDir } = await trustedHost()
      await edit(rootDir)
      expect(await host.resolver.refresh()).toMatchObject({ source: 'last-good', appVersion: '2.0.0', rules: MARKED })
      const reason = String(host.warnings.at(-1)!.detail.reason)
      expect(reason.startsWith('its files are not the signed ones (')).toBe(true)
      expect(reason.slice('its files are not the signed ones ('.length)).toMatch(problem)
    })
  }

  it('a file the trust check does not cover (outside the manifest and rules folder) is left to the install itself', async () => {
    const { host, rootDir } = await trustedHost()
    await writeFile(join(rootDir, 'index.html'), 'changed')
    expect(await host.resolver.refresh()).toMatchObject({ source: 'app', appVersion: '2.0.0' })
  })
})

describe('what the install recorded', () => {
  it('no proof (installed before releases were checked, or put back from a fork): not believed, nothing re-downloaded', async () => {
    const host = fixtureHost(join(root, 'host'), join(root, 'last-good'))
    installBundle(host.service, await bundle('v1'), 'market', OFFICIAL_SOURCE('0.0.1'), { unsigned: true })
    expect(await host.resolver.refresh()).toMatchObject({ source: 'none', rules: null })
    expect(host.warnings[0]!.detail.reason).toBe('no signed release was recorded when it was installed')
  })

  it('code not in its signed release folder of the market repository: not believed', async () => {
    const host = fixtureHost(join(root, 'host'), join(root, 'last-good'))
    const app = await bundle('v1')
    installBundle(host.service, app, 'market', signedRecord(app, { repo: GUGU_APPS_REPO, path: 'sources/gugu-assistant', commit: 'b'.repeat(40) }))
    expect(await host.resolver.refresh()).toMatchObject({ source: 'none', rules: null })
    expect(host.warnings[0]!.detail.reason).toBe('its code is at sources/gugu-assistant, not in its signed release folder releases/gugu-assistant/0.0.1')
  })

  it('a proof for another version of the App: not believed', async () => {
    const host = fixtureHost(join(root, 'host'), join(root, 'last-good'))
    const v1 = await bundle('v1')
    const v2 = await bundle('v2', { version: '2.0.0' })
    installBundle(host.service, v2, 'market', { ...OFFICIAL_SOURCE('2.0.0'), release: signedRecord(v1, OFFICIAL_SOURCE('0.0.1')).release })
    expect(await host.resolver.refresh()).toMatchObject({ source: 'none', rules: null })
    expect(host.warnings[0]!.detail.reason).toMatch(/^its kept release proof does not verify \(Release: untrusted release identity or signing key\)$/)
  })

  it('a proof signed with a key this build does not trust (the shipped table, its slot still empty): not believed', async () => {
    const host = fixtureHost(join(root, 'host'), join(root, 'last-good'), ASSISTANT_RULES_TRUST)
    installBundle(host.service, await bundle('v1'), 'market', OFFICIAL_SOURCE('0.0.1'))
    expect(await host.resolver.refresh()).toMatchObject({ source: 'none', rules: null })
    expect(host.warnings[0]!.detail.reason).toMatch(/kept release proof does not verify \(Release: untrusted release identity or signing key\)/)
  })
})
