import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ available: false, backend: 'gnome_libsecret' }))
vi.mock('electron', () => ({ app: { isReady: () => true }, safeStorage: {
  isEncryptionAvailable: () => state.available, getSelectedStorageBackend: () => state.backend,
  encryptString: (text: string) => Buffer.from(`sealed:${text}`), decryptString: (sealed: Buffer) => sealed.toString().slice('sealed:'.length) } }))
import { systemVaultKeyProtector } from '../../../apps/desktop/electron/password-vault/system-keys'
import { passwordSaveFailure } from '../../../apps/desktop/electron/password-vault/save-error'
afterEach(() => { vi.unstubAllGlobals(); state.available = false; state.backend = 'gnome_libsecret' })
const on = (platform: string) => vi.stubGlobal('process', Object.create(process, { platform: { value: platform }, type: { value: 'browser' } }))

describe('the vault key under the system protection of each platform', () => {
  it('preserves an actionable storage reason without trying to encrypt', async () => {
    on('darwin')
    const error = await systemVaultKeyProtector(async () => {}).wrap(Buffer.alloc(32), 'test-binding').catch(error => error)
    expect(error).toMatchObject({ code: 'SYSTEM_STORAGE_UNAVAILABLE' })
    expect(passwordSaveFailure(error)).toMatchObject({ status: 'unavailable', error: '这台电脑的系统密码存储不可用，请稍后重试。' })
  })

  it('wraps and unwraps on Windows (DPAPI) and on Linux with a keyring, bound to its purpose', async () => {
    state.available = true
    for (const platform of ['win32', 'linux']) {
      on(platform)
      const keys = systemVaultKeyProtector(null), key = Buffer.alloc(32, 7)
      const wrapped = await keys.wrap(key, 'binding-a')
      expect(await keys.unwrap(wrapped, 'binding-a')).toEqual(key)
      await expect(keys.unwrap(wrapped, 'binding-b')).rejects.toMatchObject({ code: 'CANNOT_UNLOCK' })
    }
  })

  it('refuses Linux without a keyring (basic_text) loudly, never stores the key readable', async () => {
    state.available = true; state.backend = 'basic_text'
    on('linux')
    await expect(systemVaultKeyProtector(null).wrap(Buffer.alloc(32), 'b')).rejects.toMatchObject({ code: 'SYSTEM_STORAGE_UNAVAILABLE' })
  })

  it('reveals plaintext only on macOS, after the owner check; Windows and Linux never do', async () => {
    state.available = true
    const verify = vi.fn(async () => {})
    on('darwin'); await expect(systemVaultKeyProtector(verify).verifyPerson()).resolves.toBeUndefined()
    expect(verify).toHaveBeenCalledOnce()
    for (const platform of ['win32', 'linux']) {
      on(platform); await expect(systemVaultKeyProtector(verify).verifyPerson()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    }
    expect(verify).toHaveBeenCalledOnce()
  })
})
