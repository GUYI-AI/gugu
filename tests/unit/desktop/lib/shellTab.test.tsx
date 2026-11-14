// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { createShellTabStore, ShellTabContext, useShellTabIs } from '../../../../apps/desktop/src/lib/shellTab'
import type { SidebarTab } from '../../../../packages/core/src/shared/enums/sidebarTabModels'

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

it('a tab switch re-renders only the surfaces whose "am I shown" answer changed', async () => {
  const renders: Record<string, number> = {}
  function Surface({ tab }: { tab: SidebarTab }) {
    const shown = useShellTabIs(tab)
    renders[tab] = (renders[tab] ?? 0) + 1
    return createElement('div', { 'data-surface': tab, 'data-shown': String(shown) })
  }
  const store = createShellTabStore('tasks')
  harness = createReactHarness()
  await harness.render(createElement(ShellTabContext.Provider, { value: store },
    (['tasks', 'contacts', 'settings'] as const).map((tab) => createElement(Surface, { key: tab, tab }))))
  expect(renders).toEqual({ tasks: 1, contacts: 1, settings: 1 })
  await act(async () => store.set('contacts'))
  expect(renders, 'settings stayed hidden: not rendered again').toEqual({ tasks: 2, contacts: 2, settings: 1 })
  expect(harness.container.querySelector('[data-surface="contacts"]')!.getAttribute('data-shown')).toBe('true')
  await act(async () => store.set('contacts'))
  expect(renders, 'setting the same tab is not a switch').toEqual({ tasks: 2, contacts: 2, settings: 1 })
})

it('the phone chat page is not the shown surface from the frame its conversation leaves the list', async () => {
  let listed = true
  const listeners = new Set<() => void>()
  const store = createShellTabStore('chats', { activeListed: () => listed, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } } })
  function Surface({ tab }: { tab: SidebarTab }) {
    return createElement('div', { 'data-surface': tab, 'data-shown': String(useShellTabIs(tab)) })
  }
  harness = createReactHarness()
  await harness.render(createElement(ShellTabContext.Provider, { value: store },
    (['chats', 'contacts'] as const).map((tab) => createElement(Surface, { key: tab, tab }))))
  const shown = (tab: SidebarTab) => harness.container.querySelector(`[data-surface="${tab}"]`)!.getAttribute('data-shown')
  await act(async () => { store.set('contacts'); store.setChatFrom('contacts') })
  expect([store.get(), store.chatShown(), shown('chats'), shown('contacts')], 'a project group opened from 伙伴 is on screen').toEqual(['chats', true, 'true', 'false'])
  listed = false
  expect([store.get(), store.chatShown()], 'read in the same frame, before anyone is notified').toEqual(['contacts', false])
  await act(async () => { for (const listener of [...listeners]) listener() })
  expect([shown('chats'), shown('contacts')]).toEqual(['false', 'true'])
  listed = true
  await act(async () => { store.set('settings'); store.set('contacts') })
  expect(store.get(), 'a pushed layer over it and back keeps the chat page').toBe('chats')
  await act(async () => store.set('chats'))
  expect([store.get(), store.chatShown()], 'another root tab drops it').toEqual(['chats', false])
  await act(async () => store.set('contacts'))
  expect(store.get(), 'and it does not come back').toBe('contacts')
})
