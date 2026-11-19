import { afterEach, describe, expect, it, vi } from 'vitest'
import { openFixture, type FixtureDb } from '@tooling/utils/db'
import { EncryptedAppSecretsStore } from './secrets/encrypted-app-secrets-store'
import { createDesktopClosureService } from '../../../account-closure/service'
import { readDesktopClosureRetainedItems } from '../../../account-closure/retained-items'

vi.mock('@main/db/client', () => ({ db: {}, sqlite: {} }))
vi.mock('electron', () => ({ safeStorage: {} }))
let fixture: FixtureDb | undefined
afterEach(() => { fixture?.close(); fixture = undefined })
const scope = { ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', localOperationId: 'opaque-operation' }
describe('desktop closure uses the existing protected database store', () => {
  it('reports retained categories from actual presence and excludes its own custody records', async () => {
    fixture = await openFixture('empty')
    fixture.sqlite.exec('DELETE FROM sessions; DELETE FROM projects; DELETE FROM app_settings; DELETE FROM provider_accounts; DELETE FROM app_secrets')
    const absent = { logs: false, sharedCache: false, runtimeLedger: false }
    fixture.sqlite.prepare('INSERT INTO app_secrets(key,secret) VALUES(?,?)').run('account-closure:operation', 'sealed-custody')
    expect(readDesktopClosureRetainedItems(fixture.sqlite, absent)).toEqual([])
    fixture.sqlite.prepare('INSERT INTO projects(id,name,path) VALUES(?,?,?)').run('private-project', 'private-name', '/private/path')
    fixture.sqlite.prepare('INSERT INTO sessions(id,project_id) VALUES(?,?)').run('private-session', 'private-project')
    fixture.sqlite.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run('private-setting', 'private-value')
    fixture.sqlite.prepare('INSERT INTO app_secrets(key,secret) VALUES(?,?)').run('provider-secret', 'private-secret')
    const retained = readDesktopClosureRetainedItems(fixture.sqlite, absent)
    expect(retained).toEqual(['workspace-records', 'unattributed-session-history', 'device-settings', 'provider-credentials'])
    expect(JSON.stringify(retained)).not.toContain('private')
    expect(readDesktopClosureRetainedItems(fixture.sqlite, { ...absent, logs: true })).toContain('unattributed-diagnostic-logs')
  })
  it.each(['unavailable', 'basic_text'] as const)('rejects %s without writing a plaintext receipt or installation binding', async mode => {
    fixture = await openFixture('empty')
    const encrypt = vi.fn(() => Buffer.from('encrypted'))
    const safe = { isEncryptionAvailable: () => mode !== 'unavailable', getSelectedStorageBackend: () => 'basic_text', encryptString: encrypt,
      decryptString: () => { throw new Error('Unexpected decrypt') } } as unknown as typeof import('electron').safeStorage
    const store = new EncryptedAppSecretsStore(fixture.db, safe, 'linux')
    const host = createDesktopClosureService({ profileBinding: '/isolated/profile', secrets: store, currentOwner: async () => scope.ownerId,
      stopOwner: async () => {}, steps: [], retained: async () => [] })
    await expect(host.native.receipt.put(scope, 'private-receipt')).rejects.toMatchObject({ code: 'closure_storage_unavailable' })
    expect(fixture.sqlite.prepare('SELECT * FROM app_secrets').all()).toEqual([])
    expect(encrypt).not.toHaveBeenCalled()
  })
  it('persists only cipher bytes and reads the receipt through the same native store', async () => {
    fixture = await openFixture('empty')
    const protectedValues = new Map<string, string>()
    const safe = { isEncryptionAvailable: () => true,
      encryptString(value: string) { const sealed = `cipher-${protectedValues.size}`; protectedValues.set(sealed, value); return Buffer.from(sealed) },
      decryptString(bytes: Buffer) { const value = protectedValues.get(bytes.toString()); if (!value) throw new Error('Invalid encrypted record'); return value },
    } as unknown as typeof import('electron').safeStorage
    const store = new EncryptedAppSecretsStore(fixture.db, safe, 'darwin')
    const host = createDesktopClosureService({ profileBinding: '/isolated/profile', secrets: store, currentOwner: async () => scope.ownerId,
      stopOwner: async () => {}, steps: [], retained: async () => [] })
    await host.native.receipt.put(scope, 'private-receipt')
    const rows = fixture.sqlite.prepare('SELECT secret FROM app_secrets').all() as { secret: string }[]
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain('private-receipt')
    expect(rows.every(row => Buffer.from(row.secret, 'base64').toString().startsWith('cipher-'))).toBe(true)
    expect(await host.native.receipt.get(scope)).toBe('private-receipt')
  })
})
