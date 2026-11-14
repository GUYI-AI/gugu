#!/usr/bin/env node

// @@@focus-modality gate — every focus style goes through the input modality (apps/desktop/src/lib/focus-modality.ts).
//
// Chromium starts matching :focus-visible on an element focused by a click as soon as any key is pressed, a bare
// modifier included (screenshot hotkeys), so a plain `:focus-visible` rule draws a keyboard ring after a mouse click.
// Every rule must be written `:focus-visible:not([data-pointer-focus])`: the mark sits on the focused element itself
// (on an ancestor it would re-style the whole document on every mouse/keyboard switch).
// Tailwind's own `focus-visible:` variant is redefined in tailwind.css and needs nothing here; its `group-` / `peer-`
// compounds are rejected (see below), tailwind.css has spelled-out replacements.
//
// Allowed spellings besides the gated one: `:not(:focus-visible)` (the absence of focus) and
// `[data-pointer-focus]:focus-visible` (the global switch-off itself), and a text field's own focus state
// (`[data-slot=input-group-control]:focus-visible`). Comments are ignored.
// Out of scope: App documents (session/app-runtime/ui, preinstalled-apps) — they never get the modality attribute.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ROOTS = ['apps/desktop/src', 'packages']
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'build', 'coverage', 'out', 'tests'])
const SKIPPED_PATH_FRAGMENTS = ['/session/app-runtime/ui/', '/preinstalled-apps/']

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

/** The ungated `:focus-visible` occurrences in one file's text, as 1-based line numbers. */
export function ungatedFocusVisible(text, kind) {
  const source = kind === 'css' ? text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')) : stripComments(text)
  const lines = []
  const pattern = /:focus-visible/g
  for (let match; (match = pattern.exec(source)); ) {
    const before = source.slice(Math.max(0, match.index - 25), match.index)
    const after = source.slice(match.index + match[0].length, match.index + match[0].length + 30)
    if (/^:not\(\[data-pointer-focus\]\)/.test(after)) continue
    if (/:not\($/.test(before)) continue
    if (/\[data-pointer-focus\]$/.test(before)) continue
    // A text field's focus state (input-group's border) is its caret-like indicator: browsers report :focus-visible on
    // a click into a text field anyway, and the field must show it on click (same exemption as the global ring's).
    if (/input-group-control\]$/.test(before)) continue
    // JS reading the state (`el.matches(':focus-visible')`) is not a style.
    if (kind === 'ts' && /matches\(['"`]$/.test(before)) continue
    lines.push(source.slice(0, match.index).split('\n').length)
  }
  // Tailwind's `group-focus-visible:` / `peer-focus-visible:` compile to `:is(:where(.group):focus-visible… *)`. Blink reads
  // the `*` inside `:is()` as the whole subtree, so the element carrying the mark re-styles everything below it whenever
  // the mark changes. Use the spelled-out variants in styles/tailwind.css (`group-row-kbd-focus:` and friends).
  if (kind === 'ts') for (let match, compound = /(?<![\w-])(?:group|peer)-focus-visible[/:]/g; (match = compound.exec(source)); ) lines.push(source.slice(0, match.index).split('\n').length)
  return lines
}

function collect(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) collect(path.join(dir, entry.name), found)
    } else if (/\.(css|tsx?|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      const full = path.join(dir, entry.name)
      if (!SKIPPED_PATH_FRAGMENTS.some((fragment) => full.includes(fragment))) found.push(full)
    }
  }
  return found
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = []
  for (const root of ROOTS) {
    for (const file of collect(path.join(repoRoot, root))) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes(':focus-visible')) continue
      for (const line of ungatedFocusVisible(text, file.endsWith('.css') ? 'css' : 'ts')) failures.push(`${path.relative(repoRoot, file)}:${line}`)
    }
  }
  if (failures.length > 0) {
    console.error(`focus-modality: ${failures.length} :focus-visible rule(s) bypass the input modality — write :focus-visible:not([data-pointer-focus]) (see apps/desktop/src/lib/focus-modality.ts):`)
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
  }
  console.log('focus-modality: every :focus-visible rule goes through the input modality')
}
