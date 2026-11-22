// E-1: the assistant identity read keeps what the failure was (code, status: a network blip or a fixed refusal), and a
// blip is asked again before the reading is an error (the panel path's retry the parent had).
import { beforeEach, expect, it, vi } from 'vitest'

const answers = vi.hoisted(() => [] as Array<{ data: unknown; error: { code: string; message: string } | null; status: number }>)
const asked = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  identityDb: { from: () => ({ select: () => ({ eq: () => ({ eq: async () => { asked(); return answers.shift() } }) }) }) },
}))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: () => ({}), unsubscribePrivateUserEventBus: () => undefined }))

const { myAssistant } = await import('../../../../apps/desktop/src/lib/myAssistant')
const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')

beforeEach(() => { queryClient.clear(); followRendererSession('SIGNED_IN', 'owner'); asked.mockClear(); answers.length = 0 })

it('keeps code and status on the error, after asking again', async () => {
  vi.useFakeTimers()
  const blip = { data: null, error: { code: 'ENOTFOUND', message: 'network' }, status: 0 }
  answers.push(blip, blip, blip)
  const read = myAssistant.fetch().catch((error: unknown) => error)
  await vi.runAllTimersAsync()
  expect(await read).toMatchObject({ code: 'ENOTFOUND', status: 0 })
  expect(asked).toHaveBeenCalledTimes(3)
  vi.useRealTimers()
})
