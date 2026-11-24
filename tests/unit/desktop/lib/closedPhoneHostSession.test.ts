import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'

const native = vi.hoisted(() => ({ authSession: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true }, registerPlugin: () => native }))
import { phoneHostRefreshSession, phoneHostSessionForHandoff, forgetClosedPhoneHostSession } from '../../../../apps/desktop/src/lib/phoneHostAuth'
import { publishRendererSession } from '../../../../apps/desktop/src/lib/sessionPublication'

afterEach(() => { native.authSession.mockReset(); publishRendererSession('TEST_CLEANUP', null) })

describe('closed phone owner handoff isolation', () => {
  it('forgets only closed A memory while preserving B rotated handoff credentials', async () => {
    const b = { access_token: 'b0', refresh_token: 'br0', user: { id: crypto.randomUUID() } } as Session
    const rotated = { ...b, access_token: 'b1', refresh_token: 'br1' }
    publishRendererSession('TEST_SIGN_IN', b)
    try {
      native.authSession.mockResolvedValueOnce({ available: true, session: rotated })
      await phoneHostRefreshSession(b.refresh_token, vi.fn())
      forgetClosedPhoneHostSession(crypto.randomUUID())
      expect(phoneHostSessionForHandoff(b)).toEqual(rotated)
    } finally { publishRendererSession('TEST_CLEANUP', null) }
  })
  it('a late original-owner refresh cannot make a deleted owner eligible for handoff again', async () => {
    const a = { access_token: 'a0', refresh_token: 'ar0', user: { id: crypto.randomUUID() } } as Session
    let finish!: (value: unknown) => void
    native.authSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    publishRendererSession('TEST_SIGN_IN', a)
    try {
      const pending = phoneHostRefreshSession(a.refresh_token, vi.fn())
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      forgetClosedPhoneHostSession(a.user.id)
      finish({ available: true, session: { ...a, refresh_token: 'late-a1' } })
      await pending
      expect(() => phoneHostSessionForHandoff(a)).toThrow(expect.objectContaining({ code: 'closure_recovery_required' }))
    } finally { publishRendererSession('TEST_CLEANUP', null) }
  })
})
