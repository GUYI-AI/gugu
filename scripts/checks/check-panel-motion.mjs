#!/usr/bin/env node

// @@@panel-motion gate — a panel's size moves on screen in one place: PanelTrack (apps/desktop/src/session/renderer/lib/
// layout/panel-track.ts). It lays each box out once at each end of a move and plays every frame as transforms; a transition
// of a layout property re-lays the page out in every frame instead (11-21 baseline: 12–16 dropped frames per list fold).
//
// Fails on:
//  · a CSS or Tailwind transition of a layout property (width, height, min/max-*, left/right/top/bottom/inset, margin,
//    padding, flex / flex-basis, grid-template-*), and on `transition-all` / `transition: all` (which includes them);
//  · a framer-motion importer that is not in the baseline (check-panel-motion-baseline.json): each entry is a file not yet
//    moved onto the track, or motion that is not a panel's size (with its reason). The baseline only shrinks: an entry
//    that no longer imports framer-motion must be deleted from it.
// Comments are ignored. Tests are out of scope.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ROOT = 'apps/desktop/src'
const BASELINE = 'scripts/checks/check-panel-motion-baseline.json'
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'build', 'coverage', 'out', 'tests'])

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const LAYOUT = String.raw`(?:min-|max-)?(?:width|height)|left|right|top|bottom|inset|margin(?:-\w+)?|padding(?:-\w+)?|flex(?:-basis)?|grid-template-\w+|all`
const CSS_TRANSITION = new RegExp(String.raw`transition(?:-property)?\s*:\s*([^;}]*)`, 'g')
const CSS_LAYOUT = new RegExp(String.raw`(?:^|[\s,])(?:${LAYOUT})(?=[\s,]|$)`)
// Tailwind: `transition-all`, `transition-[width,…]`, `transition-[margin-left]`; `transition-[--x]` / colors / transform are fine.
const TW_TRANSITION = /(?<![\w-])transition-(all|\[[^\]]*\])(?![\w-])/g
const TW_LAYOUT = new RegExp(String.raw`^\[(?:[^\]]*[,_])?(?:${LAYOUT})(?:[,_][^\]]*)?\]$`)
const MOTION_IMPORT = /from\s+['"](?:framer-motion|motion\/react)['"]/

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** Layout-property transitions in one file's text, as 1-based line numbers. */
export function layoutTransitions(text, kind) {
  const source = kind === 'css' ? text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')) : stripComments(text)
  const lines = []
  for (let match; (match = CSS_TRANSITION.exec(source)); ) {
    // `transition: transform 200ms, opacity 200ms` lists properties first in each comma part.
    const properties = match[1].split(',').map((part) => part.trim().split(/\s+/)[0])
    if (properties.some((property) => CSS_LAYOUT.test(` ${property} `))) lines.push(lineOf(source, match.index))
  }
  if (kind === 'ts') {
    for (let match; (match = TW_TRANSITION.exec(source)); ) {
      if (match[1] === 'all' || TW_LAYOUT.test(match[1])) lines.push(lineOf(source, match.index))
    }
  }
  return lines
}

function collect(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) collect(path.join(dir, entry.name), found)
    } else if (/\.(css|tsx?|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path.join(dir, entry.name))
  }
  return found
}

function main() {
  const baseline = JSON.parse(readFileSync(path.join(repoRoot, BASELINE), 'utf8'))
  const transitions = new Map()
  const importers = new Set()
  for (const full of collect(path.join(repoRoot, ROOT))) {
    const file = path.relative(repoRoot, full).split(path.sep).join('/')
    const text = readFileSync(full, 'utf8')
    const kind = file.endsWith('.css') ? 'css' : 'ts'
    const lines = layoutTransitions(text, kind)
    if (lines.length) transitions.set(file, lines)
    if (kind === 'ts' && MOTION_IMPORT.test(stripComments(text))) importers.add(file)
  }
  const failures = []
  for (const [file, lines] of transitions) {
    const allowed = baseline.layoutTransitions[file]?.count ?? 0
    if (lines.length > allowed) failures.push(`${file}:${lines.join(',')}: transition of a layout property (${lines.length}, baseline ${allowed}) — move the panel onto PanelTrack, or animate transform / opacity`)
  }
  for (const [file, { count }] of Object.entries(baseline.layoutTransitions)) {
    const found = transitions.get(file)?.length ?? 0
    if (found < count) failures.push(`${file}: ${found} layout transition(s), baseline says ${count} — lower it in ${BASELINE}`)
  }
  for (const file of importers) if (!(file in baseline.motionImporters)) failures.push(`${file}: imports framer-motion — a panel's size moves on PanelTrack; other motion needs an entry with its reason in ${BASELINE}`)
  for (const file of Object.keys(baseline.motionImporters)) if (!importers.has(file)) failures.push(`${file}: no longer imports framer-motion — delete its entry in ${BASELINE}`)
  if (failures.length) {
    console.error(`check-panel-motion: ${failures.length} problem(s)\n` + failures.map((failure) => `  ${failure}`).join('\n'))
    process.exit(1)
  }
  console.log(`check-panel-motion: ok (${transitions.size} files with baselined layout transitions, ${importers.size} framer-motion importers)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
