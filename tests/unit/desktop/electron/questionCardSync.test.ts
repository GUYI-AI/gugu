import { afterEach, expect, it, vi } from 'vitest'
import type { Settlement } from '@gugu/session-core/session-record/contract'
import type { QuestionCardResult } from '@gugu/core/shared/ui/taskCardModels'
import { createQuestionCardSync } from '../../../../apps/desktop/electron/sessionpage/question-card-sync'

const auth = { userId: 'owner', accessToken: 'token' }
const answers = [{ selected: ['yes'] }, { selected: [], skipped: true as const }]
const item = (extra: Partial<Settlement> = {}): Settlement => ({
  itemId: 'agent-question:message', kind: 'question', title: 'Choose', state: 'resolved', optionId: JSON.stringify(answers),
  resolvedBy: 'owner', resolvedAt: 1, origin: { source: 'agent-question', payload: {
    publicCard: { chatId: 'room', messageId: 'message', ownerUserId: 'owner' },
  } }, ...extra,
})
const stops: Array<() => void> = []
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers() })
function rig(records = [{ sessionId: 'session', item: item() }]) {
  const deps = { auth: vi.fn(async () => auth as typeof auth | null), records: () => records,
    publish: vi.fn(async (_auth: typeof auth, _id: string, result: QuestionCardResult) => ({ ...result, at: '2026-11-19T14:00:00Z' })),
    committed: vi.fn((record: { sessionId: string; item: Settlement }) => {
      const payload = record.item.origin!.payload as { publicCard: { synced?: boolean } }
      payload.publicCard.synced = true
    }), failed: vi.fn(),
  } satisfies Parameters<typeof createQuestionCardSync>[0]
  const sync = createQuestionCardSync(deps)
  stops.push(sync.stop)
  return { deps, sync, records }
}

it('replays a durable resolved card after restart with its exact answers and original message id', async () => {
  const { deps, sync, records } = rig()
  await sync.wake()
  expect(deps.publish).toHaveBeenCalledExactlyOnceWith(auth, 'message', { state: 'answered', answers })
  expect(deps.committed).toHaveBeenCalledExactlyOnceWith(records[0])
  expect(deps.failed).not.toHaveBeenCalled()
})

it.each([
  ['withdrawn', { state: 'cancelled', optionId: null }],
  ['discuss', { state: 'resolved', optionId: 'discuss' }],
] as const)('publishes %s without fabricated answers', async (state, extra) => {
  const { deps, sync } = rig([{ sessionId: 'session', item: item(extra) }])
  await sync.wake()
  expect(deps.publish).toHaveBeenCalledWith(auth, 'message', { state })
})

it('keeps failures in the durable outbox and retries after the backend returns', async () => {
  vi.useFakeTimers()
  const { deps, sync } = rig()
  deps.publish.mockRejectedValueOnce(new Error('offline'))
  await sync.wake()
  expect(deps.committed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(deps.publish).toHaveBeenCalledTimes(2)
  expect(deps.committed).toHaveBeenCalledTimes(1)
})

it('does not claim a conflicting first result as synchronized', async () => {
  const { deps, sync } = rig()
  deps.publish.mockResolvedValueOnce({ state: 'answered', at: 'now', answers: [{ selected: ['different'] }] })
  await sync.wake()
  expect(deps.committed).not.toHaveBeenCalled()
  expect(deps.failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'Question card already has different answers' }))
})

it('leaves pending, private, already synchronized and another owner’s records alone', async () => {
  const records = [item({ state: 'pending', optionId: null }), item({ origin: { source: 'agent-question', payload: {} } }),
    item({ origin: { source: 'agent-question', payload: { publicCard: { chatId: 'room', messageId: 'done', ownerUserId: 'owner', synced: true } } } }),
    item({ origin: { source: 'agent-question', payload: { publicCard: { chatId: 'room', messageId: 'other', ownerUserId: 'another' } } } }),
  ].map(item => ({ sessionId: 'session', item }))
  const { deps, sync } = rig(records)
  await sync.wake()
  expect(deps.publish).not.toHaveBeenCalled()
})

it('rechecks authentication before publishing and never sends through a replacement account', async () => {
  const { deps, sync } = rig()
  deps.auth.mockResolvedValueOnce(auth).mockResolvedValueOnce({ userId: 'another', accessToken: 'different' })
  await sync.wake()
  expect(deps.publish).not.toHaveBeenCalled()
})

it('notices settlement while a pass is running without creating parallel RPCs', async () => {
  const { deps, sync, records } = rig([{ sessionId: 'session', item: item({ state: 'pending', optionId: null }) }])
  const first = sync.wake()
  records[0].item = item()
  const second = sync.wake()
  await Promise.all([first, second])
  expect(deps.publish).toHaveBeenCalledTimes(1)
})
