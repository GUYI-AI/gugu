// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { publishChatSummaries } from '../../../../apps/desktop/src/lib/chatSummariesBridge'
import { clearChatRemovalFacts, publishChatRemovalFacts, publishChatRemoved, subscribeChatRemovals } from '../../../../apps/desktop/src/lib/chatRemovalBridge'

const owner = vi.hoisted(() => ({ id: 'owner' as string | null }))
vi.mock('../../../../apps/desktop/src/lib/replica', () => ({ replicaAccount: () => owner }))
let stop: (() => void) | undefined
beforeEach(() => { owner.id = 'owner'; clearChatRemovalFacts() })
afterEach(() => { stop?.(); stop = undefined; clearChatRemovalFacts() })

it('keeps active and parked layout ids through partial and empty chat-summary publications', () => {
  const layout = new Set(['active', 'parked'])
  stop = subscribeChatRemovals(() => [...layout], id => layout.delete(id))
  publishChatSummaries([{ id: 'active', kind: 'group', name: 'A', unread_count: 0 }])
  publishChatSummaries([]) // includes the shell-unmount publication
  publishChatRemovalFacts('owner', () => false) // unread is not a deletion fact
  expect([...layout]).toEqual(['active', 'parked'])
  publishChatRemovalFacts('owner', id => id === 'parked')
  expect([...layout]).toEqual(['active'])
})

it('uses already-published authoritative facts when the saved layout mounts later', () => {
  const remove = vi.fn()
  publishChatRemovalFacts('owner', id => id === 'gone')
  stop = subscribeChatRemovals(() => ['gone', 'unread'], remove)
  expect(remove.mock.calls).toEqual([['gone']])
})

it('accepts a confirmed explicit delete/leave, and ignores another account and cleared sources', () => {
  const remove = vi.fn()
  stop = subscribeChatRemovals(() => ['shared-group'], remove)
  publishChatRemoved('another-owner', 'shared-group')
  publishChatRemovalFacts('another-owner', () => true)
  expect(remove).not.toHaveBeenCalled()
  publishChatRemoved('owner', 'shared-group')
  expect(remove.mock.calls).toEqual([['shared-group']])
  clearChatRemovalFacts()
  owner.id = 'another-owner'
  publishChatSummaries([])
  expect(remove).toHaveBeenCalledOnce()
})

it('verifies only the restored references and removes the blank block after the authoritative read completes', async () => {
  const layout = new Set(['restored-gone', 'opened-later'])
  let removed = false
  const readRestored = vi.fn(async (ids: readonly string[]) => {
    expect(ids).toEqual(['restored-gone'])
    if (removed) return
    removed = true
    publishChatRemovalFacts('owner', id => id === 'restored-gone')
  })
  stop = subscribeChatRemovals(() => [...layout], id => layout.delete(id), () => ['restored-gone'])
  publishChatRemovalFacts('owner', () => false, readRestored)
  await Promise.resolve()
  expect([...layout]).toEqual(['opened-later'])
  expect(readRestored).toHaveBeenCalledOnce()
})
