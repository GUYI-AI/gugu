import { beforeEach, describe, expect, it, vi } from 'vitest'

const modal = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: modal.show }))

import { confirmConversationAction, confirmDanger } from '../../../../apps/desktop/src/lib/confirmDanger'
import { messageActionItems } from '../../../../apps/desktop/src/components/chat/messageActionItems'

const t = ((key: string) => key) as never
const answer = (ok: boolean) => { const [, args] = modal.show.mock.calls.at(-1)!; if (ok) args.onSuccess(); else args.onClose() }

describe('destructive menu actions ask first', () => {
  beforeEach(() => modal.show.mockClear())

  it('confirmDanger is the destructive confirmActionModal and resolves by the answer', async () => {
    const yes = confirmDanger({ title: 'T', description: 'D', confirmLabel: 'C' })
    expect(modal.show).toHaveBeenCalledWith('confirmActionModal', expect.objectContaining({ title: 'T', variant: 'destructive' }))
    answer(true)
    await expect(yes).resolves.toBe(true)
    const no = confirmDanger({ title: 'T', description: 'D', confirmLabel: 'C' })
    answer(false)
    await expect(no).resolves.toBe(false)
  })

  it('deleting a message runs only after confirming, from any surface of the message table', async () => {
    const onDelete = vi.fn()
    const del = messageActionItems({ isRetracted: false, content: 'x', onDelete }, t).find((item) => item.key === 'delete')!
    del.onSelect!()
    expect(onDelete).not.toHaveBeenCalled()
    answer(false)
    await Promise.resolve()
    expect(onDelete).not.toHaveBeenCalled()
    del.onSelect!()
    answer(true)
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledOnce())
  })

  it('names each conversation deletion by what it does', () => {
    void confirmConversationAction('delete-chat', 'group', 'G')
    void confirmConversationAction('delete-chat', 'topic', 'T')
    void confirmConversationAction('leave-group', 'group', 'G')
    void confirmConversationAction('remove-contact', 'dm', 'P')
    expect(modal.show.mock.calls.map(([, args]) => args.confirmLabel)).toEqual(['解散群聊', '删除话题', '退出群聊', '删除联系人'])
  })
})
