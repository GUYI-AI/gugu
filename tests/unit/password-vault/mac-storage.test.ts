import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ available: false }))
vi.mock('electron', () => ({ app: { isReady: () => true }, safeStorage: { isEncryptionAvailable: () => state.available } }))
import { macVaultKeyProtector } from '../../../apps/desktop/electron/password-vault/mac'
import { passwordSaveFailure } from '../../../apps/desktop/electron/password-vault/save-error'
afterEach(() => vi.unstubAllGlobals())
describe('system password storage unavailable', () => {
  it('preserves an actionable storage reason without trying to encrypt', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' }, type: { value: 'browser' } }))
    const keys = macVaultKeyProtector(async () => {})
    const error = await keys.wrap(Buffer.alloc(32), 'test-binding').catch(error => error)
    expect(error).toMatchObject({ code: 'SYSTEM_STORAGE_UNAVAILABLE' })
    expect(passwordSaveFailure(error)).toMatchObject({ status: 'unavailable', error: '这台电脑的系统密码存储不可用，请稍后重试。' })
  })
})
