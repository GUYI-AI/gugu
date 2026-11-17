// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, contact, clickElement } from '../../../support/testHarness'
import { ContactRowContextMenu } from '../../../../apps/desktop/src/components/contacts/ContactRowActions'

vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chats: [], markUnread: vi.fn(async () => undefined) }) }))
vi.mock('../../../../apps/desktop/src/hooks/useMarkChatsRead', () => ({ useMarkChatsRead: () => vi.fn() }))
const modal = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: modal.show }))

let harness: ReturnType<typeof createReactHarness>
const onRemove = vi.fn()
beforeEach(() => { harness = createReactHarness(); onRemove.mockClear(); modal.show.mockClear() })
afterEach(() => harness.cleanup())
const base = { removeLabel: 'x', isPinned: false, notifMuted: false, onPin: vi.fn(), onToggleNotif: vi.fn(), onRemove, onStartChat: vi.fn(), onMarkUnread: vi.fn() }
const ids = () => [...document.querySelectorAll('[data-testid^="contact-row-"]')].map((item) => item.getAttribute('data-testid')!.slice('contact-row-'.length))
const open = async () => { const more = document.querySelector<HTMLElement>('[data-testid="contact-row-more"]'); if (more) await clickElement(more) }

describe('contacts rows draw from the object tables', () => {
  it('my agent\'s contact row is its task: rename and archive, as its tab and chat-list row', async () => {
    await harness.render(<ContactRowContextMenu x={10} y={10} onClose={vi.fn()} {...base} contact={contact({ id: 'a', type: 'agent', owner_user_id: 'me', display_name: 'Helper' })} />)
    expect(ids()).toEqual(expect.arrayContaining(['open-chat', 'mark-unread', 'pin', 'rename', 'notifications', 'archive']))
    await clickElement(document.querySelector<HTMLElement>('[data-testid="contact-row-rename"]')!)
    expect(modal.show).toHaveBeenCalledWith('renameSessionModal', expect.objectContaining({ currentTitle: 'Helper' }))
  })

  it('a group I am a member of offers leave, not dissolve, and opens from the row (no open chat)', async () => {
    await harness.render(<ContactRowContextMenu x={10} y={10} onClose={vi.fn()} {...base} onStartChat={undefined} group={{ chatId: 'g', role: 'member', name: 'G' }} />)
    await open()
    expect(ids()).toContain('leave-group')
    expect(ids()).not.toContain('delete-chat')
    expect(ids()).not.toContain('open-chat')
  })

  it('a friend offers alias, and removing the friend goes through the panel\'s confirming handler', async () => {
    await harness.render(<ContactRowContextMenu x={10} y={10} onClose={vi.fn()} {...base} contact={contact({ id: 'p', type: 'human' })} />)
    await open()
    expect(ids()).toContain('set-alias')
    await clickElement(document.querySelector<HTMLElement>('[data-testid="contact-row-remove-contact"]')!)
    expect(onRemove).toHaveBeenCalledOnce()
  })
})
