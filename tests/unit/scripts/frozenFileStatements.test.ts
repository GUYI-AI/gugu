import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { BASELINE, countStatements, run } from '../../../scripts/checks/frozen-file-statements.mts'

const FILE = 'apps/desktop/src/components/Frozen.tsx'
const ORIGINAL = `import { useState } from 'react'

export function Frozen({ name }: { name: string }) {
  const [open, setOpen] = useState(false)
  if (!name) return null
  return (
    <div>
      <span>{name}</span>
      <button onClick={() => setOpen(!open)}>toggle</button>
    </div>
  )
}
`

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A synthetic tree whose baseline is the original file's own count, so the cases do not depend on the real files. */
function tree(source: string, baseline: Record<string, number> | null = { [FILE]: countStatements(FILE, ORIGINAL) }, base?: Record<string, number>) {
  const root = mkdtempSync(join(tmpdir(), 'gugu-frozen-'))
  roots.push(root)
  mkdirSync(dirname(join(root, FILE)), { recursive: true })
  writeFileSync(join(root, FILE), source)
  if (baseline) {
    mkdirSync(dirname(join(root, BASELINE)), { recursive: true })
    writeFileSync(join(root, BASELINE), JSON.stringify(baseline))
  }
  const args = ['--root', root]
  if (base) {
    writeFileSync(join(root, 'base-baseline.json'), JSON.stringify(base))
    args.push('--base-baseline', join(root, 'base-baseline.json'))
  }
  const errors: string[] = []
  const code = run(args, { log: () => {}, error: line => errors.push(line) })
  return { code, errors }
}

describe('frozen source files are measured in statements, not lines', () => {
  test('the unchanged file passes', () => {
    expect(tree(ORIGINAL).code).toBe(0)
  })

  test('one more statement fails', () => {
    const grown = ORIGINAL.replace('  if (!name) return null\n', '  if (!name) return null\n  console.info(name)\n')
    const { code, errors } = tree(grown)
    expect(code).toBe(1)
    expect(errors[0]).toContain('Frozen source grew')
  })

  test('one more statement still fails when lines are squeezed so the line count does not change', () => {
    const squeezed = ORIGINAL.replace('  const [open, setOpen] = useState(false)\n  if (!name) return null\n',
      '  const [open, setOpen] = useState(false); if (!name) return null\n  console.info(name)\n')
    expect(squeezed.split('\n').length).toBe(ORIGINAL.split('\n').length)
    expect(tree(squeezed).code).toBe(1)
  })

  test('splitting a statement over several lines for readability passes', () => {
    const split = ORIGINAL.replace('  const [open, setOpen] = useState(false)\n', '  const [\n    open,\n    setOpen,\n  ] = useState(false)\n')
    expect(split.split('\n').length).toBeGreaterThan(ORIGINAL.split('\n').length)
    expect(tree(split).code).toBe(0)
  })

  test('one more JSX element fails', () => {
    const grown = ORIGINAL.replace('      <span>{name}</span>\n', '      <span>{name}</span>\n      <hr />\n')
    expect(tree(grown).code).toBe(1)
  })

  test('a baseline entry whose file is gone is an error, not a pass', () => {
    const { code, errors } = tree(ORIGINAL, { [FILE]: 99, 'apps/desktop/src/Gone.tsx': 1 })
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('Gone.tsx')
  })

  test('a missing baseline file is an error', () => {
    expect(tree(ORIGINAL, null).code).toBe(1)
  })
})

describe('a PR may not raise its own limit', () => {
  const limit = countStatements(FILE, ORIGINAL)
  const grown = ORIGINAL.replace('  if (!name) return null\n', '  if (!name) return null\n  console.info(name)\n')

  test('growing the file and raising the baseline to match fails against the base baseline', () => {
    const { code, errors } = tree(grown, { [FILE]: limit + 1 }, { [FILE]: limit })
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('Frozen limit raised')
  })

  test('lowering the baseline is allowed', () => {
    const shrunk = ORIGINAL.replace('  if (!name) return null\n', '')
    expect(tree(shrunk, { [FILE]: limit - 1 }, { [FILE]: limit }).code).toBe(0)
  })

  test('removing an entry or freezing another file is allowed', () => {
    expect(tree(ORIGINAL, { [FILE]: limit }, { [FILE]: limit, 'apps/desktop/src/Old.tsx': 10 }).code).toBe(0)
    expect(tree(ORIGINAL, { [FILE]: limit }, {}).code).toBe(0)
  })

  test('a missing base baseline file is an error', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-frozen-'))
    roots.push(root)
    mkdirSync(dirname(join(root, FILE)), { recursive: true })
    writeFileSync(join(root, FILE), ORIGINAL)
    mkdirSync(dirname(join(root, BASELINE)), { recursive: true })
    writeFileSync(join(root, BASELINE), JSON.stringify({ [FILE]: limit }))
    expect(run(['--root', root, '--base-baseline', join(root, 'nope.json')], { log: () => {}, error: () => {} })).toBe(1)
  })
})
