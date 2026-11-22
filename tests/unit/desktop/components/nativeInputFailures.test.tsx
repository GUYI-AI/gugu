// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useRejectedSessionInputCommands } from '../../../../apps/desktop/src/hooks/useRejectedSessionInputCommands'
import { enqueueSessionInput, state } from '../../../../apps/desktop/src/lib/outbox/kinds/sessionInput'
import { installSessionInputOutbox, memoryOutboxStorage, settle, type InstalledSessionInputs } from '../../../helpers/sessionInputOutbox'
import { SessionInputAdmissionError } from '@gugu/core/shared/sessionInputAdmission'
const visible = vi.hoisted(() => new Map<string | number, string>())
vi.mock('sonner', () => {
  let sequence = 0
  const show = (title: string, options?: { id?: string }) => { const id = options?.id ?? ++sequence; visible.set(id, title); return id }
  return { toast: Object.assign(show, { error: show, info: show, success: show, warning: show, dismiss: (id: string | number) => visible.delete(id) }) }
})
vi.mock('../../../../apps/desktop/src/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: () => null }))
let ids: string[], installed: InstalledSessionInputs, storage: ReturnType<typeof memoryOutboxStorage>, accept: boolean
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
const listed = () => state().rows.map(input => input.id)
beforeEach(async () => {
  visible.clear(); accept = false
  storage = memoryOutboxStorage()
  installed = installSessionInputOutbox({ storage, send: async () => { if (!accept) throw new SessionInputAdmissionError('refused', 'rejected') } })
  ids = []
  for (let i = 0; i < 2; i++) ids.push((await enqueueSessionInput({ deviceId: null, sessionId: 'task', text: 'same words' })).id)
  await settle()
  expect(state().rows.map(input => input.admission)).toEqual(['rejected', 'rejected'])
  ui = createReactHarness(); await ui.render(<TranscriptActions />)
})
afterEach(() => { ui.cleanup(); vi.restoreAllMocks(); installed.dispose() })
it('native retry success clears only that input after another failed retry', async () => {
  const write = vi.spyOn(storage, 'write').mockRejectedValue(new Error('write failed'))
  await click(0); await click(1); await waitVisible(2)
  write.mockRestore(); await act(async () => { await settle(); installed.outbox.kick() ; await settle() })
  accept = true
  await click(0); await waitVisible(1)
  await act(async () => vi.waitFor(() => expect(listed()).toEqual([ids[1]])))
})

it('a discard whose disk write fails says so and never deletes another input', async () => {
  const write = vi.spyOn(storage, 'write').mockRejectedValue(new Error('delete failed'))
  await click(0, 1); await waitVisible(1)
  write.mockRestore()
  // Nothing changed: the disk did not take the discard, so neither the screen nor a restart loses or revives anything.
  expect(listed()).toEqual([ids[0], ids[1]])
  expect(storage.rows.has(`owner/${ids[0]}`)).toBe(true)
  await click(0, 1)
  await act(async () => vi.waitFor(() => expect(listed()).toEqual([ids[1]])))
  expect(storage.rows.has(`owner/${ids[0]}`)).toBe(false)
  expect(storage.rows.has(`owner/${ids[1]}`)).toBe(true)
})

it('retrying a later input never attributes an earlier input storage failure to it', async () => {
  const original = storage.write.bind(storage)
  const write = vi.spyOn(storage, 'write').mockImplementation((owner, puts, removes) =>
    puts.some(item => item.id === ids[0]) || removes.includes(ids[0]!) ? Promise.reject(new Error('earlier input write failed')) : original(owner, puts, removes))
  accept = true
  await click(1)
  await act(async () => vi.waitFor(() => expect(listed()).toEqual([ids[0]])))
  expect(visible.size).toBe(0)
  expect(write).not.toHaveBeenCalledWith('owner', expect.arrayContaining([expect.objectContaining({ id: ids[0] })]), expect.anything())
})
