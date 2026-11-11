import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILT_IN_ASSISTANT_RULES } from '@gugu/core/shared/assistantProductRules/builtIn'
import { assistantRulesFiles } from '@gugu/core/shared/assistantRulesFormat'
import { assistantRules, installAssistantRulesResolver } from '../../../../apps/desktop/electron/assistant-rules-resolver'
import { BASELINE_URL, captureAssistantRenders, fingerprint, readBaseline, readPointOf, type ReadPoint } from './capture'
import { fixtureBundle, fixtureHost, installBundle, markedRules, OFFICIAL_SOURCE } from './fixtureApp'

// baseline.json holds the UTF-8 byte length and SHA-256 of every capture, written from origin/dev 4205711b66's rules files
// (unchanged at this branch's base) before the product text moved out of them. To re-derive it, run this file with
// GUGU_ASSISTANT_RULES_BASELINE=write on a checkout of that commit plus this folder. Rewriting it from the current code
// would compare the split with itself.

/** Captures through the process's resolver and compares with the baseline: the keys that differ, and how many per read point. */
async function againstBaseline() {
  const current = Object.fromEntries(Object.entries(await captureAssistantRenders()).map(([key, value]) => [key, fingerprint(value)]))
  if (process.env.GUGU_ASSISTANT_RULES_BASELINE === 'write') writeFileSync(BASELINE_URL, `${JSON.stringify(current, null, 2)}\n`)
  const expected = readBaseline()
  expect(Object.keys(current).sort()).toEqual(Object.keys(expected).sort())
  const differing = Object.keys(expected).filter(key => current[key]!.sha256 !== expected[key]!.sha256 || current[key]!.bytes !== expected[key]!.bytes)
  const perReadPoint: Partial<Record<ReadPoint, number>> = {}
  for (const key of Object.keys(expected)) perReadPoint[readPointOf(key)] = (perReadPoint[readPointOf(key)] ?? 0) + 1
  return { differing, perReadPoint }
}

/** The 71 captures by where the host reads them: 57 at the four read points, 14 that the rules never reach. */
const PER_READ_POINT = { 'session-start': 27, 'per-turn': 5, dispatch: 10, setup: 15, host: 11, 'cloud-constant': 3 }

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'assistant-rules-identity-')) })
afterEach(async () => {
  installAssistantRulesResolver(null)
  await rm(root, { recursive: true, force: true })
})

describe('every rendered assistant rule is byte-for-byte as before the split, through the resolver', () => {
  it('when the source is the built-in copy', async () => {
    expect((await assistantRules().current()).source).toBe('built-in')
    const { differing, perReadPoint } = await againstBaseline()
    expect(differing).toEqual([])
    expect(perReadPoint).toEqual(PER_READ_POINT)
  })

  it('when the source is a trusted App whose rules folder is generated from the built-in text', async () => {
    const host = fixtureHost(root, join(root, 'last-good'))
    installBundle(host.service, await fixtureBundle(join(root, 'bundle')), 'market', OFFICIAL_SOURCE('0.0.1'))
    installAssistantRulesResolver(host.resolver)
    const resolved = await assistantRules().refresh()
    expect(resolved).toMatchObject({ source: 'app', appVersion: '0.0.1' })
    // Read from the App's folder: equal to the built-in copy, but not it.
    expect(resolved.rules).toEqual(BUILT_IN_ASSISTANT_RULES)
    expect(resolved.rules).not.toBe(BUILT_IN_ASSISTANT_RULES)
    const { differing, perReadPoint } = await againstBaseline()
    expect(differing).toEqual([])
    expect(perReadPoint).toEqual(PER_READ_POINT)
    expect(host.warnings).toEqual([])
  })

  it('when the source is the last good copy kept from that App, after it is uninstalled', async () => {
    const host = fixtureHost(root, join(root, 'last-good'))
    installBundle(host.service, await fixtureBundle(join(root, 'bundle')), 'market', OFFICIAL_SOURCE('0.0.1'))
    await host.resolver.refresh()
    host.service.uninstall('gugu-assistant')
    // A new process: nothing in memory, only the copy on disk.
    const next = fixtureHost(root, join(root, 'last-good'))
    installAssistantRulesResolver(next.resolver)
    expect(await assistantRules().refresh()).toMatchObject({ source: 'last-good', appVersion: '0.0.1' })
    expect((await againstBaseline()).differing).toEqual([])
  })

  it('captures the same strings twice (no time, randomness or machine path leaks into the comparison)', async () => {
    expect(await captureAssistantRenders()).toEqual(await captureAssistantRenders())
  })
})

describe('the App\'s rules reach every read point', () => {
  it('changes what each read point renders, and nothing the rules do not reach', async () => {
    const host = fixtureHost(root, join(root, 'last-good'))
    installBundle(host.service, await fixtureBundle(join(root, 'bundle'), { files: assistantRulesFiles(markedRules('APPMARK')) }), 'market', OFFICIAL_SOURCE('0.0.1'))
    installAssistantRulesResolver(host.resolver)
    expect((await assistantRules().refresh()).source).toBe('app')
    const { differing } = await againstBaseline()
    const changed = (point: ReadPoint) => differing.filter(key => readPointOf(key) === point)
    expect(changed('host')).toEqual([])
    expect(changed('cloud-constant')).toEqual([])
    // The captures the rules cannot change: nothing to wrap, a home with no settings file, an index already current.
    const unchanged = Object.keys(readBaseline()).filter(key => !['host', 'cloud-constant'].includes(readPointOf(key)) && !differing.includes(key))
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
