import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { ROOTS, analyze, violations, validateDebt } = require('../../../scripts/checks/native-history-reads.cjs')
const repo = join(import.meta.dirname, '../../..')
const roots: string[] = []
function fixture(text: string, path = `${ROOTS[0]}/example.ts`): string {
  const root = mkdtempSync(join(tmpdir(), 'history-read-guard-'))
  roots.push(root)
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('bounded history read guard (#2062)', () => {
  it('runs in source lint and accepts only frozen legacy functions on the current tree', () => {
    expect(violations(repo)).toEqual([])
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    expect(pkg.scripts['lint:source']).toContain('node scripts/checks/native-history-reads.cjs')
    expect(() => validateDebt(require('../../../scripts/checks/native-history-reads-debt.json'))).not.toThrow()
  })
  it.each([
    "import {readFile as load} from 'node:fs/promises'; await load(path)",
    "const { readFile: load } = require('fs'); load(path)",
    "import fs from 'node:fs'; fs['readFileSync'](path)",
    "const load = fs.readFile; load(path)",
    "await handle.readFile()",
    "createReadStream(path, {highWaterMark: 65536})",
    "reader.readFromStart(sink)",
    "reader.readSnapshot(sink)",
    "for(let offset=0; offset < fileSize; offset += count) { await file.read(buffer,0,65536,offset) }",
    "while (offset < info.size) { await file.read(buffer,0,65536,offset) }",
    "while (true) { const {bytesRead} = await file.read(buffer); if (!bytesRead) break }",
  ])('rejects unbounded read syntax: %s', source => {
    expect(violations(fixture(source))).not.toEqual([])
  })
  it('ignores comments, literals and small fixture readers; does not scan authentication configuration', () => {
    expect(analyze('reader.ts', '// readFile(path)\nconst help = "createReadStream(path)"')).toEqual([])
    expect(violations(fixture('readFile(path)', `${ROOTS[0]}/example.test.ts`))).toEqual([])
    expect(violations(fixture('readFile(path)', 'apps/mobile/Authentication.ts'))).toEqual([])
  })
  it('accepts bounded positional short reads', () => {
    expect(violations(fixture('while (read < bytes.length) { read += await source.read(bytes,read,bytes.length-read,start+read) }'))).toEqual([])
  })
  it('guards the desktop preview bridge as a native-history entry point', () => {
    const path = 'apps/desktop/electron/sessionpage/local-session-preview.ts'
    expect(violations(fixture('await fs.readFile(nativePath)', path))).toHaveLength(1)
  })
  it('resolves aliases in the call site lexical scope', () => {
    const source = "import {readFile as load} from 'node:fs/promises'; function helper(){const load=bounded; load(small)}; await load(path)"
    expect(analyze('reader.ts', source).map((row: { rule: string }) => row.rule)).toEqual(['readFile'])
    expect(analyze('reader.ts', "function helper(){const readFile=bounded}; fs.readFile(path)")).toHaveLength(1)
    expect(analyze('reader.ts', 'function a(){const load=fs.readFile;load(path)}; function b(){const load=bounded;load(path)}')).toHaveLength(1)
  })
  it('rejects increased counts, changed fingerprints, unknown keys and duplicate debt entries', () => {
    const debt: [string, number][] = require('../../../scripts/checks/native-history-reads-debt.json')
    const [key, count] = debt[0]
    expect(() => validateDebt([[key, count + 1]])).toThrow('only shrink')
    expect(() => validateDebt([[key + 'changed', count]])).toThrow('only shrink')
    expect(() => validateDebt([[key, count], [key, count]])).toThrow('only shrink')
    expect(() => validateDebt([[key, count - 1]])).not.toThrow()
    expect(() => validateDebt(debt.slice(1))).not.toThrow()
  })
  it('does not let copied legacy functions multiply the exemption', () => {
    const path = `${ROOTS[0]}/sources/claude-jsonl.ts`
    const text = readFileSync(join(repo, path), 'utf8')
    expect(violations(fixture(text + text, path))).not.toEqual([])
  })
  it('changing a grandfathered function changes its fingerprint', () => {
    const a = analyze('source.ts', 'async function load() { return readFile(path) }')[0]
    const b = analyze('source.ts', 'async function load() { const extra = 1; return readFile(path) }')[0]
    expect(a.key).not.toBe(b.key)
  })
})
