import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyCheckSnapshot,
  deriveCheckProfiles,
  evaluateCheckSnapshots,
  eventHasSubscribingWorkflow,
  loadWorkflowInventory,
  type CheckRunSnapshot,
  type VerdictEvent
} from '../../../scripts/ci/check-verdict.mts'

const warmPath = '.github/workflows/ci-cache.yml'
const macPath = '.github/workflows/ci-dev-mac.yml'
const entry = (path: string) => ({ path, source: readFileSync(path, 'utf8') })
const warmNames = ['Seed Linux dependencies and ESLint', 'Seed macOS dependencies and Chromium',
  ...Array.from({ length: 6 }, (_, i) => `Seed Vitest (${i + 1}/6)`)]
const push: VerdictEvent = {
  id: 'push:dev', type: 'push', ref: 'refs/heads/dev', changedPaths: ['apps/desktop/src/App.tsx'],
  inventoryRef: 'candidate-sha', workflows: [entry(warmPath), entry(macPath)]
}
const realNames = deriveCheckProfiles([{ ...push, workflows: [entry(macPath)] }]).flatMap(profile => profile.checks)
const realRuns = (conclusion = 'success'): CheckRunSnapshot[] => realNames.map((name, i) =>
  ({ id: i + 1, event: 'push', name, status: 'completed', conclusion }))

describe('cache warming is not canonical evidence', () => {
  it.each(['queued', 'in_progress', 'cancelled', 'failure', 'timed_out', 'missing'])('keeps GREEN when only the prewarm workflow is %s', scenario => {
      const profiles = deriveCheckProfiles([push])
      const warm: CheckRunSnapshot[] = scenario === 'missing' ? [] : warmNames.map((name, i) => ({
        id: 100 + i, event: 'push', name,
        status: ['queued', 'in_progress'].includes(scenario) ? scenario : 'completed',
        conclusion: ['queued', 'in_progress'].includes(scenario) ? null : scenario
      }))
      const runs = [...realRuns(), ...warm]
      expect(realNames).toContain('Dev desktop app build (macos-15)')
      expect(profiles.map(profile => profile.workflow)).toEqual([macPath])
      expect(classifyCheckSnapshot(profiles, runs)).toMatchObject({ missing: [], pending: [], failed: [] })
      expect(evaluateCheckSnapshots(profiles, [runs, runs])).toMatchObject({ verdict: 'GREEN', settling: false })
      // The two independent snapshots remain mandatory for every real gate.
      expect(evaluateCheckSnapshots(profiles, [runs])).toMatchObject({ verdict: 'WAIT', settling: true })
    })

  it.each(['queued', 'cancelled', 'missing', 'real-failure'])('uses the production CLI boundary for %s', scenario => {
    const directory = mkdtempSync(join(tmpdir(), 'gugu-warm-canonical-'))
    try {
      const warm = scenario === 'missing' ? [] : warmNames.map((name, i) => ({
        id: 100 + i, event: 'push', name, status: scenario === 'queued' ? 'queued' : 'completed',
        conclusion: scenario === 'queued' ? null : 'cancelled'
      }))
      const runs = [...realRuns(scenario === 'real-failure' ? 'failure' : 'success'), ...warm]
      const file = join(directory, 'fixture.json')
      writeFileSync(file, JSON.stringify({ events: [push], snapshots: [runs, runs] }))
      const result = spawnSync(process.execPath, [resolve('scripts/ci/check-verdict.mts'), '--fixture', file, '--json'], { encoding: 'utf8' })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(scenario === 'real-failure' ? 1 : 0)
      expect(JSON.parse(result.stdout).verdict).toBe(scenario === 'real-failure' ? 'RED' : 'GREEN')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps a failed Dev Mac build RED even when every cache seed is green', () => {
    const runs: CheckRunSnapshot[] = [...realRuns('failure'), ...warmNames.map((name, i) =>
      ({ id: 100 + i, event: 'push', name, status: 'completed', conclusion: 'success' }))]
    const result = evaluateCheckSnapshots(deriveCheckProfiles([push]), [runs, runs])
    expect(result.verdict).toBe('RED')
    expect(result.failed).toEqual(['push/Dev desktop app build (macos-15) (failure)'])
  })

  it('still requires a missing or queued real build, and never accepts cache-only evidence', () => {
    const profiles = deriveCheckProfiles([push])
    expect(evaluateCheckSnapshots(profiles, [[], []])).toMatchObject({ verdict: 'INCOMPLETE', missing: ['push/Dev desktop app build (macos-15)'] })
    const queued = realRuns().map(run => ({ ...run, status: 'queued', conclusion: null }))
    expect(evaluateCheckSnapshots(profiles, [queued, queued])).toMatchObject({ verdict: 'WAIT', pending: ['push/Dev desktop app build (macos-15)'] })
    const onlyWarm = { ...push, workflows: [entry(warmPath)] }
    expect(eventHasSubscribingWorkflow(onlyWarm)).toBe(false)
    expect(evaluateCheckSnapshots(deriveCheckProfiles([onlyWarm]), [[], []]).verdict).toBe('INCOMPLETE')
  })

  it('does not exempt a Seed-named job in another workflow', () => {
    const workflow = { path: '.github/workflows/real.yml', source: JSON.stringify({
      name: 'Required build', on: { push: { branches: ['dev'] } }, jobs: { build: { name: warmNames[0], 'runs-on': 'fixture' } }
    }) }
    const profiles = deriveCheckProfiles([{ ...push, workflows: [workflow] }])
    const runs = [{ id: 200, event: 'push', name: warmNames[0], status: 'completed', conclusion: 'failure' }]
    expect(evaluateCheckSnapshots(profiles, [runs, runs]).verdict).toBe('RED')
  })

  it('preserves the exact real PR CI check set and all its failures', () => {
    const workflows = loadWorkflowInventory(process.cwd(), 'HEAD')
    const pr: VerdictEvent = { ...push, id: 'pull_request:#fixture', type: 'pull_request', action: 'synchronize', baseRef: 'dev', workflows }
    const profiles = deriveCheckProfiles([pr])
    const withoutWarm = deriveCheckProfiles([{ ...pr, workflows: workflows.filter(workflow => workflow.path !== warmPath) }])
    const shape = (items: typeof profiles) => items.map(({ workflow, checks, pathFiltered, noMatchReason }) => ({ workflow, checks, pathFiltered, noMatchReason }))
    expect(shape(profiles)).toEqual(shape(withoutWarm))
    const names = profiles.flatMap(profile => profile.checks)
    expect(names).toContain('Typecheck, lint, and test')
    expect(names.every(name => !warmNames.includes(name))).toBe(true)
    const green = names.map((name, i) => ({ id: i + 1, event: 'pull_request', name, status: 'completed', conclusion: 'success' }))
    expect(evaluateCheckSnapshots(profiles, [green, green]).verdict).toBe('GREEN')
    const bad = green.map(run => run.name === 'Typecheck, lint, and test' ? { ...run, conclusion: 'failure' } : run)
    expect(evaluateCheckSnapshots(profiles, [bad, bad]).verdict).toBe('RED')
  })
})
