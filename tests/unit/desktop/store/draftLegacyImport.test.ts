// @vitest-environment jsdom
// Drafts kept in localStorage before the view-state table move over once, when their module loads, and leave localStorage.
import { expect, it, vi } from 'vitest'

it('moves chat and task drafts of every account into the table and removes the old keys', async () => {
  localStorage.clear()
  localStorage.setItem('gugu.chat-draft:acc-1/chat-1', JSON.stringify({ text: '旧草稿', mentions: [{ userId: 'u', displayName: 'U' }] }))
  localStorage.setItem('gugu.chat-draft:acc-2/chat-2', JSON.stringify({ text: 'other account', mentions: [] }))
  localStorage.setItem('gugu.chat-draft:acc-1/broken', '{not json')
  localStorage.setItem('gugu.native-offline-draft:acc-1/local/session-9', '任务里没发的')
  vi.resetModules()
  const { readChatDrafts } = await import('../../../../apps/desktop/src/store/chatDraftStorage')
  await import('../../../../apps/desktop/src/lib/nativeOfflineDraft')
  const { readViewState } = await import('../../../../apps/desktop/src/lib/viewStateTable')
  expect(readChatDrafts('acc-1')).toEqual({ texts: { 'chat-1': '旧草稿' }, mentions: { 'chat-1': [{ userId: 'u', displayName: 'U' }] } })
  expect(readChatDrafts('acc-2').texts).toEqual({ 'chat-2': 'other account' })
  expect(readViewState({ conversation: 'task:local/session-9', panel: 'draft', account: 'acc-1' })).toEqual({ text: '任务里没发的' })
  expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter((key) => !key.startsWith('gugu.view-state:')), 'only the malformed one is left, as before').toEqual(['gugu.chat-draft:acc-1/broken'])
})

it('more old drafts than the cap: the table keeps what its caps allow, the old keys go, and a second start changes nothing', async () => {
  localStorage.clear()
  for (let i = 0; i < 40; i++) localStorage.setItem(`gugu.chat-draft:acc-many/c${i}`, JSON.stringify({ text: `draft ${i}`, mentions: [] }))
  vi.resetModules()
  let { readChatDrafts } = await import('../../../../apps/desktop/src/store/chatDraftStorage')
  const first = Object.keys(readChatDrafts('acc-many').texts).sort()
  expect(first).toHaveLength(32)
  expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter((key) => key.startsWith('gugu.chat-draft:'))).toEqual([])
  vi.resetModules()
  ;({ readChatDrafts } = await import('../../../../apps/desktop/src/store/chatDraftStorage'))
  expect(Object.keys(readChatDrafts('acc-many').texts).sort(), 'the same drafts after another start').toEqual(first)
})
