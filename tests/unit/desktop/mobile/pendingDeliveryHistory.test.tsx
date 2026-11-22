// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { PendingPrompt } from '@gugu/session-chat-ui'
import { splitActiveTurn } from '@/components/assistant-ui/transcript-sync'
import { usePendingDeliveryHistory } from '@/components/session-watch/usePendingDeliveryHistory'

const rpc = vi.hoisted(() => ({ history: vi.fn() }))
vi.mock('@/components/session-watch/sessionpage-rpc', () => ({ fetchOlder: rpc.history }))

const stored = (seq: number): TranscriptTurn => ({ id: `session:turn:s${seq}`, seq, initiator: 'user',
  items: [], outcome: { kind: 'done', reason: 'end_turn' } })
const running = (seq: number): TranscriptTurn => ({ id: `session:turn:${seq}`, seq, initiator: 'user', items: [
  { kind: 'message', id: 'new-client-input', seq: 0, role: 'user', text: 'new input', _meta: { guguClientMessageId: 'client-input' } },
] })
const unknown: PendingPrompt = { id: 'old-unknown', text: 'old delivered message', held: true, delivery: { state: 'unknown' } }

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.clearAllMocks() })

it('keeps new input and live replies active while older timeline pages resolve an unknown receipt, and through the commit', async () => {
  let resolveHistory!: (value: { epoch: string; turns: TranscriptTurn[]; hasOlder: boolean }) => void
  rpc.history.mockReturnValueOnce(new Promise(resolve => { resolveHistory = resolve }))
  const active = running(3), page = [stored(100), stored(101)]
  let result!: ReturnType<typeof usePendingDeliveryHistory>
  function Fixture({ turns }: { turns: readonly TranscriptTurn[] }) {
    result = usePendingDeliveryHistory({ deviceId: 'host', sessionId: 'session',
      local: false, enabled: true, ready: true, hasOlder: true, turns, inputs: [unknown] })
    return null
  }
  await harness.render(<Fixture turns={[...page, active]} />)
  await vi.waitFor(() => expect(rpc.history).toHaveBeenCalledOnce())
  expect(splitActiveTurn(result.turns).active).toBe(active)
  await act(async () => { resolveHistory({ epoch: 'e', turns: [stored(1), stored(2)], hasOlder: false }) })
  expect(result.turns.map(turn => turn.id)).toEqual(['session:turn:s1', 'session:turn:s2', ...page.map(turn => turn.id), active.id])
  expect(splitActiveTurn(result.turns).active).toBe(active)

  const updated: TranscriptTurn = { ...active, items: [...active.items,
    { kind: 'message', id: 'live-reply', seq: 1, role: 'assistant', text: 'live answer' }] }
  await harness.render(<Fixture turns={[...page, updated]} />)
  expect(splitActiveTurn(result.turns).active).toBe(updated)
  expect(splitActiveTurn(result.turns).active?.items.map(item => item.id)).toEqual(['new-client-input', 'live-reply'])
  expect(rpc.history).toHaveBeenCalledOnce()

  const committed: TranscriptTurn = { ...stored(102), items: updated.items }
  await harness.render(<Fixture turns={[...page, committed]} />)
  expect(result.turns.map(turn => turn.seq)).toEqual([1, 2, 100, 101, 102])
  expect(splitActiveTurn(result.turns).active).toBeNull()
  expect(result.turns.at(-1)?.items).toBe(updated.items)
  expect(result.turns.some(turn => turn.id === active.id)).toBe(false)
})
