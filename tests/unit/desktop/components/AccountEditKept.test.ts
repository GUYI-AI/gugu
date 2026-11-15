// @vitest-environment jsdom
// fe-continuity A4: an edit in Settings → Account not saved yet survives closing Settings and opening it again (the view-state
// table, memory only: a restart forgets it by design). When the saved value becomes the same as the edit (saved on another
// device, say), the edit goes and the saved value shows.
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'
import { queryClient } from '../../../../apps/desktop/src/lib/readModel'
import { AccountSection } from '../../../../apps/desktop/src/components/settings/AccountSection'

vi.mock('../../../../apps/desktop/src/lib/firstRun', () => ({ readOccupation: async () => null, writeOccupation: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/ownSettings', async () => {
  const { readModel } = await import('../../../../apps/desktop/src/lib/readModel')
  return { ownSettings: readModel({ name: 'ownSettings', scope: 'account', read: async () => ({}) }) }
})

beforeEach(() => { queryClient.clear() })
// The test page keeps its view state in localStorage (no main process here).
const stored = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter((key) => key.startsWith('gugu.view-state:'))
const harness = { current: null as ReturnType<typeof createReactHarness> | null }
async function open(nickname: string) {
  harness.current?.cleanup()
  harness.current = createReactHarness()
  const user = { id: 'account-a4', email: 'u@example.test', nickname }
  await renderWithAppProviders(harness.current, createNode(AccountSection, { user, updateUser: vi.fn(), logout: vi.fn(async () => ({ success: true })) }), { auth: user })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const nameInput = () => harness.current!.container.querySelector<HTMLInputElement>('#settings-account-name')!

it('keeps an unsaved name across closing and reopening Settings, memory only', async () => {
  await open('Tester')
  await typeInto(nameInput(), 'Tester renamed')
  harness.current!.cleanup(); harness.current = null
  await open('Tester')
  expect(nameInput().value, 'the edit is still there').toBe('Tester renamed')
  expect(stored(), 'an unsaved edit is never stored').toEqual([])
})

it('drops the edit once the saved value is the same (another device saved it)', async () => {
  await open('Before')
  await typeInto(nameInput(), 'Same everywhere')
  await open('Same everywhere')
  expect(nameInput().value).toBe('Same everywhere')
  await open('Changed elsewhere later')
  expect(nameInput().value, 'no stale edit hides the newer saved value').toBe('Changed elsewhere later')
})
