import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * No static import path leads from the renderer's ipc module back to itself. One did (ipc → machine clients →
 * localization → the language runtime → device preferences → settings client → ipc): a test that mocked ipc with a factory
 * awaiting the original deadlocked on it, and the settings browser tests hung at start. Dynamic `import()` is not an
 * edge here (it runs later, never during the module graph's evaluation).
 */
const ALIASES: Record<string, string> = {
  '@/': 'apps/desktop/src/',
  '@main/': 'apps/desktop/electron/session/main/',
  '@shared/': 'apps/desktop/src/session/shared/',
  '@renderer/': 'apps/desktop/src/session/renderer/',
}
const START = 'apps/desktop/src/session/renderer/lib/ipc.ts'
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm

function resolve(from: string, spec: string): string | null {
  let base: string | null = null
  if (spec.startsWith('.')) base = normalize(join(dirname(from), spec))
  else for (const [alias, path] of Object.entries(ALIASES)) if (spec.startsWith(alias)) { base = path + spec.slice(alias.length); break }
  if (!base) return null
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function pathBackTo(start: string): string[] | null {
  const seen = new Map<string, string>()
  const queue: string[] = []
  const visit = (file: string) => {
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const next = resolve(file, match[1]!)
      if (!next) continue
      if (next === start) return file
      if (!seen.has(next)) { seen.set(next, file); queue.push(next) }
    }
    return null
  }
  let found = visit(start)
  while (!found && queue.length > 0) found = visit(queue.shift()!)
  if (!found) return null
  const chain = [start]
  for (let file: string | undefined = found; file && file !== start; file = seen.get(file)) chain.push(file)
  return [...chain, start]
}

describe('the renderer ipc module', () => {
  it('has no static import cycle back to itself', () => {
    expect(pathBackTo(START)).toBeNull()
  })
})
