#!/usr/bin/env node
// Markdown tables from a repo-health scan: node scripts/checks/repo-health/report.mjs <out-dir> > REPORT.md
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const out = process.argv[2]
if (!out) throw new Error('usage: report.mjs <out-dir>')
const summary = JSON.parse(readFileSync(resolve(out, 'summary.json'), 'utf8'))
const cell = (value) => (value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value))
const table = (header, rows) =>
  [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n')

const lines = [`# repo-health ${summary.sha.slice(0, 9)}`, '', `Generated ${summary.generatedAt}.`, '', '## Tools', '']
lines.push(table(['tool', 'ok', 'version', 'scope', 'seconds'], Object.entries(summary.tools).map(([name, tool]) => [
  name, tool.ok ? 'yes' : `**no**: ${tool.error?.split('\n')[0]}`, tool.version, tool.scope, Math.round(tool.durationMs / 1000),
])))
lines.push('', '## Dimensions', '')
for (const [dimension, metrics] of Object.entries(summary.dimensions)) {
  lines.push(`### ${dimension}`, '', table(['metric', 'value'], Object.entries(metrics)), '')
}
lines.push(`## Hotspots (churn × CRAP, top ${summary.hotspots.length})`, '')
lines.push(table(['#', 'file', 'function', 'line', 'churn', 'commits', 'CRAP', 'CC', 'coverage %', 'score'], summary.hotspots.map((row, i) => [
  i + 1, `\`${row.file}\``, `\`${row.fn}\``, row.line, row.churn.toFixed(3), row.commits, row.crap, row.complexity, row.coverage, row.score,
])))
process.stdout.write(`${lines.join('\n')}\n`)
