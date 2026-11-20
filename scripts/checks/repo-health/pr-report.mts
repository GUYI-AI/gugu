#!/usr/bin/env node
// Changed-file report for a PR scan: which repo-health findings in the files this change touches are new.
// Reads <out>/<tool>.findings.json ([{ file, line?, rule, message }]) and <out>/crapper.raw.jsonl written by run.mjs,
// and the same files of a reference scan (the latest weekly scan of the base branch) when --reference is given.
// A finding is introduced when the reference has fewer findings with the same rule, file and message (digits
// ignored, so moved lines and changed counts do not count as new). A changed function is flagged when its
// cyclomatic complexity crosses 10, 20 or 50 relative to the reference (a new function starts from 0).
// Usage: node scripts/checks/repo-health/pr-report.mts --out <dir> --changed-from <ref> [--reference <dir>]
//          [--reference-label <text>] [--pr <number>]
//        node scripts/checks/repo-health/pr-report.mts --changed-from <ref> --list-changed
// Writes <out>/pr-hits.json and <out>/pr-report.md; appends the report to $GITHUB_STEP_SUMMARY.
// Warn-only: the exit code reports only whether this script itself worked.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export type Finding = { file: string; line?: number; rule: string; message?: string }
export type FnScore = { path: string; line?: number; name: string; namespace?: string; complexity: number }
export type RuleHits = Record<string, { hits: number; files: string[] }>
export type ToolRun = { ok: boolean; durationMs?: number; scope?: string; error?: string }
export type ComplexityRise = { file: string; line?: number; fn: string; before: number; after: number; tier: number }
export type Report = {
  files: string[]
  introduced: Record<string, Finding[]>
  existing: Record<string, Finding[]>
  complexity: ComplexityRise[]
  rules: RuleHits
}

export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/
export const CC_TIERS = [10, 20, 50]
const MAX_ROWS = 50

export function changedFiles(ref: string, cwd = process.cwd()): string[] {
  const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', '-z', ref, 'HEAD'], { cwd, encoding: 'utf8' })
  return output.split('\0').filter((file) => SOURCE_FILE.test(file))
}

export function readFindings(dir: string): Record<string, Finding[]> {
  const byTool: Record<string, Finding[]> = {}
  for (const name of readdirSync(dir).sort()) {
    const match = /^(.+)\.findings\.json$/.exec(name)
    if (!match) continue
    const findings: unknown = JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
    if (!Array.isArray(findings)) throw new Error(`${name} is not an array`)
    byTool[match[1]] = findings as Finding[]
  }
  return byTool
}

export function readFunctions(dir: string): FnScore[] {
  const file = path.join(dir, 'crapper.raw.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FnScore)
}

const findingKey = (f: Finding) => `${f.rule}\0${f.file}\0${String(f.message ?? '').replace(/\d+/g, '#')}`
const fnKey = (f: FnScore) => `${f.path}\0${f.namespace ?? ''}\0${f.name}`

// Keys can repeat (two `any`s with the same text in one file); count them so one more is still one new.
function counts<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>()
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1)
  return map
}

export function buildReport({
  files,
  findings,
  reference,
  functions = [],
  referenceFunctions,
}: {
  files: string[]
  findings: Record<string, Finding[]>
  reference?: Record<string, Finding[]>
  functions?: FnScore[]
  referenceFunctions?: FnScore[]
}): Report {
  const changed = new Set(files)
  const introduced: Record<string, Finding[]> = {}
  const existing: Record<string, Finding[]> = {}
  const rules: RuleHits = {}
  const hit = (rule: string, file: string) => {
    rules[rule] ??= { hits: 0, files: [] }
    rules[rule].hits += 1
    if (!rules[rule].files.includes(file)) rules[rule].files.push(file)
  }
  for (const [tool, all] of Object.entries(findings)) {
    // Without a reference nothing can be called new; everything is listed as present.
    const left = reference ? counts((reference[tool] ?? []).filter((f) => changed.has(f.file)), findingKey) : undefined
    introduced[tool] = []
    existing[tool] = []
    for (const finding of all.filter((f) => changed.has(f.file))) {
      const key = findingKey(finding)
      const remaining = left?.get(key) ?? 0
      if (left && remaining === 0) {
        introduced[tool].push(finding)
        hit(finding.rule, finding.file)
      } else {
        left?.set(key, remaining - 1)
        existing[tool].push(finding)
      }
    }
  }
  const complexity: ComplexityRise[] = []
  if (referenceFunctions) {
    // The highest-complexity entry wins when a file has several functions under one name.
    const before = new Map<string, number>()
    for (const fn of referenceFunctions) before.set(fnKey(fn), Math.max(before.get(fnKey(fn)) ?? 0, fn.complexity))
    for (const fn of functions.filter((f) => changed.has(f.path))) {
      const was = before.get(fnKey(fn)) ?? 0
      const tier = [...CC_TIERS].reverse().find((t) => was < t && fn.complexity >= t)
      if (tier === undefined) continue
      complexity.push({ file: fn.path, line: fn.line, fn: fn.name, before: was, after: fn.complexity, tier })
      hit(`complexity/cc-${tier}`, fn.path)
    }
    complexity.sort((a, b) => b.after - a.after)
  }
  return { files, introduced, existing, complexity, rules }
}

const total = (byTool: Record<string, Finding[]>) => Object.values(byTool).reduce((sum, list) => sum + list.length, 0)
const where = (f: { file: string; line?: number }) => `\`${f.file}${f.line ? `:${f.line}` : ''}\``
const oneLine = (text: unknown) => String(text ?? '').replaceAll('\n', ' ').replaceAll('|', '\\|').slice(0, 200)

function findingList(lines: string[], title: string, byTool: Record<string, Finding[]>, open: boolean) {
  for (const [tool, list] of Object.entries(byTool)) {
    if (!list.length) continue
    lines.push('', `<details${open ? ' open' : ''}><summary>${title}: ${tool}, ${list.length}</summary>`, '')
    for (const f of list.slice(0, MAX_ROWS)) lines.push(`- ${where(f)} \`${f.rule}\`: ${oneLine(f.message)}`)
    if (list.length > MAX_ROWS) lines.push(`- … ${list.length - MAX_ROWS} more in the artifact`)
    lines.push('', '</details>')
  }
}

export function renderMarkdown(report: Report, { tools, referenceLabel }: { tools?: Record<string, ToolRun>; referenceLabel?: string } = {}): string {
  const lines = ['## Repo health: changed files', '']
  lines.push(`Warn-only; nothing here blocks the merge. ${report.files.length} changed source file(s).`)
  lines.push(referenceLabel
    ? `New findings are counted against ${referenceLabel}.`
    : 'No reference scan was available, so findings cannot be split into new and existing; all are listed as present.')
  const toolRows = Object.entries(tools ?? {})
  if (toolRows.length) {
    lines.push('', '| Tool | Ran | New | Already there |', '|---|---|---:|---:|')
    for (const [tool, info] of toolRows) {
      const ran = info.ok
        ? `yes (${Math.round((info.durationMs ?? 0) / 1000)} s${info.scope ? `, ${oneLine(info.scope)}` : ''})`
        : `**failed**${info.error ? `: ${oneLine(info.error.split('\n')[0])}` : ''}`
      lines.push(`| ${tool} | ${ran} | ${report.introduced[tool]?.length ?? 0} | ${report.existing[tool]?.length ?? 0} |`)
    }
  }
  if (report.complexity.length) {
    lines.push('', '### Functions that crossed a complexity threshold', '')
    lines.push('| Function | Where | CC before | CC now |', '|---|---|---:|---:|')
    for (const c of report.complexity.slice(0, MAX_ROWS)) {
      lines.push(`| \`${oneLine(c.fn)}\` | ${where(c)} | ${c.before || 'new'} | ${c.after} |`)
    }
  }
  const ruleRows = Object.entries(report.rules).sort((a, b) => b[1].hits - a[1].hits)
  if (ruleRows.length) {
    lines.push('', '### New findings per rule', '', '| Rule | Hits | Files |', '|---|---:|---:|')
    for (const [rule, info] of ruleRows) lines.push(`| \`${rule}\` | ${info.hits} | ${info.files.length} |`)
  }
  findingList(lines, 'New', report.introduced, true)
  findingList(lines, 'Already there', report.existing, false)
  if (!total(report.introduced) && !total(report.existing) && !report.complexity.length) lines.push('', 'No findings in the changed files.')
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      'changed-from': { type: 'string' },
      reference: { type: 'string' },
      'reference-label': { type: 'string' },
      pr: { type: 'string' },
      'list-changed': { type: 'boolean' },
    },
  })
  if (!values['changed-from']) throw new Error('--changed-from is required')
  const files = changedFiles(values['changed-from'])
  // --list-changed prints the changed non-test source files comma-separated (run.mjs --files) and stops.
  if (values['list-changed']) {
    process.stdout.write(`${files.filter((file) => !TEST_FILE.test(file)).join(',')}\n`)
    process.exit(0)
  }
  if (!values.out) throw new Error('--out is required')
  const summaryPath = path.join(values.out, 'summary.json')
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : {}
  const reference = values.reference
  const report = buildReport({
    files,
    findings: readFindings(values.out),
    reference: reference ? readFindings(reference) : undefined,
    functions: readFunctions(values.out),
    referenceFunctions: reference ? readFunctions(reference) : undefined,
  })
  const referenceLabel = reference ? (values['reference-label'] ?? reference) : undefined
  const hits = {
    schemaVersion: 1,
    sha: summary.sha ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    pr: values.pr ? Number(values.pr) : null,
    generatedAt: new Date().toISOString(),
    reference: referenceLabel ?? null,
    changedFiles: files.length,
    tools: summary.tools ?? {},
    rules: report.rules,
  }
  writeFileSync(path.join(values.out, 'pr-hits.json'), `${JSON.stringify(hits, null, 2)}\n`)
  const markdown = renderMarkdown(report, { tools: summary.tools, referenceLabel })
  writeFileSync(path.join(values.out, 'pr-report.md'), markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  else process.stdout.write(markdown)
}
