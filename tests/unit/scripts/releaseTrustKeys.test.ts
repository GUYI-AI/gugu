import { generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { RELEASE_REQUIRED_APPS, RELEASE_TRUST_TABLE, releaseTrustGate, releaseTrustKeyProblems } from '../../../scripts/build/release-trust-keys.mts'

// #1931 A release build stops when the client's release trust table has no usable key for an App it requires (the
// assistant's), so a table with only the slot can never ship unnoticed. Keys here are made in the test.
const ed25519 = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
const entry = (over: Record<string, unknown> = {}) => ({ id: 'gugu-assistant-release-1', appId: 'gugu-assistant', sourceRepo: 'GUYI-AI/gugu-assistant', publicKey: ed25519(), ...over })
const table = (...keys: unknown[]) => ({ schemaVersion: 1, keys })

const repoRoot = path.resolve(__dirname, '../../..')
const dirs: string[] = []
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }) })
function rootWith(contents: unknown | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-release-trust-'))
  dirs.push(dir)
  if (contents !== null) {
    fs.mkdirSync(path.dirname(path.join(dir, RELEASE_TRUST_TABLE)), { recursive: true })
    fs.writeFileSync(path.join(dir, RELEASE_TRUST_TABLE), typeof contents === 'string' ? contents : JSON.stringify(contents))
  }
  return dir
}

describe('release trust keys gate', () => {
  test('the assistant is required, and the table it reads is the one the client ships', () => {
    expect(RELEASE_REQUIRED_APPS).toContain('gugu-assistant')
    expect(fs.existsSync(path.join(repoRoot, RELEASE_TRUST_TABLE))).toBe(true)
  })

  test('passes with a usable, unrevoked Ed25519 key for every App the table names', () => {
    expect(releaseTrustKeyProblems(table(entry()))).toEqual([])
    expect(releaseTrustKeyProblems(table(entry({ revoked: true }), entry({ id: 'gugu-assistant-release-2' })))).toEqual([])
    expect(releaseTrustKeyProblems(table(entry({ revoked: false })))).toEqual([])
  })

  test('stops on a slot left empty, a revoked or unusable key, a missing entry, another App\'s empty slot, a bad table', () => {
    expect(releaseTrustKeyProblems(table(entry({ publicKey: null })))).toEqual([
      'gugu-assistant: key slot gugu-assistant-release-1 is still empty — put its Ed25519 public key (SPKI PEM) in before a release',
    ])
    expect(releaseTrustKeyProblems(table(entry({ revoked: true })))).toEqual(['gugu-assistant: none of its keys is a usable, unrevoked Ed25519 public key'])
    expect(releaseTrustKeyProblems(table(entry({ publicKey: rsa() })))).toEqual(['gugu-assistant: none of its keys is a usable, unrevoked Ed25519 public key'])
    expect(releaseTrustKeyProblems(table(entry({ publicKey: 'not a key' })))).toEqual(['gugu-assistant: none of its keys is a usable, unrevoked Ed25519 public key'])
    expect(releaseTrustKeyProblems(table())).toEqual(['gugu-assistant: the table has no entry for it'])
    expect(releaseTrustKeyProblems(table(entry(), entry({ id: 'radar-1', appId: 'radar', publicKey: null })))).toEqual([
      'radar: key slot radar-1 is still empty — put its Ed25519 public key (SPKI PEM) in before a release',
    ])
    expect(releaseTrustKeyProblems({ keys: [] })).toEqual(['the release trust table is not { schemaVersion: 1, keys: [...] }'])
  })

  test('as a build runs it: from the repository root, a missing or broken table stops it too', () => {
    expect(releaseTrustGate(rootWith(table(entry())))).toEqual([])
    expect(releaseTrustGate(rootWith(null))).toEqual([`release trust table ${RELEASE_TRUST_TABLE} is missing`])
    expect(releaseTrustGate(rootWith('{'))).toEqual([`release trust table ${RELEASE_TRUST_TABLE} is not JSON`])
    expect(releaseTrustGate(rootWith(table(entry({ publicKey: null }))))[0]).toMatch(/^release trust table .*release-keys\.json: gugu-assistant: key slot/)
  })

  test('`pnpm release:trust-keys` exits non-zero on the slot and zero with a key', () => {
    const script = path.join(repoRoot, 'scripts/build/release-trust-keys.mts')
    const slot = spawnSync(process.execPath, [script], { cwd: rootWith(table(entry({ publicKey: null }))), encoding: 'utf8' })
    expect(slot.status).toBe(1)
    expect(slot.stderr).toContain('still empty')
    const keyed = spawnSync(process.execPath, [script], { cwd: rootWith(table(entry())), encoding: 'utf8' })
    expect(keyed.status).toBe(0)
  })
})
