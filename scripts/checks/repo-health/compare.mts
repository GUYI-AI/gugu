#!/usr/bin/env node
// Compare two repo-health summary.json files (schemaVersion 1) and write a Markdown report.
// Usage: node scripts/checks/repo-health/compare.mts --previous <summary.json> --current <summary.json>
//          [--markdown <out.md>] [--json <out.json>] [--previous-label <text>]
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export type Hotspot = { file: string; fn: string; churn: number; crap: number; score: number }
export type Summary = {
  schemaVersion: number
  sha?: string
  generatedAt?: string
  dimensions?: Record<string, Record<string, unknown>>
  hotspots?: Hotspot[]
}
export type MetricRow = { dimension: string; field: string; previous: number | null; current: number | null; delta: number | null }
export type HotspotRow = { rank: number; file: string; fn: string; score: number; previousRank: number | null; scoreDelta: number | null; status: 'kept' | 'new' }
export type Comparison = {
  previous: { sha?: string; generatedAt?: string }
  current: { sha?: string; generatedAt?: string }
  dimensions: MetricRow[]
  hotspots: HotspotRow[]
  left: { file: string; fn: string; previousRank: number; score: number }[]
}

const TOP = 20

export function compareSummaries(previous: Summary, current: Summary): Comparison {
  for (const [name, summary] of [['previous', previous], ['current', current]] as const) {
    if (summary?.schemaVersion !== 1) throw new Error(`${name} summary has schemaVersion ${summary?.schemaVersion}, expected 1`)
  }
  const dimensions: MetricRow[] = []
  const names = new Set([...Object.keys(previous.dimensions ?? {}), ...Object.keys(current.dimensions ?? {})])
  for (const dimension of [...names].sort()) {
    const before = previous.dimensions?.[dimension] ?? {}
    const after = current.dimensions?.[dimension] ?? {}
    const fields = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const field of [...fields].sort()) {
      const a = before[field]
      const b = after[field]
      if (typeof a !== 'number' && typeof b !== 'number') continue
      dimensions.push({
        dimension,
        field,
        previous: typeof a === 'number' ? a : null,
        current: typeof b === 'number' ? b : null,
        delta: typeof a === 'number' && typeof b === 'number' ? round(b - a) : null,
      })
    }
  }

  const key = (h: Hotspot) => `${h.file}#${h.fn}`
  const before = (previous.hotspots ?? []).slice(0, TOP)
  const after = (current.hotspots ?? []).slice(0, TOP)
  const beforeRank = new Map(before.map((h, i) => [key(h), { rank: i + 1, ...h }]))
  const afterKeys = new Set(after.map(key))
  const hotspots = after.map((h, i): HotspotRow => {
    const old = beforeRank.get(key(h))
    return {
      rank: i + 1,
      file: h.file,
      fn: h.fn,
      score: h.score,
      previousRank: old?.rank ?? null,
      scoreDelta: old ? round(h.score - old.score) : null,
      status: old ? 'kept' : 'new',
    }
  })
  const left = before.filter((h) => !afterKeys.has(key(h))).map((h) => ({ file: h.file, fn: h.fn, previousRank: beforeRank.get(key(h))!.rank, score: h.score }))
  return { previous: { sha: previous.sha, generatedAt: previous.generatedAt }, current: { sha: current.sha, generatedAt: current.generatedAt }, dimensions, hotspots, left }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

const signed = (n: number | null) => (n === null ? '–' : n > 0 ? `+${n}` : `${n}`)
const shown = (n: number | null) => (n === null ? '–' : `${n}`)
const cell = (text: unknown) => String(text).replaceAll('|', '\\|')

export function renderMarkdown(result: Comparison, previousLabel = 'previous run'): string {
  const lines: string[] = []
  lines.push('## Weekly repo health')
  lines.push('')
  lines.push(`Current \`${result.current.sha?.slice(0, 12)}\` (${result.current.generatedAt}) against ${previousLabel} \`${result.previous.sha?.slice(0, 12)}\` (${result.previous.generatedAt}).`)
  lines.push('')
  lines.push('| Dimension | Metric | Previous | Current | Change |')
  lines.push('|---|---|---:|---:|---:|')
  for (const row of result.dimensions) {
    lines.push(`| ${row.dimension} | ${row.field} | ${shown(row.previous)} | ${shown(row.current)} | ${signed(row.delta)} |`)
  }
  lines.push('')
  lines.push(`### Top ${TOP} hotspots`)
  lines.push('')
  lines.push('| # | File | Function | Score | Was | Score change |')
  lines.push('|---:|---|---|---:|---|---:|')
  for (const h of result.hotspots) {
    const was = h.status === 'new' ? '**new**' : `#${h.previousRank}`
    lines.push(`| ${h.rank} | \`${cell(h.file)}\` | \`${cell(h.fn)}\` | ${h.score} | ${was} | ${signed(h.scoreDelta)} |`)
  }
  const fresh = result.hotspots.filter((h) => h.status === 'new')
  lines.push('')
  lines.push(`New in the top ${TOP}: ${fresh.length}. Left the top ${TOP}: ${result.left.length}.`)
  if (result.left.length) {
    lines.push('')
    for (const h of result.left) lines.push(`- left: \`${cell(h.file)}\` \`${cell(h.fn)}\` (was #${h.previousRank}, score ${h.score})`)
  }
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      previous: { type: 'string' },
      current: { type: 'string' },
      markdown: { type: 'string' },
      json: { type: 'string' },
      'previous-label': { type: 'string', default: 'previous run' },
    },
  })
  if (!values.previous || !values.current) throw new Error('--previous and --current are required')
  const result = compareSummaries(JSON.parse(readFileSync(values.previous, 'utf8')), JSON.parse(readFileSync(values.current, 'utf8')))
  const markdown = renderMarkdown(result, values['previous-label'])
  if (values.json) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`)
  if (values.markdown) writeFileSync(values.markdown, markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  else if (!values.markdown) process.stdout.write(markdown)
}
