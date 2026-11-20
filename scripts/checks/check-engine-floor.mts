#!/usr/bin/env node
// @@@engine-floor check - the built renderer may not call an engine API newer than ENGINE_FLOOR (scripts/build/engine-floor.mts)
// unless engine-polyfills.ts supplies it or that use is recorded as tolerated (it tests for the API first, is lowered at
// build time, or an older engine only loses polish). build.target lowers syntax only; APIs arrive unlowered, often from
// dependencies (pdf.js brought URL.parse and Promise.try), so this reads the shipped files, not the sources.
// Usage: node scripts/checks/check-engine-floor.mts [dist-dir]   (default: dist, the output of pnpm build:renderer:ci)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { ENGINE_APIS, ENGINE_FLOOR } from '../build/engine-floor.mts'

const dist = process.argv[2] ?? 'dist'
const files: string[] = []
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(js|css|html)$/.test(name)) files.push(path)
  }
}
walk(dist)
if (files.length === 0) throw new Error(`[engine-floor] no built files under ${dist}; run pnpm build:renderer:ci first`)

const above = Object.entries(ENGINE_APIS)
  .filter(([, api]) => !api.polyfill && (api.chrome > ENGINE_FLOOR.chrome || api.safari > ENGINE_FLOOR.safari))
const failures: string[] = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const [name, api] of above) {
    const hits = text.match(api.pattern)?.length ?? 0
    if (hits === 0 || api.tolerated?.some(use => use.chunk.test(basename(file)))) continue
    failures.push(`${relative(dist, file)}: ${name} ×${hits} (Chrome ${api.chrome} / Safari ${api.safari})`)
  }
}

if (failures.length > 0) {
  console.error(`[engine-floor] floor is Chrome ${ENGINE_FLOOR.chrome} / Safari ${ENGINE_FLOOR.safari}, but the bundle calls newer APIs:`)
  for (const line of failures) console.error('  ' + line)
  console.error('Raise ENGINE_FLOOR, or, if the use tests for the API first or only loses polish, record it under `tolerated` with the reason.')
  process.exit(1)
}
console.log(`[engine-floor] ${files.length} built files call nothing newer than Chrome ${ENGINE_FLOOR.chrome} / Safari ${ENGINE_FLOOR.safari} beyond the tolerated uses`)
