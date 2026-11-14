import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const sources = ['apps/desktop/src', 'packages'].flatMap(function walk(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : walk(path)
    return /\.css(\.ts)?$/.test(entry.name) ? [path] : []
  })
})

// The phone keyboard resizes the layout viewport on every open and close.
describe('a phone keyboard resize restyles only what reads the new height', () => {
  // @@@tour-height-container: a flipped @media re-collects its whole bundled sheet, @property and @font-face included,
  // which restyles the document and relayouts every text run. Height thresholds go through size containers instead.
  it('has no viewport-height media query in app styles', () => {
    expect(sources.length).toBeGreaterThan(100)
    const offenders = sources.flatMap((path) => [...readFileSync(join(root, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@media[^{]*\b(?:height|aspect-ratio)\b[^{]*/g)]
      .map((match) => `${path}: ${match[0].trim()}`))
    expect(offenders).toEqual([])
  })

  // @@@shell-geometry-not-inherited: only the shell reads its geometry, so changing it must not restyle the page under it.
  it('keeps the phone shell geometry out of inheritance', () => {
    const css = readFileSync(join(root, 'apps/desktop/src/mobile/PhoneViewportShell.css'), 'utf8')
    for (const name of ['--phone-viewport-height', '--phone-viewport-top'])
      expect(css).toMatch(new RegExp(`@property ${name} \\{[^}]*inherits: false;`))
  })
})
