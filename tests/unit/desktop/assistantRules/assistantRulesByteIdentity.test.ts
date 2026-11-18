import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assistantRulesFiles } from '@gugu/core/shared/assistantRulesFormat'
import { assistantRules, installAssistantRulesResolver } from '../../../../apps/desktop/electron/assistant-rules-resolver'
import { captureAssistantRenders, fingerprint, readBaseline, readPointOf, type Fingerprint, type ReadPoint } from './capture'
import { fixtureBundle, fixtureHost, installBundle, markedRules, OFFICIAL_SOURCE } from './fixtureApp'

// #1931 The product's words are the assistant App's: this repository keeps none (R7). What the host renders from them is
// held byte for byte three ways:
// - a fixture App carrying the neutral test rules (neutralRules.ts): every capture equals the digests recorded in
//   neutral-digests.json, so any change in how the host renders, wraps or writes shows here. To re-record after a change
//   the host means to make (and says why in its commit): GUGU_ASSISTANT_RULES_DIGESTS=write.
// - the last good copy kept from that App, after it is uninstalled: the same digests.
// - the product's own rules folder, given as GUGU_ASSISTANT_RULES_DIR (the assistant App's `contributes.assistantRules`
//   folder, e.g. a checkout of GUYI-AI/gugu-assistant `app/rules`): every capture equals baseline.json, the digests of
//   origin/dev 4205711b66 before the words left this repository. Skipped when not given.

const DIGESTS_URL = new URL('./neutral-digests.json', import.meta.url)

async function fingerprints(): Promise<Record<string, Fingerprint>> {
  return Object.fromEntries(Object.entries(await captureAssistantRenders()).map(([key, value]) => [key, fingerprint(value)]))
}

function differingFrom(current: Record<string, Fingerprint>, expected: Record<string, Fingerprint>): string[] {
  return Object.keys(expected).filter(key => key in current && (current[key]!.sha256 !== expected[key]!.sha256 || current[key]!.bytes !== expected[key]!.bytes))
}

function perReadPoint(keys: string[]): Partial<Record<ReadPoint, number>> {
  const counts: Partial<Record<ReadPoint, number>> = {}
  for (const key of keys) counts[readPointOf(key)] = (counts[readPointOf(key)] ?? 0) + 1
  return counts
}

/** The 68 captures by where the host reads them: 57 at the four read points, 11 that the rules never reach. */
const PER_READ_POINT = { 'session-start': 27, 'per-turn': 5, dispatch: 10, setup: 15, host: 11 }
/** In baseline.json but no longer rendered by this repository: words it exported only for the cloud's generator. */
const LEFT_WITH_THE_WORDS = ['text/contextCore', 'text/ownerProfileWritingRules', 'text/workflow']

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'assistant-rules-identity-')) })
afterEach(async () => {
  installAssistantRulesResolver(null)
  await rm(root, { recursive: true, force: true })
})

/** A trusted fixture App with these rules files, installed, and the process's resolver reading it. */
async function trustedApp(files?: Record<string, string>) {
  const host = fixtureHost(root, join(root, 'last-good'))
  installBundle(host.service, await fixtureBundle(join(root, 'bundle'), files ? { files } : {}), 'market', OFFICIAL_SOURCE('0.0.1'))
  installAssistantRulesResolver(host.resolver)
  return host
}

describe('every rendered assistant rule is byte for byte what it was, through the resolver', () => {
  it('from a trusted App carrying the neutral test rules: the recorded digests', async () => {
    const host = await trustedApp()
    expect(await assistantRules().refresh()).toMatchObject({ source: 'app', appVersion: '0.0.1' })
    const current = await fingerprints()
    if (process.env.GUGU_ASSISTANT_RULES_DIGESTS === 'write') writeFileSync(DIGESTS_URL, `${JSON.stringify(current, null, 2)}\n`)
    const recorded = JSON.parse(readFileSync(DIGESTS_URL, 'utf8')) as Record<string, Fingerprint>
    expect(Object.keys(current).sort()).toEqual(Object.keys(recorded).sort())
    expect(differingFrom(current, recorded)).toEqual([])
    expect(perReadPoint(Object.keys(current))).toEqual(PER_READ_POINT)
    expect(host.warnings).toEqual([])
  })

  it('from the last good copy kept from that App, after it is uninstalled', async () => {
    const host = await trustedApp()
    await host.resolver.refresh()
    host.service.uninstall('gugu-assistant')
    // A new process: nothing in memory, only the copy on disk.
    const next = fixtureHost(root, join(root, 'last-good'))
    installAssistantRulesResolver(next.resolver)
    expect(await assistantRules().refresh()).toMatchObject({ source: 'last-good', appVersion: '0.0.1' })
    const recorded = JSON.parse(readFileSync(DIGESTS_URL, 'utf8')) as Record<string, Fingerprint>
    expect(differingFrom(await fingerprints(), recorded)).toEqual([])
  })

  it.skipIf(!process.env.GUGU_ASSISTANT_RULES_DIR)('from the product\'s own rules folder (GUGU_ASSISTANT_RULES_DIR): as on origin/dev before the split', async () => {
    const dir = process.env.GUGU_ASSISTANT_RULES_DIR!
    const files = Object.fromEntries(await Promise.all((await readdir(dir)).map(async name => [name, await readFile(join(dir, name), 'utf8')] as const)))
    await trustedApp(files)
    expect((await assistantRules().refresh()).source).toBe('app')
    const current = await fingerprints()
    const baseline = readBaseline()
    expect(Object.keys(baseline).filter(key => !(key in current)).sort()).toEqual(LEFT_WITH_THE_WORDS)
    expect(differingFrom(current, baseline)).toEqual([])
  })

  it('captures the same strings twice (no time, randomness or machine path leaks into the comparison)', async () => {
    await trustedApp()
    expect(await captureAssistantRenders()).toEqual(await captureAssistantRenders())
  })
})

describe('the App\'s rules reach every read point', () => {
  it('changes what each read point renders, and nothing the rules do not reach', async () => {
    await trustedApp(assistantRulesFiles(markedRules('APPMARK')))
    expect((await assistantRules().refresh()).source).toBe('app')
    const recorded = JSON.parse(readFileSync(DIGESTS_URL, 'utf8')) as Record<string, Fingerprint>
    const differing = differingFrom(await fingerprints(), recorded)
    const changed = (point: ReadPoint) => differing.filter(key => readPointOf(key) === point)
    expect(changed('host')).toEqual([])
    // The captures the rules cannot change: nothing to wrap, a home with no settings file, an index already current.
    const unchanged = Object.keys(recorded).filter(key => readPointOf(key) !== 'host' && !differing.includes(key))
    expect(unchanged.sort()).toEqual(UNCHANGED_BY_RULES)
    expect({ 'session-start': changed('session-start').length, 'per-turn': changed('per-turn').length, dispatch: changed('dispatch').length, setup: changed('setup').length })
      .toEqual({ 'session-start': 27 - 2, 'per-turn': 5 - 1, dispatch: 10 - 3, setup: 15 - 1 })
  })
})

const UNCHANGED_BY_RULES = [
  'executionAction/2', // a reply carries no task context
  'executionAction/4', // { action: 'list' }: not a task
  'executionAction/5', // not an object
  'ownerProfile/index/3', // the index already lists the profile
  'profileReview/current', // the index carries the rules' own version: nothing to review
  'refresh/cloud-claude/settings', // a cloud home writes no settings file
  'refresh/computer-codex/settings', // nor does a Codex one
].sort()
