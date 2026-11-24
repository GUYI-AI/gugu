// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: { rpc } }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: vi.fn(), unsubscribePrivateUserEventBus: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: null }) }))

const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')
const { myAssistant } = await import('../../../../apps/desktop/src/lib/myAssistant')
const OWNER = 'binding-owner'

beforeEach(() => {
  followRendererSession('SIGNED_OUT', null)
  queryClient.clear()
  localStorage.clear()
  rpc.mockReset()
})

describe('assistant App binding reads across upgrades', () => {
  it('does not display a kept provision-role identity as a current account binding', async () => {
    localStorage.setItem(`gugu.readModel.v1:${OWNER}`, JSON.stringify({ old: {
      key: ['myAssistant', OWNER], at: Date.now(),
      value: { agentId: 'former-role-agent', provisionDeviceId: 'former-host' },
    } }))
    followRendererSession('SIGNED_IN', OWNER)
    expect(myAssistant.peek().state).toBe('unknown')
    rpc.mockResolvedValue({ data: [{ agent_user_id: 'bound-agent', device_id: 'current-host' }], error: null })
    await expect(myAssistant.fetch()).resolves.toEqual({ agentId: 'bound-agent', provisionDeviceId: 'current-host' })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('my_app_agent', { p_app_id: 'gugu-assistant' })
  })

  it('reports an unreadable binding as an error, not an absent assistant', async () => {
    followRendererSession('SIGNED_IN', OWNER)
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' }, status: 403 })
    await expect(queryClient.fetchQuery({ ...myAssistant.options(myAssistant.key()!), retry: false }))
      .rejects.toMatchObject({ message: 'permission denied', code: '42501', status: 403 })
    expect(myAssistant.peek().state).toBe('error')
  })
})
