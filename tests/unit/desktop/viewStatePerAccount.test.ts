// @vitest-environment jsdom
// What is kept per account follows the account: another person signing in reads their own (App placement, the screen),
// and a memory bounded by bytes keeps its newest entries (tab placement).
import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { localStorage.clear(); vi.resetModules() })

it('App placement and the screen are read again when another account signs in', async () => {
  const { publishRendererSession } = await import('../../../apps/desktop/src/lib/sessionPublication')
  const { writeViewState } = await import('../../../apps/desktop/src/lib/viewStateTable')
  const screenOf = (chatId: string) => ({ blocks: { b1: { kind: 'chat', chatId } }, layout: { pane: 'b1' }, focused: 'b1' })
  writeViewState({ conversation: '', panel: 'app-placement', account: 'acc-a' }, { placements: { 'notes.main': { projectId: 'pA', sessionId: 'sA' } } })
  writeViewState({ conversation: '', panel: 'screen', account: 'acc-b' }, { snapshot: screenOf('chat-of-b') })
  publishRendererSession('SIGNED_IN', { user: { id: 'acc-a' } } as never)
  const { appPlacementStore } = await import('../../../apps/desktop/src/session/renderer/features/extensions/app-placement-store')
  const { ensureScreenLayoutSync } = await import('../../../apps/desktop/src/session/renderer/app/screen-layout-actions')
  const { screenLayout } = await import('../../../apps/desktop/src/session/renderer/app/screen-layout')
  ensureScreenLayoutSync()
  expect(appPlacementStore.of('notes.main')).toEqual({ projectId: 'pA', sessionId: 'sA' })
  publishRendererSession('SIGNED_IN', { user: { id: 'acc-b' } } as never)
  expect(appPlacementStore.of('notes.main'), 'B has placed nothing').toBeUndefined()
  expect(Object.values(screenLayout.snapshot?.blocks ?? {})).toEqual([{ kind: 'chat', chatId: 'chat-of-b' }])
  publishRendererSession('SIGNED_IN', { user: { id: 'acc-a' } } as never)
  expect(appPlacementStore.of('notes.main')).toEqual({ projectId: 'pA', sessionId: 'sA' })
  expect(screenLayout.snapshot, 'A kept no screen: an empty one, not B\'s').toBeNull()
})

it('tab placement keeps the newest resources that fit, and they are there at the next start', async () => {
  const { accountTabPlacementMemory } = await import('../../../apps/desktop/src/session/renderer/features/tabs/tab-placement-memory')
  const memory = accountTabPlacementMemory(() => 'acc-t')
  const id = (i: number) => `session:7f3e2a90-5c1d-4b8e-9a6f-0d2c4e8b1a${String(i).padStart(2, '0')}\u0000file\u0000/home/user/projects/app/src/feature-${i}.ts`
  for (let i = 0; i < 100; i++) memory.write(id(i), 'beside')
  vi.resetModules()
  const again = (await import('../../../apps/desktop/src/session/renderer/features/tabs/tab-placement-memory')).accountTabPlacementMemory(() => 'acc-t')
  expect(again.read(id(99)), 'the newest survives a restart').toBe('beside')
  expect(again.read(id(0)), 'the oldest gave way').toBeUndefined()
})
