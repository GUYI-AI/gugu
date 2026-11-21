#!/usr/bin/env node
// Aggregate PR-mode rule hits (pr-hits.json from pr-report.mts) over a period, one row per rule.
// The latest run of each PR counts once, so re-pushes do not inflate the numbers. Scans without a reference
// (no weekly scan yet) cannot tell new findings from old ones and are counted apart, not mixed in.
// Usage: node scripts/checks/repo-health/rule-stats.mts --dir <dir containing */pr-hits.json> [--markdown <out.md>] [--json <out.json>]
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export type PrHits = {
  pr?: number | null
  sha?: string
  generatedAt: string
  reference?: string | null
  rules?: Record<string, { hits: number; files: string[] }>
}
export type RuleStats = { prs: number; withoutReference: number; rules: Record<string, { prs: number; hits: number; files: number }> }

function hitFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) found.push(...hitFiles(full))
    else if (name === 'pr-hits.json') found.push(full)
  }
  return found
}

export function aggregate(reports: PrHits[]): RuleStats {
  const latest = new Map<number | string | undefined, PrHits>()
  for (const report of reports) {
    const key = report.pr ?? report.sha
    const seen = latest.get(key)
    if (!seen || seen.generatedAt < report.generatedAt) latest.set(key, report)
  }
  const rules: RuleStats['rules'] = {}
  const compared = [...latest.values()].filter((report) => report.reference)
  for (const report of compared) {
    for (const [rule, info] of Object.entries(report.rules ?? {})) {
      rules[rule] ??= { prs: 0, hits: 0, files: 0 }
      rules[rule].prs += 1
      rules[rule].hits += info.hits
      rules[rule].files += info.files.length
    }
  }
  return { prs: compared.length, withoutReference: latest.size - compared.length, rules }
}

export function renderMarkdown({ prs, withoutReference, rules }: RuleStats): string {
  const lines = ['### New findings per rule in PR scans', '', `PRs compared with a weekly scan (latest run each): ${prs}; without a reference, not counted: ${withoutReference}.`, '']
  const rows = Object.entries(rules).sort((a, b) => b[1].prs - a[1].prs || b[1].hits - a[1].hits)
  if (!rows.length) return `${lines.join('\n')}No rule hits.\n`
  lines.push('| Rule | PRs hit | Share of PRs | Hits | Files |', '|---|---:|---:|---:|---:|')
  for (const [rule, r] of rows) lines.push(`| \`${rule}\` | ${r.prs} | ${prs ? Math.round((100 * r.prs) / prs) : 0}% | ${r.hits} | ${r.files} |`)
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { dir: { type: 'string' }, markdown: { type: 'string' }, json: { type: 'string' } } })
  if (!values.dir) throw new Error('--dir is required')
  const result = aggregate(hitFiles(values.dir).map((file) => JSON.parse(readFileSync(file, 'utf8'))))
  const markdown = renderMarkdown(result)
  if (values.json) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`)
  if (values.markdown) writeFileSync(values.markdown, markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  else if (!values.markdown) process.stdout.write(markdown)
}
