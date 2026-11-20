// One runner per tool. Each returns
//   { dimension, version, scope, metrics, findings: [{file, line?, rule, message}], ...extra }
// and leaves the tool's own output in <out>/<tool>.raw.*. Paths in findings are repo-relative.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { ensureVenv, pinOf } from './venv.mjs'

// Some tools do not export ./package.json, so read it from node_modules directly.
const repoRoot = resolve(import.meta.dirname, '../../..')
const versionOf = (pkg) => JSON.parse(readFileSync(resolve(repoRoot, 'node_modules', pkg, 'package.json'), 'utf8')).version

function run(ctx, command, args, { allowExit = [0], env = {}, maxBuffer = 1 << 30 } = {}) {
  const result = spawnSync(command, args, {
    cwd: ctx.root,
    encoding: 'utf8',
    maxBuffer,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (!allowExit.includes(result.status)) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${(result.stdout + result.stderr).slice(-4000)}`)
  }
  return result
}
const bin = (ctx, name) => resolve(ctx.root, 'node_modules/.bin', name)
const raw = (ctx, name) => resolve(ctx.out, name)
const rel = (ctx, file) => (file.startsWith('/') ? relative(ctx.root, file) : file)

async function knip(ctx) {
  const { stdout } = run(ctx, bin(ctx, 'knip'), ['--reporter', 'json', '--no-exit-code', '--no-progress'])
  writeFileSync(raw(ctx, 'knip.raw.json'), stdout)
  const findings = []
  const counts = {}
  for (const issue of JSON.parse(stdout).issues) {
    for (const [kind, value] of Object.entries(issue)) {
      if (kind === 'file' || value == null || typeof value !== 'object') continue
      // `duplicates` is a list of groups; enum/namespace members are keyed by parent.
      const items = Array.isArray(value) ? value.flat() : Object.values(value).flat()
      for (const item of items) {
        counts[kind] = (counts[kind] ?? 0) + 1
        findings.push({ file: issue.file, line: item.line, rule: `knip/${kind}`, message: item.name ?? String(item) })
      }
    }
  }
  return {
    dimension: 'deadCode',
    version: versionOf('knip'),
    scope: 'workspaces per knip.ts',
    metrics: { total: findings.length, ...counts },
    findings,
  }
}

async function jscpd(ctx) {
  const dir = raw(ctx, 'jscpd')
  run(ctx, bin(ctx, 'jscpd'), ['--config', '.jscpd.json', '--reporters', 'json', '--output', dir, '--silent'])
  const report = JSON.parse(readFileSync(resolve(dir, 'jscpd-report.json'), 'utf8'))
  const total = report.statistics.total
  const findings = report.duplicates.flatMap((dup) => {
    const [a, b] = [dup.firstFile, dup.secondFile]
    const where = (f) => `${f.name}:${f.start}-${f.end}`
    return [
      { file: a.name, line: a.start, rule: 'jscpd/clone', message: `${dup.lines} lines duplicated with ${where(b)}` },
      { file: b.name, line: b.start, rule: 'jscpd/clone', message: `${dup.lines} lines duplicated with ${where(a)}` },
    ]
  })
  return {
    dimension: 'duplication',
    version: versionOf('jscpd'),
    scope: 'paths in .jscpd.json, tests excluded',
    metrics: {
      clones: total.clones,
      duplicatedLines: total.duplicatedLines,
      lines: total.lines,
      percent: Number(total.percentage),
      files: total.sources,
    },
    findings,
  }
}

async function depcruise(ctx) {
  const file = raw(ctx, 'depcruise.raw.json')
  run(ctx, bin(ctx, 'depcruise'), ['apps', 'packages', 'scripts', '--config', '.dependency-cruiser.cjs', '--output-type', 'json', '--output-to', file, '--no-progress'], { allowExit: [0, ...Array.from({ length: 255 }, (_, i) => i + 1)] })
  const { summary } = JSON.parse(readFileSync(file, 'utf8'))
  const byRule = {}
  const cycles = new Set()
  const findings = summary.violations.map((v) => {
    byRule[v.rule.name] = (byRule[v.rule.name] ?? 0) + 1
    if (v.cycle) cycles.add(v.cycle.map((step) => step.name ?? step).sort().join('|'))
    const detail = v.cycle ? `cycle: ${[v.from, ...v.cycle.map((step) => step.name ?? step)].join(' → ')}` : `${v.from} → ${v.to}`
    return { file: v.from, rule: `depcruise/${v.rule.name}`, message: detail, severity: v.rule.severity }
  })
  return {
    dimension: 'deps',
    version: versionOf('dependency-cruiser'),
    scope: 'apps packages scripts',
    metrics: {
      violations: summary.violations.length,
      errors: summary.error,
      warnings: summary.warn,
      cycles: cycles.size,
      modules: summary.totalCruised,
      dependencies: summary.totalDependenciesCruised,
      byRule,
    },
    findings,
  }
}

// TypeScript 6's checker (the API type-coverage uses; the repo itself typechecks with tsgo) hits a debug
// assertion on a few files. Those files are excluded one by one and listed in the summary, never hidden.
async function typeCoverage(ctx) {
  const excluded = []
  const env = { NODE_OPTIONS: '--max-old-space-size=32768' }
  for (let attempt = 0; attempt < 20; attempt++) {
    const ignore = excluded.flatMap((file) => ['--ignore-files', file])
    const args = ['-p', 'tsconfig.json', '--detail', '--json-output', '--show-relative-path', ...ignore]
    const { stdout } = run(ctx, bin(ctx, 'type-coverage'), args, { allowExit: [0, 1], env })
    // type-coverage prints `warning: unhandled node kind …` lines on stdout before the JSON.
    const report = JSON.parse(stdout.slice(stdout.indexOf('{')))
    if (report.succeeded === false && /Debug Failure/.test(report.error ?? '')) {
      // The checker crash exits the process at once: piped stdout loses its tail, so the last node printed would
      // name an innocent file. Write the debug trace to a file (synchronous writes) and read the real last node.
      const trace = raw(ctx, 'type-coverage.debug.log')
      const fd = openSync(trace, 'w')
      const debug = spawnSync(bin(ctx, 'type-coverage'), ['-p', 'tsconfig.json', '--debug', ...ignore], {
        cwd: ctx.root, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd],
      })
      closeSync(fd)
      if (debug.error) throw debug.error
      const crashed = [...readFileSync(trace, 'utf8').matchAll(/^node: ([^:]+):/gm)].at(-1)?.[1]
      if (!crashed) throw new Error(`type-coverage checker crash without a file: ${report.error}`)
      excluded.push(crashed)
      continue
    }
    if (report.error) throw new Error(`type-coverage: ${report.error}`)
    writeFileSync(raw(ctx, 'type-coverage.raw.json'), stdout)
    const details = report.details ?? []
    return {
      dimension: 'typeCoverage',
      version: versionOf('type-coverage'),
      scope: 'tsconfig.json',
      excluded,
      metrics: {
        percent: Number(report.percent.toFixed(2)),
        typed: report.correctCount,
        total: report.totalCount,
        anyCount: report.totalCount - report.correctCount,
        excludedFiles: excluded,
      },
      // type-coverage reports 0-based lines.
      findings: details.map((d) => ({ file: rel(ctx, d.filePath), line: d.line + 1, rule: 'type-coverage/any', message: d.text })),
    }
  }
  throw new Error(`type-coverage: more than 20 files crash the TypeScript checker: ${excluded.join(', ')}`)
}

// crapper scores TypeScript with LCOV. Pass --coverage <lcov.info> (from `vitest --coverage`) or it runs
// complexity-only. Its own report is .metrics/crap.edn; crapper_json.py adds the file and line.
async function crapper(ctx) {
  const python = resolve(ensureVenv(ctx.root), 'bin/python')
  const args = [resolve(import.meta.dirname, 'crapper_json.py')]
  if (ctx.coverage) {
    // crapper reads <root>/coverage/**/lcov.info or <root>/target/coverage/**/lcov.info.
    const expected = resolve(ctx.root, 'target/coverage/typescript/lcov.info')
    if (resolve(ctx.coverage) !== expected) throw new Error(`--coverage must be ${expected} (where crapper reads LCOV)`)
    args.push('--use-existing-coverage')
  } else {
    args.push('--no-coverage')
  }
  for (const dir of ['apps/desktop', 'apps/mobile/runtime', 'packages', 'scripts']) args.push('-s', dir)
  const { stdout } = run(ctx, python, args)
  writeFileSync(raw(ctx, 'crapper.raw.jsonl'), stdout)
  if (existsSync(resolve(ctx.root, '.metrics/crap.edn'))) {
    writeFileSync(raw(ctx, 'crapper.raw.edn'), readFileSync(resolve(ctx.root, '.metrics/crap.edn')))
  }
  const functions = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((fn) => fn.language === 'typescript' || fn.language === 'javascript')
  const scores = functions.map((fn) => fn.crap ?? fn.complexity)
  const count = (min) => scores.filter((score) => score > min).length
  return {
    dimension: 'complexity',
    version: pinOf('crapper'),
    scope: ctx.coverage ? 'TS/JS functions, vitest unit coverage' : 'TS/JS functions, complexity only (no coverage)',
    metrics: {
      functions: functions.length,
      withCoverage: Boolean(ctx.coverage),
      over30: count(30),
      over8: count(8),
      maxCrap: Math.max(...scores),
      maxComplexity: Math.max(...functions.map((fn) => fn.complexity)),
    },
    findings: functions.filter((fn) => (fn.crap ?? fn.complexity) > 30).map((fn) => ({
      file: fn.path,
      line: fn.line,
      rule: 'crapper/crap-over-30',
      message: `${fn.name}: CRAP ${fn.crap ?? 'n/a'}, CC ${fn.complexity}, coverage ${fn.coverage ?? 'n/a'}%`,
    })),
  }
}

// repowise (pinned in tools.json) indexes the git history; only its churn numbers are used here. Run with no
// model (--no-prose), telemetry off, and no editor or git-hook setup: it writes only <root>/.repowise/.
const REPOWISE_ENV = {
  REPOWISE_OFFLINE: '1',
  DO_NOT_TRACK: '1',
  REPOWISE_TELEMETRY_DISABLED: '1',
  REPOWISE_SKIP_EDITOR_SETUP: '1',
  REPOWISE_NO_SAVE_KEY: '1',
  REPOWISE_NO_HINTS: '1',
}
const CHURN_SQL =
  'select file_path, churn_percentile, commit_count_total, commit_count_90d, is_hotspot from git_metadata'

async function repowise(ctx) {
  const venv = ensureVenv(ctx.root)
  const commits = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ctx.root, encoding: 'utf8' }))
  run(ctx, resolve(venv, 'bin/repowise'), [
    'init', '.', '-y', '--no-prose', '--mode', 'fast', '--no-workspace',
    '--no-hook', '--no-editor-setup', '--no-agents', '--no-codex', '--no-claude-md', '--no-distill-hook', '--no-onboarding',
    '--commit-limit', String(commits + 1),
    '-x', 'apps/desktop/preinstalled-apps/', '-x', 'apps/desktop/session-tooling/node-deps/', '-x', 'examples/',
  // Exit 2 = indexed, with the deep-history backfill (never run in --mode fast) still pending. Accept it only when
  // the index really reached HEAD.
  ], { env: REPOWISE_ENV, allowExit: [0, 2] })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.root, encoding: 'utf8' }).trim()
  const indexed = JSON.parse(readFileSync(resolve(ctx.root, '.repowise/state.json'), 'utf8')).last_sync_commit
  if (indexed !== head) throw new Error(`repowise index is at ${indexed}, not HEAD ${head}`)
  const dump = run(ctx, resolve(venv, 'bin/python'), ['-c', [
    'import json, sqlite3, sys',
    `rows = sqlite3.connect(sys.argv[1]).execute(${JSON.stringify(CHURN_SQL)}).fetchall()`,
    'print(json.dumps([dict(file=r[0], percentile=r[1], commits=r[2], commits90d=r[3], hotspot=bool(r[4])) for r in rows]))',
  ].join('\n'), resolve(ctx.root, '.repowise/wiki.db')])
  writeFileSync(raw(ctx, 'repowise.raw.json'), dump.stdout)
  const rows = JSON.parse(dump.stdout)
  return {
    dimension: 'churn',
    version: pinOf('repowise'),
    scope: `git history, ${commits} commits`,
    metrics: { filesScored: rows.length, hotspotFiles: rows.filter((row) => row.hotspot).length, commitsRead: commits },
    findings: rows.filter((row) => row.hotspot).map((row) => ({
      file: row.file,
      rule: 'repowise/hotspot',
      message: `churn percentile ${row.percentile.toFixed(3)}, ${row.commits} commits`,
    })),
  }
}

// Mutation testing on a few files: --stryker-files, else the files of the top hotspots. Stryker mutates the
// checkout in place (stryker.config.mjs), so it runs last and alone.
async function stryker(ctx) {
  const files = ctx.strykerFiles.length ? ctx.strykerFiles : [...new Set((ctx.hotspots ?? []).map((row) => row.file))]
  if (files.length === 0) throw new Error('stryker: no files to mutate (pass --stryker-files or run crapper and repowise first)')
  const report = resolve(ctx.root, 'reports/mutation/mutation.json')
  rmSync(report, { force: true })
  // Stryker's in-place restore rewrites files without their executable bit; put tracked modes back afterwards.
  const executables = execFileSync('git', ['ls-files', '-s'], { cwd: ctx.root, encoding: 'utf8' })
    .split('\n').filter((line) => line.startsWith('100755 ')).map((line) => line.split('\t')[1])
  let result
  try {
    result = run(ctx, bin(ctx, 'stryker'), ['run', 'stryker.config.mjs', '--mutate', files.join(',')], { allowExit: [0, 1] })
  } finally {
    for (const file of executables) {
      const path = resolve(ctx.root, file)
      if (existsSync(path) && !(statSync(path).mode & 0o111)) chmodSync(path, 0o755)
    }
  }
  if (!existsSync(report)) throw new Error(`stryker wrote no report (exit ${result.status})\n${(result.stdout + result.stderr).slice(-4000)}`)
  writeFileSync(raw(ctx, 'stryker.raw.json'), readFileSync(report))
  const counts = {}
  const findings = []
  for (const [file, { mutants }] of Object.entries(JSON.parse(readFileSync(report, 'utf8')).files)) {
    for (const mutant of mutants) {
      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1
      if (mutant.status === 'Survived' || mutant.status === 'NoCoverage') {
        findings.push({
          file: rel(ctx, file),
          line: mutant.location.start.line,
          rule: `stryker/${mutant.status}`,
          message: `${mutant.mutatorName}: ${String(mutant.replacement ?? '').slice(0, 120)}`,
        })
      }
    }
  }
  const killed = (counts.Killed ?? 0) + (counts.Timeout ?? 0)
  const valid = killed + (counts.Survived ?? 0) + (counts.NoCoverage ?? 0)
  return {
    dimension: 'mutation',
    version: versionOf('@stryker-mutator/core'),
    scope: `${files.length} files: ${ctx.strykerFiles.length ? '--stryker-files' : 'top hotspot files'}`,
    metrics: {
      score: valid ? Number(((killed / valid) * 100).toFixed(2)) : null,
      killed: counts.Killed ?? 0,
      timeout: counts.Timeout ?? 0,
      survived: counts.Survived ?? 0,
      noCoverage: counts.NoCoverage ?? 0,
      errors: (counts.CompileError ?? 0) + (counts.RuntimeError ?? 0),
      files,
    },
    findings,
  }
}

export const runners = { knip, jscpd, depcruise, 'type-coverage': typeCoverage, crapper, repowise, stryker }
export { run, bin, raw, rel, versionOf, execFileSync }
