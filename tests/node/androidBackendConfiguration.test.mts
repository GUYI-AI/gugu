import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeAndroidBackend } from '../../scripts/build/prepare-android-backend.mts'

const anon = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature`
const environment = { VITE_SUPABASE_URL: 'https://fixture.invalid', VITE_SUPABASE_ANON_KEY: anon }
test('Android packages only the same validated renderer public backend and deletes stale output on failure', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gugu-android-backend-'))
  const output = path.join(root, 'apps/mobile/android/app/build/generated/account-closure-backend/assets/GuguBackend.json')
  try {
    writeAndroidBackend(root, { ...environment, SUPABASE_SERVICE_ROLE_KEY: 'must-not-ship', REFRESH_TOKEN: 'must-not-ship' })
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { version: 1, supabaseUrl: environment.VITE_SUPABASE_URL, anonKey: anon })
    assert.throws(() => writeAndroidBackend(root, { ...environment, GUGU_SUPABASE_URL: 'https://other.invalid' }))
    assert.equal(existsSync(output), false)
    assert.throws(() => writeAndroidBackend(root, { ...environment, VITE_SUPABASE_ANON_KEY: 'header.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature' }))
    assert.equal(existsSync(output), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
