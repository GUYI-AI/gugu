// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
const { clearViewState, forgetConversation, readPanelEntries, readViewState, showConversation, writeViewState } = await import('../../../../apps/desktop/src/lib/viewStateTable')
const { viewStateCache } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/view-state-cache')
const { publishRendererSession } = await import('../../../../apps/desktop/src/lib/sessionPublication')

// No main process in this page: the view state is kept in localStorage, one key per entry.
const stored = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter((key) => key.startsWith('gugu.view-state:')).sort()
const session = (id: string) => ({ user: { id } }) as never
beforeEach(() => { publishRendererSession('SIGNED_IN', session('a')) })

it('keys by account, conversation and panel; a persisted panel is stored at once, a memory panel never', () => {
  writeViewState({ conversation: 'g1', panel: 'members' }, { query: 'x' })
  writeViewState({ conversation: 'g2', panel: 'members' }, { query: 'y' })
  writeViewState({ conversation: '', panel: 'settings/account', persist: false }, { nickname: 'edit' })
  expect(readViewState({ conversation: 'g1', panel: 'members' })).toEqual({ query: 'x' })
  expect(readViewState({ conversation: 'g2', panel: 'members' })).toEqual({ query: 'y' })
  expect(stored(), 'no timer to wait for: a quit right after keeps it').toEqual(['gugu.view-state:view:a/g1/members', 'gugu.view-state:view:a/g2/members'])
})

it('a field set to undefined goes back to the initial value; an empty entry is dropped', () => {
  writeViewState({ conversation: 'g3', panel: 'members' }, { query: 'x', expanded: false })
  writeViewState({ conversation: 'g3', panel: 'members' }, { query: undefined })
  expect(readViewState({ conversation: 'g3', panel: 'members' })).toEqual({ expanded: false })
  clearViewState({ conversation: 'g3', panel: 'members' })
  expect(readViewState({ conversation: 'g3', panel: 'members' })).toEqual({})
  expect(stored()).not.toContain('gugu.view-state:view:a/g3/members')
})

it('another account reads its own entries; the signed-out account takes its unsaved (memory) edits with it', () => {
  const edit = { conversation: '', panel: 'settings/account', persist: false }
  writeViewState(edit, { nickname: 'a edit' })
  publishRendererSession('SIGNED_IN', session('b'))
  expect(readViewState(edit)).toEqual({})
  publishRendererSession('SIGNED_IN', session('a'))
  expect(readViewState(edit), 'gone with the account').toEqual({})
})

it('a named account reads its own entries whoever is signed in; one panel kind lists by conversation', () => {
  writeViewState({ conversation: 'c1', panel: 'draft', account: 'z' }, { text: 'one' })
  writeViewState({ conversation: 'c2', panel: 'draft', account: 'z' }, { text: 'two' })
  expect(readViewState({ conversation: 'c1', panel: 'draft' }), 'signed in as a').toEqual({})
  expect(readPanelEntries('draft', 'z')).toEqual([['c1', { text: 'one' }], ['c2', { text: 'two' }]])
})

it('a conversation left takes its panels and its tab strip with it, and nothing of another conversation', () => {
  writeViewState({ conversation: 'gone', panel: 'draft' }, { text: 'hi' })
  writeViewState({ conversation: 'gone', panel: 'reading:chat:gone' }, { position: { atBottom: true } })
  viewStateCache.write('chat:gone:tabs', { groups: [] })
  writeViewState({ conversation: 'kept', panel: 'draft' }, { text: 'stay' })
  forgetConversation('gone')
  expect(stored().filter((key) => key.includes('gone'))).toEqual([])
  expect(readViewState({ conversation: 'kept', panel: 'draft' })).toEqual({ text: 'stay' })
})

it('a left conversation takes no writes (its closing panels saving on the way out) until a viewport shows it again', () => {
  writeViewState({ conversation: 'left', panel: 'reading:chat:left' }, { position: { atBottom: true } })
  forgetConversation('left')
  writeViewState({ conversation: 'left', panel: 'reading:chat:left' }, { position: { atBottom: false, messageId: 'm', offset: 0 } })
  expect(readViewState({ conversation: 'left', panel: 'reading:chat:left' }), 'the unmount capture after leaving').toEqual({})
  showConversation('left')
  writeViewState({ conversation: 'left', panel: 'draft' }, { text: 'joined again' })
  expect(readViewState({ conversation: 'left', panel: 'draft' })).toEqual({ text: 'joined again' })
})
