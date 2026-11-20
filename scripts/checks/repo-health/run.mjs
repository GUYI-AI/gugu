#!/usr/bin/env node
// Repo health scan: runs each tool once over the whole repo and writes, under --out:
//   <tool>.raw.*            the tool's own output, untouched
//   <tool>.findings.json    [{file, line?, rule, message}] — what a PR-mode filter or a reviewer reads
//   summary.json            totals per dimension + hotspots (see README.md for the schema)
// Usage: node scripts/checks/repo-health/run.mjs --out <dir> [--only knip,jscpd] [--skip stryker]
//        [--coverage <lcov.info>] [--stryker-files <a.ts,b.ts>]
// Tools and their pins: knip, jscpd, dependency-cruiser, type-coverage, Stryker are root devDependencies;
// crapper and repowise are Python tools pinned in tools.json and installed by venv.mjs.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { runners } from './runners.mjs'
import { hotspotsFrom } from './hotspots.mjs'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    only: { type: 'string' },
    skip: { type: 'string' },
    coverage: { type: 'string' },
    'stryker-files': { type: 'string' },
    'hotspot-count': { type: 'string', default: '20' },
  },
})
if (!args.out) throw new Error('--out <dir> is required')

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const out = resolve(args.out)
mkdirSync(out, { recursive: true })
const list = (value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [])
const only = list(args.only)
const skip = list(args.skip)
const selected = Object.keys(runners).filter((name) => (only.length === 0 || only.includes(name)) && !skip.includes(name))

const ctx = {
  root,
  out,
  coverage: args.coverage ? resolve(args.coverage) : undefined,
  strykerFiles: list(args['stryker-files']),
  results: {},
}
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
// A later run at the same sha (e.g. `--only stryker`) adds to the summary instead of replacing it.
const summaryFile = resolve(out, 'summary.json')
const previous = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : undefined
const summary = previous?.sha === sha && previous.schemaVersion === 1
  ? previous
  : { schemaVersion: 1, sha, generatedAt: undefined, tools: {}, dimensions: {}, hotspots: [] }
summary.generatedAt = new Date().toISOString()
ctx.hotspots = summary.hotspots

for (const name of selected) {
  const runner = runners[name]
  const started = Date.now()
  process.stderr.write(`[repo-health] ${name}…\n`)
  // Fail loud per tool, but keep going: one broken tool must not hide the other dimensions.
  try {
    const result = await runner(ctx)
    ctx.results[name] = result
    writeFileSync(resolve(out, `${name}.findings.json`), `${JSON.stringify(result.findings, null, 1)}\n`)
    summary.tools[name] = { ok: true, version: result.version, scope: result.scope, durationMs: Date.now() - started }
    summary.dimensions[result.dimension] = result.metrics
    if (name === 'crapper' || name === 'repowise') {
      ctx.hotspots = summary.hotspots = hotspotsFrom(out, Number(args['hotspot-count']))
    }
  } catch (error) {
    summary.tools[name] = { ok: false, error: String(error?.stack ?? error).slice(0, 4000), durationMs: Date.now() - started }
    process.stderr.write(`[repo-health] ${name} FAILED: ${error?.message ?? error}\n`)
  }
}

writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)
const failed = Object.entries(summary.tools).filter(([, tool]) => !tool.ok).map(([name]) => name)
process.stderr.write(`[repo-health] wrote ${summaryFile}${failed.length ? ` — FAILED: ${failed.join(', ')}` : ''}\n`)
process.exitCode = failed.length ? 1 : 0
