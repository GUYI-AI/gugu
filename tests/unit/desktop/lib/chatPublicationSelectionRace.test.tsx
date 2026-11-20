// @vitest-environment jsdom
import { act, useRef, useState } from 'react'
import { expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chat, createReactHarness, deferred } from '../../../support/testHarness'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { useChatListState } from '../../../../apps/desktop/src/store/chatListState'
import { createChatListProjectionLedger, useChatProjectionBinding } from '../../../../apps/desktop/src/store/chatListProjection'
import { createShellTabStore } from '../../../../apps/desktop/src/lib/shellTab'

vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { notifications: false } } }))
vi.mock('../../../../apps/desktop/src/lib/onScreenChat', () => ({ isChatOnScreen: () => false }))

const group = (id: string): ChatItem => chat({ id, kind: 'group', name: id, member_user_ids: [] })

it.each([
  { name: 'keeps a group selected during an older list commit on the phone chat page', active: 'native', lateRow: false, revoked: false },
  { name: 'closes the newly selected group when its membership is revoked during the commit', active: 'native', lateRow: false, revoked: true },
  { name: 'keeps a late group row for an unchanged selection during the commit', active: 'big', lateRow: true, revoked: false },
])('$name', async ({ active: initiallySelected, lateRow, revoked }) => {
  const rows = [group('native'), group('big')]
  const initial = lateRow ? rows.slice(0, 1) : rows
  const memory = createMemoryLocalSyncDb()
  const repository = await openImRepository('selection-during-list-write', { adapter: memory })
  const harness = createReactHarness()
  const ledger = createChatListProjectionLedger()
  ledger.seedFromCache(initial)
  const entered = deferred<void>(), release = deferred<void>()
  const commit = memory.commit.bind(memory)
  vi.spyOn(memory, 'commit').mockImplementationOnce(async operations => {
    entered.resolve(); await release.promise; return commit(operations)
  })
  let binding!: ReturnType<typeof useChatProjectionBinding>
  let select!: (id: string) => void
  let acceptRows!: (rows: ChatItem[]) => void
  let membershipRevoked = false
  let shown: ChatItem[] = [], selected: string | null = null
  function Owner() {
    const [current, setRows, chatsRef] = useChatListState(initial)
    const [active, setActive] = useState<string | null>(initiallySelected)
    const activeChatIdRef = useRef<string | null>(active), repositoryRef = useRef(repository)
    const requestSeqRef = useRef(0)
    selected = active; shown = current
    acceptRows = setRows
    select = id => { activeChatIdRef.current = id; setActive(id) }
    binding = useChatProjectionBinding({ ledger, repositoryRef, chatsRef, activeChatIdRef, requestSeqRef,
      getRepository: async () => repository, setChats: setRows,
      onActiveRevoked: id => { if (activeChatIdRef.current === id) { activeChatIdRef.current = null; setActive(null) } },
      conversations: { readSeqsOf: () => undefined }, notifications: { chatMessages: false, sound: false },
      canAcknowledge: () => false, visibleSeqOf: () => 0 })
    const shell = createShellTabStore('chats', {
      activeId: () => current.some(row => row.id === active) ? active : null,
      listed: id => current.some(row => row.id === id), subscribe: () => () => undefined,
    })
    shell.setChatFrom('chats')
    return <output data-phone-chat-shown={String(shell.chatShown())}>{active}</output>
  }
  let pending: Promise<void> | undefined
  try {
    await harness.render(<Owner />)
    await act(async () => {
      pending = binding.publish([rows[0]!], [], { requestSeq: 1, notify: false,
        preserveMissingActive: false, revokedMembership: id => membershipRevoked && id === 'big' })
      await entered.promise
    })
    await act(async () => {
      if (lateRow) acceptRows(rows)
      select('big')
      membershipRevoked = revoked
    })
    expect(harness.container.querySelector('output')?.dataset.phoneChatShown).toBe('true')
    await act(async () => { release.resolve(); await pending })
    if (revoked) {
      expect(selected).toBeNull()
      expect(shown.map(row => row.id)).not.toContain('big')
      expect(harness.container.querySelector('output')?.dataset.phoneChatShown).toBe('false')
    } else {
      expect(selected).toBe('big')
      expect(shown.map(row => row.id), 'an older publication must not drop the newly selected group').toContain('big')
      expect(harness.container.querySelector('output')?.dataset.phoneChatShown).toBe('true')
    }
  } finally {
    release.resolve(); await pending
    harness.cleanup(); repository.close()
  }
})

it('still closes a group with an authoritative membership revocation', async () => {
  const rows = [group('native'), group('big')]
  const repository = await openImRepository('authoritative-selection-revocation', { adapter: createMemoryLocalSyncDb() })
  const harness = createReactHarness()
  const ledger = createChatListProjectionLedger()
  ledger.seedFromCache(rows)
  let binding!: ReturnType<typeof useChatProjectionBinding>
  let shown: ChatItem[] = [], selected: string | null = 'big'
  function Owner() {
    const [current, setRows, chatsRef] = useChatListState(rows)
    const [active, setActive] = useState<string | null>('big')
    const activeChatIdRef = useRef<string | null>(active), repositoryRef = useRef(repository)
    const requestSeqRef = useRef(0)
    shown = current; selected = active
    binding = useChatProjectionBinding({ ledger, repositoryRef, chatsRef, activeChatIdRef, requestSeqRef,
      getRepository: async () => repository, setChats: setRows,
      onActiveRevoked: id => { if (activeChatIdRef.current === id) { activeChatIdRef.current = null; setActive(null) } },
      conversations: { readSeqsOf: () => undefined }, notifications: { chatMessages: false, sound: false },
      canAcknowledge: () => false, visibleSeqOf: () => 0 })
    return null
  }
  try {
    await harness.render(<Owner />)
    await act(async () => { await binding.publish([rows[0]!], [], {
      requestSeq: 1, notify: false, preserveMissingActive: false, revokedMembership: id => id === 'big',
    }) })
    expect(shown.map(row => row.id)).not.toContain('big')
    expect(selected).toBeNull()
  } finally { harness.cleanup(); repository.close() }
})
