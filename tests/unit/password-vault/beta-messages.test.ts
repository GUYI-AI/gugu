import { describe, expect, it, vi } from 'vitest'
import type { PasswordSaveRequest } from '../../../packages/core/src/shared/passwordBetaProtocol'

const asked: { conversationId: string; request: Record<string, unknown>; options: { signal?: AbortSignal; refuse?: (answer: unknown) => string | null } }[] = []
let sessionExists = true
vi.mock('../../../apps/desktop/electron/session/main/core/asks', () => ({
  ask: (conversationId: string, request: Record<string, unknown>, options: { signal?: AbortSignal }) => {
    asked.push({ conversationId, request, options })
    return new Promise(resolve => options.signal?.addEventListener('abort', () => resolve('withdrawn')))
  },
}))
vi.mock('../../../apps/desktop/electron/session/main/core/session-timeline/service', () => ({ readSessionRow: () => sessionExists ? { id: 'x' } : null }))
const { openPasswordRequest, endPasswordRequest } = await import('../../../apps/desktop/electron/password-vault/beta-messages')

const view: PasswordSaveRequest = { kind: 'save', requestId: '55555555-5555-4555-8555-555555555555', origin: 'https://github.com', agent: 'agent-1', agentName: '研究助理',
  sessionTitle: '注册账号', sessionId: 'session-1', deviceId: 'device-1', expiresAt: Date.now() + 60_000, hint: 'A GitHub fine-grained token' }

describe('a password request waits as an Ask of its session', () => {
  it('opens in the Agent session with the card as payload, refuses answers from surfaces without the card, and ends with the outcome', async () => {
    await openPasswordRequest(view)
    expect(asked).toHaveLength(1)
    const [{ conversationId, request, options }] = asked
    expect(conversationId).toBe('session-1')
    expect(request).toMatchObject({ itemId: view.requestId, kind: 'permission', detail: 'A GitHub fine-grained token', origin: { source: 'password', payload: view } })
    expect(options.refuse?.({ optionId: 'open', by: 'phone' })).toMatch(/computer/)
    expect(options.signal?.aborted).toBe(false)
    endPasswordRequest(view.requestId)
    expect(options.signal?.aborted).toBe(true)
  })
  it('a session that is gone fails loudly, so the request is dropped', async () => {
    sessionExists = false
    await expect(openPasswordRequest({ ...view, requestId: '66666666-6666-4666-8666-666666666666' })).rejects.toThrow('password_notification_unavailable')
    sessionExists = true
  })
})
