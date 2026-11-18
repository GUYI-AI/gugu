import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assistantRulesSeedToCarry } from '../../../scripts/gugu-server/assistant-rules-seed.mts'

// #1931 The server package carries the main build's copy of the assistant App's rules, never fetches it again: the arm64
// packaging container gets the scripts and the built output, with no source tree and no node_modules (the Beta of
// 2026-11-12 broke on `node_modules/tsx` there).

const SHA = 'a'.repeat(64)
let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

function packagingRoot(pin: { version: string | null; sha256: string | null }, seed?: Record<string, unknown>) {
  root = mkdtempSync(join(tmpdir(), 'server-rules-seed-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'assistant-rules-seed.json'), JSON.stringify({ app: 'gugu-assistant', bundle: pin.version ? 'x.zip' : null, ...pin }))
  if (seed) {
    mkdirSync(join(root, 'assistant-rules-seed', 'rules'), { recursive: true })
    writeFileSync(join(root, 'assistant-rules-seed', 'seed.json'), JSON.stringify(seed))
  }
  return root
}

describe('assistantRulesSeedToCarry', () => {
  it('carries no copy when nothing is pinned, even with a leftover folder of an earlier pin', () => {
    expect(assistantRulesSeedToCarry(packagingRoot({ version: null, sha256: null }))).toBeNull()
    expect(assistantRulesSeedToCarry(packagingRoot({ version: null, sha256: null }, { app: 'gugu-assistant', version: '1.0.0', sha256: SHA }))).toBeNull()
  })

  it('carries the main build\'s copy of the pinned version', () => {
    const at = packagingRoot({ version: '1.2.0', sha256: SHA }, { app: 'gugu-assistant', version: '1.2.0', sha256: SHA })
    expect(assistantRulesSeedToCarry(at)).toBe(join(at, 'assistant-rules-seed'))
  })

  it('stops a pinned build that has no copy, rather than shipping without the rules', () => {
    expect(() => assistantRulesSeedToCarry(packagingRoot({ version: '1.2.0', sha256: SHA }))).toThrow(/holds no copy of its rules/)
  })

  it('stops on a copy of another pin', () => {
    expect(() => assistantRulesSeedToCarry(packagingRoot({ version: '1.2.0', sha256: SHA }, { app: 'gugu-assistant', version: '1.1.0', sha256: SHA })))
      .toThrow(/not the pinned gugu-assistant@1.2.0/)
    expect(() => assistantRulesSeedToCarry(packagingRoot({ version: '1.2.0', sha256: SHA }, { app: 'gugu-assistant', version: '1.2.0', sha256: 'b'.repeat(64) })))
      .toThrow(/not the pinned/)
  })

  it('the packaging script carries it and no longer runs anything from node_modules for it', () => {
    const script = readFileSync(join(__dirname, '../../../scripts/build/build-gugu-server.mjs'), 'utf8')
    expect(script).toContain('assistantRulesSeedToCarry(root)')
    expect(script).not.toMatch(/node_modules', 'tsx'|assistant-rules-seed\.ts'\)/)
  })
})
