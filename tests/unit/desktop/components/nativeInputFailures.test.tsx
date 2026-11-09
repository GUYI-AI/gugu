// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { createReactHarness } from '../../../support/testHarness'
import { useRejectedSessionInputCommands } from '../../../../apps/desktop/src/hooks/useRejectedSessionInputCommands'
import { state, changed, EMPTY } from '../../../../apps/desktop/src/lib/sessionInputOutboxBridge'
import { openSessionInputStorage, SessionInputOutbox, type SessionInputStorage } from '../../../../apps/desktop/src/lib/sessionInputOutbox'
import { SessionInputAdmissionError } from '@gugu/core/shared/sessionInputAdmission'
const visible = vi.hoisted(() => new Map<string | number, string>())
vi.mock('sonner', () => {
  let sequence = 0
  const show = (title: string, options?: { id?: string }) => { const id = options?.id ?? ++sequence; visible.set(id, title); return id }
  return { toast: Object.assign(show, { error: show, info: show, success: show, warning: show, dismiss: (id: string | number) => visible.delete(id) }) }
})
vi.mock('../../../../apps/desktop/src/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: () => null }))
let ids: string[], queue: SessionInputOutbox, storage: SessionInputStorage, accept: boolean
let ui: ReturnType<typeof createReactHarness>
function TranscriptActions() {
  const commands = useRejectedSessionInputCommands('task')
  return <>{ids.map(id => <section key={id} data-input={id}>
    <button onClick={() => commands.onRetrySend?.(id)}>retry</button>
    <button onClick={() => commands.onDiscardSend?.(id)}>discard</button>
  </section>)}</>
}
const waitVisible = (count: number) => act(async () => vi.waitFor(() => expect(visible.size).toBe(count)))
const click = (index: number, button = 0) => act(async () => ui.container.querySelectorAll<HTMLButtonElement>(`[data-input="${ids[index]}"] button`)[button].click())
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange); visible.clear(); accept = false
  storage = await openSessionInputStorage(new IDBFactory())
  queue = new SessionInputOutbox('owner', storage, async () => { if (!accept) throw new SessionInputAdmissionError('refused', 'rejected') }, () => true,
    rows => { if (rows) state().rows = rows; changed() })
  Object.assign(state(), { accountId: 'owner', queue: Promise.resolve(queue), valid: () => true })
  ids = []
  for (let i = 0; i < 2; i++) ids.push((await queue.enqueue({ deviceId: null, sessionId: 'task', text: 'same words' })).id)
  await queue.flush(); await queue.flush(); state().rows = await queue.list()
  ui = createReactHarness(); await ui.render(<TranscriptActions />)
})
afterEach(() => { ui.cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Object.assign(state(), { accountId: null, queue: null, rows: EMPTY, valid: () => false }); changed() })
it('native retry success clears only that input after another failed retry', async () => {
  const put = vi.spyOn(storage, 'put').mockRejectedValue(new Error('write failed'))
  await click(0); await click(1); await waitVisible(2)
  await click(0); expect(visible.size).toBe(2)
  put.mockRestore(); accept = true
  await click(0); await waitVisible(1)
  expect((await queue.list()).map(input => input.id)).toEqual([ids[1]])
})

it('an explicit discard retires its earlier failure without deleting another input', async () => {
  const remove = vi.spyOn(storage, 'writeBatch').mockRejectedValue(new Error('delete failed'))
  await click(0, 1); await waitVisible(1)
  remove.mockRestore()
  await click(0, 1); await waitVisible(0)
  expect((await queue.list()).map(input => input.id)).toEqual([ids[1]])
})

it('retrying a later input never attributes an earlier input storage failure to it', async () => {
  for (const input of await queue.list()) await storage.put({ ...input, admission: 'uncertain', failure: { code: 'send-failed', message: 'offline' } })
  state().rows = await queue.list(); await act(async () => changed())
  const originalPut = storage.put.bind(storage)
  const put = vi.spyOn(storage, 'put').mockImplementation(input => input.id === ids[0] ? Promise.reject(new Error('earlier input write failed')) : originalPut(input))
  accept = true
  await click(1)
  await act(async () => vi.waitFor(async () => expect((await queue.list()).map(input => input.id)).toEqual([ids[0]])))
  expect(visible.size).toBe(0)
  expect(put).not.toHaveBeenCalledWith(expect.objectContaining({ id: ids[0] }))
  await expect(queue.retry(ids[1])).resolves.toBeUndefined()
})
