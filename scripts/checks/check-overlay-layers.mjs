#!/usr/bin/env node

// @@@overlay-layers gate (#3857) — an overlay's stacking comes from the layer scale in apps/desktop/src/styles/tokens.css
// (--z-modal, --z-menu, --z-popover, --z-settings, …) plus `useUiPopupZIndex` (one above the surface it was opened
// from). A hard-coded overlay-level number (z-50, z-[51], zIndex: 500) is right on the page it was written for and wrong
// the moment the same component opens inside a sheet, a settings page or another dialog: owner, repeatedly,
// 「弹窗被遮住了没法选」.
//
// Fails on an overlay-level hard-coded z-index — Tailwind `z-50` / `z-[N]` and numeric `zIndex: N` / `z-index: N`
// with N ≥ 50 (small numbers order things inside one component and stay allowed) — in a file not in the baseline
// (check-overlay-layers-baseline.json), or more of them than the baseline allows. Each baseline entry carries its reason.
// The baseline only shrinks: a count above what the file has must be lowered, an entry with none left deleted.
// Comments are ignored. Tests are out of scope.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ROOTS = ['apps/desktop/src', 'packages/session-ui/src']
const BASELINE = 'scripts/checks/check-overlay-layers-baseline.json'
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'build', 'coverage', 'out', 'tests', '__screenshots__'])
const FLOOR = 50

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const TW_FIXED = /(?<![\w\-[])-?z-(\d+)(?![\w\-.])/g
const TW_ARBITRARY = /(?<![\w-])-?z-\[(\d+)\]/g
const NUMERIC = /\bz-?index\s*:\s*['"]?(\d+)['"]?/gi

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** Overlay-level hard-coded z-indices in one file's text: [{ line, text }]. */
export function hardCodedLayers(text) {
  const source = stripComments(text)
  const found = []
  for (const pattern of [TW_FIXED, TW_ARBITRARY, NUMERIC]) {
    for (const match of source.matchAll(pattern)) {
      if (Number(match[1]) >= FLOOR) found.push({ line: lineOf(source, match.index), text: match[0] })
    }
  }
  return found.sort((a, b) => a.line - b.line)
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* sourceFiles(path.join(dir, entry.name))
    } else if (/\.(tsx?|mts|css)$/.test(entry.name) && !/\.(test|spec)\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield path.join(dir, entry.name)
    }
  }
}

export function check(root = repoRoot) {
  const baseline = JSON.parse(readFileSync(path.join(root, BASELINE), 'utf8'))
  const problems = []
  const seen = new Set()
  for (const base of ROOTS) {
    for (const file of sourceFiles(path.join(root, base))) {
      const rel = path.relative(root, file).split(path.sep).join('/')
      const hits = hardCodedLayers(readFileSync(file, 'utf8'))
      const allowed = baseline[rel]
      if (allowed) seen.add(rel)
      if (!hits.length) {
        if (allowed) problems.push(`${rel}: baseline allows ${allowed.count} but the file has none — delete its entry`)
        continue
      }
      if (!allowed) {
        for (const hit of hits) problems.push(`${rel}:${hit.line}: hard-coded overlay z-index \`${hit.text}\` — use a layer token (z-[var(--z-modal)], var(--z-menu), …) or useUiPopupZIndex`)
      } else if (hits.length > allowed.count) {
        problems.push(`${rel}: ${hits.length} hard-coded overlay z-indices, baseline allows ${allowed.count} (${hits.map((h) => `${h.line}:${h.text}`).join(', ')})`)
      } else if (hits.length < allowed.count) {
        problems.push(`${rel}: baseline allows ${allowed.count} but the file has ${hits.length} — lower the count`)
      }
    }
  }
  for (const rel of Object.keys(baseline)) {
    if (!seen.has(rel) && !rel.startsWith('$')) problems.push(`${rel}: in the baseline but not found — delete its entry`)
    else if (!rel.startsWith('$') && !(baseline[rel].reason ?? '').trim()) problems.push(`${rel}: baseline entry without a reason`)
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = check()
  if (problems.length) {
    console.error(`check-overlay-layers: ${problems.length} problem(s)\n${problems.map((p) => `  · ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log('check-overlay-layers: ok')
}
