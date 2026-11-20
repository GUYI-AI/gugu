import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'
import { createPhoneHostAuthGate } from '../../../../apps/desktop/src/lib/phoneHostAuthGate'

const native = vi.hoisted(() => ({ authSession: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => "android", isPluginAvailable: () => true }, registerPlugin: () => native }))
import { phoneHostGetSession, phoneHostRefreshSession, phoneHostSignOut, phoneHostSessionForHandoff, forgetClosedPhoneHostSession } from '../../../../apps/desktop/src/lib/phoneHostAuth'
import { publishRendererSession } from '../../../../apps/desktop/src/lib/sessionPublication'

describe('Android host refresh authority', () => {
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
  it('waits for an in-flight renderer operation before transferring ownership', async () => {
    const ordered = createPhoneHostAuthGate()
    const events: string[] = []
    let finish!: () => void
    const first = ordered(async () => { events.push('refresh'); await new Promise<void>((resolve) => { finish = resolve }); events.push('persisted') })
    const second = ordered(async () => { events.push('configure') })
    await vi.waitFor(() => expect(events).toEqual(['refresh']))
    finish()
    await Promise.all([first, second])
    expect(events).toEqual(['refresh', 'persisted', 'configure'])
  })

  it('a failed operation does not strand the ownership gate', async () => {
    const ordered = createPhoneHostAuthGate()
    await expect(ordered(async () => { throw new Error('offline') })).rejects.toThrow('offline')
    await expect(ordered(async () => 'ready')).resolves.toBe('ready')
  })

  it('uses the host session on boot and never asks the SDK to refresh it', async () => {
    const session = { access_token: 'new', refresh_token: 'rotated', user: { id: 'owner' } } as Session
    native.authSession.mockResolvedValueOnce({ available: true, session })
    const fallback = vi.fn()
    await expect(phoneHostGetSession(fallback)).resolves.toEqual({ data: { session }, error: null })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('does not fall back to a competing refresher when an active host fails', async () => {
    native.authSession.mockRejectedValueOnce(new Error('host offline'))
    const fallback = vi.fn()
    await expect(phoneHostRefreshSession('old', fallback)).rejects.toThrow('host offline')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back only when no native host owns the session', async () => {
    native.authSession.mockResolvedValueOnce({ available: false, session: null })
    const fallback = vi.fn(async () => ({ data: { session: null }, error: null }))
    await phoneHostGetSession(fallback)
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('returns the actual rotated session revoked by sign-out for exact storage cleanup', async () => {
    const session = { access_token: 'latest', refresh_token: 'latest-rotation', user: { id: 'owner' } } as Session
    native.authSession.mockResolvedValueOnce({ available: true, session, signedOut: true })
    const fallback = vi.fn()
    await expect(phoneHostSignOut(fallback)).resolves.toEqual({ error: null, signedOutSession: session })
    expect(fallback).not.toHaveBeenCalled()
  })
})
