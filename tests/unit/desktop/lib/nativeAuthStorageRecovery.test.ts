// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  value: null as string | null,
  get: vi.fn(async () => ({ value: native.value })),
  write: vi.fn(async ({ value }: { value: string }) => { native.value = value }),
  remove: vi.fn(async () => {}),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => native,
}))
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({ auth: {}, realtime: {} }),
}))
const session = { access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', user: { id: 'owner-a' } }
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); window.localStorage.clear(); native.value = null })

describe('native auth storage recovery keeps the authority boundary', () => {
  it('does not import WebView plaintext or publish a boot candidate after a native read failure', async () => {
    window.localStorage.setItem('sb-main', JSON.stringify(session))
    const error = Object.assign(new Error('storage unavailable'), { code: 'auth_storage_recovery_required' })
    native.get.mockRejectedValue(error)
    const { mainAuthSessionStorage } = await import('../../../../apps/desktop/src/lib/supabase')
    await expect(mainAuthSessionStorage.storage.getItem('sb-main')).rejects.toBe(error)
    expect(window.localStorage.getItem('sb-main')).toBe(JSON.stringify(session))
    expect(native.write).not.toHaveBeenCalled()
    expect(mainAuthSessionStorage.getState().bootCandidate).toBeNull()
    native.get.mockResolvedValue({ value: null })
  })
  it('keeps WebView evidence until the secure migration write succeeds', async () => {
    window.localStorage.setItem('sb-main', JSON.stringify(session))
    native.get.mockResolvedValue({ value: null })
    native.write.mockRejectedValueOnce(new Error('durable write failed'))
    const { mainAuthSessionStorage } = await import('../../../../apps/desktop/src/lib/supabase')
    await expect(mainAuthSessionStorage.storage.getItem('sb-main')).rejects.toThrow('durable write failed')
    expect(window.localStorage.getItem('sb-main')).toBe(JSON.stringify(session))
    expect(mainAuthSessionStorage.getState().bootCandidate).toBeNull()
    expect(native.value).toBeNull()
  })
  it('a committed retirement envelope blocks stale WebView credentials', async () => {
    window.localStorage.setItem('sb-main', JSON.stringify(session))
    native.get.mockResolvedValue({ value: JSON.stringify({ state: 'RETIRED_EMPTY' }) })
    const { mainAuthSessionStorage } = await import('../../../../apps/desktop/src/lib/supabase')
    await expect(mainAuthSessionStorage.storage.getItem('sb-main')).resolves.toBeNull()
    expect(window.localStorage.getItem('sb-main')).toBeNull()
    expect(native.write).not.toHaveBeenCalled()
  })
})
