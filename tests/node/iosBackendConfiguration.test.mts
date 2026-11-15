import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveIOSBackend, writeIOSBackend } from '../../scripts/build/prepare-ios-backend.mts'

const anon = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature`
const environment = { VITE_SUPABASE_URL: 'https://fixture.invalid', VITE_SUPABASE_ANON_KEY: anon }
const temporary = (work: (root: string) => void) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gugu-ios-backend-'))
  try { work(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('packages exactly the renderer public fields and no account or administrative credentials', () => temporary(root => {
  writeIOSBackend(root, { ...environment, SUPABASE_SERVICE_ROLE_KEY: 'must-not-ship', REFRESH_TOKEN: 'must-not-ship' })
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'apps/mobile/ios/App/App/HostRuntime/GuguBackend.json'), 'utf8')),
    { version: 1, supabaseUrl: environment.VITE_SUPABASE_URL, anonKey: anon })
}))
test('selected registry wins over stale shell values using the renderer resolver', () => temporary(root => {
  mkdirSync(path.join(root, '.envs'))
  writeFileSync(path.join(root, '.envs/shared-test.env'), [
    'VITE_SUPABASE_URL=https://selected.invalid', `VITE_SUPABASE_ANON_KEY=${anon}`,
    'GUGU_SUPABASE_URL=https://selected.invalid', `GUGU_SUPABASE_ANON_KEY=${anon}`,
  ].join('\n'))
  assert.equal(resolveIOSBackend(root, { ...environment, GUGU_DB_TARGET: 'shared-test' }).supabaseUrl, 'https://selected.invalid')
}))
test('rejects split renderer/native environments and removes a stale generated configuration', () => temporary(root => {
  writeIOSBackend(root, environment)
  assert.throws(() => writeIOSBackend(root, { ...environment, GUGU_SUPABASE_URL: 'https://other.invalid' }))
  assert.equal(existsSync(path.join(root, 'apps/mobile/ios/App/App/HostRuntime/GuguBackend.json')), false)
}))
test('rejects privileged and human tokens, insecure URLs and retired implicit env files', () => temporary(root => {
  for (const role of ['service_role', 'authenticated']) {
    const key = `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`
    assert.throws(() => resolveIOSBackend(root, { ...environment, VITE_SUPABASE_ANON_KEY: key }))
  }
  for (const url of ['http://fixture.invalid', 'https://user:pass@fixture.invalid', 'https://fixture.invalid?secret=x']) {
    assert.throws(() => resolveIOSBackend(root, { ...environment, VITE_SUPABASE_URL: url }))
  }
  writeFileSync(path.join(root, '.env.local'), 'VITE_SUPABASE_URL=https://stale.invalid')
  assert.throws(() => resolveIOSBackend(root, environment))
}))
