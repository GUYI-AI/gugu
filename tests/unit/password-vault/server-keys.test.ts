import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

// #2481 2B: a gugu server wraps vault keys with its own key file (the server shim's safeStorage). Stand in for that shim.
const backend = vi.hoisted(() => ({ name: 'gugu_session_host_file_key' }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend.name,
    encryptString: (text: string) => Buffer.from(text, 'utf8').reverse(),
    decryptString: (data: Buffer) => Buffer.from(data).reverse().toString('utf8'),
  },
}))
const { serverVaultKeyProtector } = await import('../../../apps/desktop/electron/server/password-vault-keys')

afterEach(() => { vi.unstubAllEnvs(); backend.name = 'gugu_session_host_file_key' })

describe('server vault keys', () => {
  it('wraps and unwraps a key for its binding on a gugu server', async () => {
    vi.stubEnv('GUGU_SERVER_MODE', '1')
    const keys = serverVaultKeyProtector(), key = randomBytes(32)
    const wrapped = await keys.wrap(key, 'vault|owner|device')
    expect(wrapped).not.toContain(key.toString('base64'))
    expect((await keys.unwrap(wrapped, 'vault|owner|device')).equals(key)).toBe(true)
    await expect(keys.unwrap(wrapped, 'vault|owner|other')).rejects.toMatchObject({ code: 'CANNOT_UNLOCK' })
  })

  it('nobody sits at a server: the person-only reveal is refused', async () => {
    vi.stubEnv('GUGU_SERVER_MODE', '1')
    await expect(serverVaultKeyProtector().verifyPerson()).rejects.toMatchObject({ code: 'CANNOT_UNLOCK' })
  })

  it('refuses outside a gugu server, and on any storage backend but the server key file', async () => {
    const key = randomBytes(32)
    await expect(serverVaultKeyProtector().wrap(key, 'b')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    vi.stubEnv('GUGU_SERVER_MODE', '1')
    backend.name = 'basic_text'
    await expect(serverVaultKeyProtector().wrap(key, 'b')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})
