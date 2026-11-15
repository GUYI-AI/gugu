// owner 2026-11-12 选 A:「添加连接 → 账号」没登成功就把这条新连接拿掉;判不准的不删。
import { describe, expect, it, vi } from 'vitest'
import { dropIfNeverSignedIn } from './drop-unsigned-connection'

function client(status: unknown, removeOk = true) {
  return {
    refreshAuthStatus: vi.fn(async () => status),
    removeConnection: vi.fn(async () => (removeOk ? { success: true } : { success: false, error: { message: 'no' } })),
  } as unknown as Parameters<typeof dropIfNeverSignedIn>[0] & {
    refreshAuthStatus: ReturnType<typeof vi.fn>
    removeConnection: ReturnType<typeof vi.fn>
  }
}

const input = { providerId: 'claude', connectionId: 'new-account' }

describe('dropIfNeverSignedIn', () => {
  it('removes the new connection when it reads signed out', async () => {
    const c = client({ success: true, data: { kind: 'unauthenticated' } })
    expect(await dropIfNeverSignedIn(c, input)).toBe('removed')
    expect(c.removeConnection).toHaveBeenCalledWith(input)
  })

  it.each([
    ['signed in (the window closed after the sign-in finished)', { success: true, data: { kind: 'authenticated', account: 'me@example.test' } }],
    ['unknown', { success: true, data: { kind: 'unknown' } }],
    ['the reading failed', { success: false, error: { message: 'offline' } }],
  ])('keeps it when %s', async (_label, status) => {
    const c = client(status)
    expect(await dropIfNeverSignedIn(c, input)).toBe('kept')
    expect(c.removeConnection).not.toHaveBeenCalled()
  })

  it('says so when the host refuses the removal', async () => {
    const c = client({ success: true, data: { kind: 'unauthenticated' } }, false)
    await expect(dropIfNeverSignedIn(c, input)).rejects.toThrow('could not remove')
  })
})
