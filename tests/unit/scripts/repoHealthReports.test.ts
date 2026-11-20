import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { compareSummaries, renderMarkdown as renderWeekly } from '../../../scripts/checks/repo-health/compare.mts'
import { buildReport, changedFiles, renderMarkdown as renderPr } from '../../../scripts/checks/repo-health/pr-report.mts'
import { aggregate } from '../../../scripts/checks/repo-health/rule-stats.mts'

const summary = (sha: string, over: object) => ({ schemaVersion: 1, sha, generatedAt: `${sha}-time`, tools: {}, ...over })
const spot = (file: string, fn: string, score: number) => ({ file, fn, churn: 1, crap: score, score })

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('weekly compare', () => {
  test('reports every metric change, hotspot rank moves, and hotspots that are new or gone', () => {
    const previous = summary('aaa', {
      dimensions: { duplication: { clones: 10, percent: 8.5 }, deps: { cycles: 4 } },
      hotspots: [spot('a.ts', 'f', 90), spot('b.ts', 'g', 50)],
    })
    const current = summary('bbb', {
      dimensions: { duplication: { clones: 7, percent: 8.25 }, typeCoverage: { percent: 97 } },
      hotspots: [spot('b.ts', 'g', 60), spot('c.ts', 'h', 40)],
    })
    const result = compareSummaries(previous, current)
    expect(result.dimensions).toEqual([
      { dimension: 'deps', field: 'cycles', previous: 4, current: null, delta: null },
      { dimension: 'duplication', field: 'clones', previous: 10, current: 7, delta: -3 },
      { dimension: 'duplication', field: 'percent', previous: 8.5, current: 8.25, delta: -0.25 },
      { dimension: 'typeCoverage', field: 'percent', previous: null, current: 97, delta: null },
    ])
    expect(result.hotspots).toEqual([
      { rank: 1, file: 'b.ts', fn: 'g', score: 60, previousRank: 2, scoreDelta: 10, status: 'kept' },
      { rank: 2, file: 'c.ts', fn: 'h', score: 40, previousRank: null, scoreDelta: null, status: 'new' },
    ])
    expect(result.left).toEqual([{ file: 'a.ts', fn: 'f', previousRank: 1, score: 90 }])
    const markdown = renderWeekly(result, 'the seed baseline')
    expect(markdown).toContain('| duplication | clones | 10 | 7 | -3 |')
    expect(markdown).toContain('| 2 | `c.ts` | `h` | 40 | **new** | – |')
    expect(markdown).toContain('New in the top 20: 1. Left the top 20: 1.')
  })

  test('refuses a summary of another schema version instead of comparing garbage', () => {
    expect(() => compareSummaries({ schemaVersion: 2 }, summary('b', {}))).toThrow('schemaVersion 2')
  })
})

describe('changed-file report', () => {
  const findings = {
    knip: [
      { file: 'src/a.ts', line: 3, rule: 'knip/exports', message: 'oldExport' },
      { file: 'src/a.ts', line: 9, rule: 'knip/exports', message: 'newExport' },
      { file: 'src/untouched.ts', rule: 'knip/exports', message: 'not in this change' },
    ],
    jscpd: [
      { file: 'src/a.ts', line: 40, rule: 'jscpd/clone', message: '12 lines duplicated with src/b.ts:9-21' },
      { file: 'src/a.ts', line: 80, rule: 'jscpd/clone', message: '7 lines duplicated with src/b.ts:30-37' },
    ],
  }
  // The weekly scan saw oldExport and one clone with src/b.ts (at other lines, with another length).
  const reference = {
    knip: [{ file: 'src/a.ts', line: 1, rule: 'knip/exports', message: 'oldExport' }],
    jscpd: [{ file: 'src/a.ts', line: 35, rule: 'jscpd/clone', message: '10 lines duplicated with src/b.ts:5-15' }],
  }

  test('splits findings in changed files into new and already there, ignoring moved lines', () => {
    const report = buildReport({ files: ['src/a.ts'], findings, reference })
    expect(report.introduced.knip.map((f) => f.message)).toEqual(['newExport'])
    expect(report.existing.knip.map((f) => f.message)).toEqual(['oldExport'])
    // Two clones against one in the reference: one of them is new.
    expect(report.introduced.jscpd).toHaveLength(1)
    expect(report.existing.jscpd).toHaveLength(1)
    expect(report.rules).toEqual({
      'knip/exports': { hits: 1, files: ['src/a.ts'] },
      'jscpd/clone': { hits: 1, files: ['src/a.ts'] },
    })
    const markdown = renderPr(report, { tools: { knip: { ok: true, durationMs: 4000 }, jscpd: { ok: false, error: 'boom\nstack' } }, referenceLabel: 'weekly scan 1' })
    expect(markdown).toContain('| knip | yes (4 s) | 1 | 1 |')
    expect(markdown).toContain('| jscpd | **failed**: boom | 1 | 1 |')
    expect(markdown).toContain('counted against weekly scan 1')
  })

  test('without a reference nothing is called new and no rule is counted', () => {
    const report = buildReport({ files: ['src/a.ts'], findings })
    expect(report.introduced.knip).toEqual([])
    expect(report.existing.knip).toHaveLength(2)
    expect(report.rules).toEqual({})
  })

  test('flags changed functions whose complexity crosses 10, 20 or 50, counting a new function from 0', () => {
    const fn = (name: string, complexity: number, path = 'src/a.ts') => ({ path, name, namespace: 'src.a', complexity })
    const report = buildReport({
      files: ['src/a.ts'],
      findings: {},
      reference: {},
      referenceFunctions: [fn('grew', 8), fn('wasBig', 25), fn('jumped', 12)],
      functions: [fn('grew', 11), fn('wasBig', 30), fn('jumped', 55), fn('fresh', 21), fn('other', 99, 'src/z.ts')],
    })
    expect(report.complexity.map((c) => [c.fn, c.before, c.after, c.tier])).toEqual([
      ['jumped', 12, 55, 50],
      ['fresh', 0, 21, 20],
      ['grew', 8, 11, 10],
    ])
    expect(Object.keys(report.rules).sort()).toEqual(['complexity/cc-10', 'complexity/cc-20', 'complexity/cc-50'])
  })

  test('lists added, modified and renamed source files against the base, never deleted ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'repo-health-git-'))
    dirs.push(dir)
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' })
    git('init', '-q')
    await writeFile(join(dir, 'keep.ts'), 'export const a = 1\n')
    await writeFile(join(dir, 'gone.ts'), 'export const b = 1\n')
    await writeFile(join(dir, 'README.md'), 'x\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    await writeFile(join(dir, 'keep.ts'), 'export const a = 2\n')
    await writeFile(join(dir, 'new.tsx'), 'export const c = 1\n')
    await writeFile(join(dir, 'README.md'), 'y\n')
    git('rm', '-q', 'gone.ts')
    git('add', '.')
    git('commit', '-qm', 'change')
    expect(changedFiles('HEAD^1', dir).sort()).toEqual(['keep.ts', 'new.tsx'])
  })
})

describe('weekly rule-hit aggregation', () => {
  test('counts each PR once, by its latest scan, and keeps unreferenced scans apart', () => {
    const report = (pr: number, at: string, hits: number, reference: string | null = 'weekly 1') => ({ pr, generatedAt: at, reference, rules: { 'knip/exports': { hits, files: ['a.ts'] } } })
    expect(aggregate([
      report(1, '2026-11-20T01', 5),
      report(1, '2026-11-20T02', 2),
      report(2, '2026-11-20T01', 1),
      report(3, '2026-11-20T01', 9, null),
    ])).toEqual({
      prs: 2,
      withoutReference: 1,
      rules: { 'knip/exports': { prs: 2, hits: 3, files: 2 } },
    })
  })
})
