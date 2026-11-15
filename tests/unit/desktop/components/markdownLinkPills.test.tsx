// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationLink, groupFileLink } from '@gugu/core/shared/ui/guguLink'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
import { AuthContext } from '../../../../apps/desktop/src/store/auth'
import { ChatStoreProvider } from '../../../../apps/desktop/src/store/chatContext'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'

const ME = '11111111-1111-4111-8111-111111111111'
const ALICE = '22222222-2222-4222-8222-222222222222'
const CHAT = '33333333-3333-4333-8333-333333333333'
const MESSAGE = '44444444-4444-4444-8444-444444444444'
const DOC = '55555555-5555-4555-8555-555555555555'
const GONE = '77777777-7777-4777-8777-777777777777'
const TOPIC = '88888888-8888-4888-8888-888888888888'
const SOURCE = '99999999-9999-4999-8999-999999999999'

const mocks = vi.hoisted(() => ({ fileMetadata: vi.fn(), getMessageById: vi.fn() }))
vi.mock('@/platform', () => ({ platform: { kind: 'web' } }))
vi.mock('@/components/appSlot/phoneAppHost', () => ({ openPhoneLink: vi.fn(async () => ({ kind: 'opened' })) }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ fileMetadata: mocks.fileMetadata }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: mocks.getMessageById } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Markdown loads the pill on first use; load it once here so a busy run does not spend a case's wait on compiling it.
beforeAll(async () => { await import('../../../../apps/desktop/src/components/markdown/LinkPill') }, 120000)

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  attachmentQueryClient.clear()
  vi.clearAllMocks()
})

async function render(content: string, trust: 'chat' | 'document' = 'chat', surface: 'chat' | 'bare' = 'chat') {
  const store = { chatsRead: true, chats: [{ id: CHAT, name: 'Design review', kind: 'group' }, { id: TOPIC, name: 'Launch', kind: 'topic' }], identitiesById: { [ALICE]: { id: ALICE, display_name: 'Alice' } } }
  const markdown = createElement(Markdown, { trust, content })
  await act(async () => {
    root.render(surface === 'bare' ? markdown : createElement(AuthContext.Provider, { value: { user: { id: ME } } as never },
      createElement(ChatStoreProvider, { value: store as never }, markdown)))
  })
}
// Pills load lazily and then read: wait for both.
const settle = (check: () => void) => vi.waitFor(async () => { await act(async () => { await vi.dynamicImportSettled() }); check() }, { timeout: 10000 })
const pills = () => [...container.querySelectorAll<HTMLAnchorElement>('a.gg-md-mention')]

describe('chat link pills, drawn in place', () => {
  it('draws a file link as the file pill with the file name, in the sentence; it is not an @ mention', async () => {
    mocks.fileMetadata.mockResolvedValue({ status: 'ready', revision: { source: 'managed-object', version: 2, file_name: 'plan.pdf', content_type: 'application/pdf', size_bytes: 2048 } })
    await render(`see [the spec](${groupFileLink(DOC, { version: 2 })}) before Friday`)
    await settle(() => expect(pills()[0]?.textContent).toBe('plan.pdf'))
    expect(mocks.fileMetadata).toHaveBeenCalledWith(DOC, 2)
    // Only an @ pill copies back as `@[name](link)` (hookFilePillCopy); a link pill copies as its words.
    expect(pills()[0]?.dataset.mentionKind).toBe('link')
    expect(pills()[0]?.querySelector('.gg-md-mention-icon')).not.toBeNull()
    expect(container.querySelector('p')?.textContent).toBe('see plan.pdf before Friday')
  })

  it('draws a group or topic link as # its name, and one this window does not list with the link\'s words', async () => {
    await render(`in [here](${conversationLink(CHAT)}), [there](${conversationLink(TOPIC)}) and [elsewhere](${conversationLink(SOURCE)})`)
    await settle(() => expect(pills().map(pill => pill.textContent)).toEqual(['# Design review', '# Launch', 'elsewhere']))
    expect(pills()[2]?.dataset.unavailable).toBeUndefined()
  })

  it('names a message that is an attachment by its file, not its envelope', async () => {
    mocks.getMessageById.mockResolvedValue({ id: MESSAGE, chat_id: CHAT, sender_user_id: ALICE, content: '[附件] plan.pdf (application/pdf)\n[Size] 2048\n[Kind] file', content_type: 'attachment', retracted_at: null })
    await render(`[the file](${conversationLink(CHAT, MESSAGE)})`)
    await settle(() => expect(pills()[0]?.textContent).toBe('Alice：plan.pdf'))
  })

  it('draws a message link as sender：its first words, showing the link\'s words until the read answers', async () => {
    let answer!: (row: unknown) => void
    mocks.getMessageById.mockReturnValue(new Promise(resolve => { answer = resolve }))
    await render(`as agreed in [the decision](${conversationLink(CHAT, MESSAGE)})`)
    await settle(() => expect(mocks.getMessageById).toHaveBeenCalledWith(MESSAGE, ME))
    expect(pills()[0]?.textContent).toBe('the decision')
    expect(pills()[0]?.dataset.unavailable).toBeUndefined()
    await act(async () => answer({ id: MESSAGE, chat_id: CHAT, sender_user_id: ALICE, content: 'Ship the blue header today, keep the old footer', retracted_at: null }))
    await settle(() => expect(pills()[0]?.textContent).toBe('Alice：Ship the blue header tod…'))
  })

  it('greys a link whose read cannot show it, keeping its words', async () => {
    mocks.fileMetadata.mockResolvedValue({ status: 'gone', sha256: null })
    mocks.getMessageById.mockResolvedValue(null)
    await render(`[old notes](${groupFileLink(GONE)}) [elsewhere](${conversationLink(CHAT, MESSAGE)})`)
    await settle(() => expect(pills().map(pill => pill.dataset.unavailable)).toEqual(['true', 'true']))
    expect(pills().map(pill => pill.textContent)).toEqual(['old notes', 'elsewhere'])
    expect(pills()[0]?.title).toBe('文件已删除')
    expect(pills()[1]?.title).toBe('不可用：已删除，或你无权查看')
  })

  it('keeps the plain link where nobody is signed in and no chat list is read', async () => {
    await render(`[the spec](${groupFileLink(DOC)}) [the decision](${conversationLink(CHAT, MESSAGE)})`, 'chat', 'bare')
    await act(async () => { await vi.dynamicImportSettled() })
    expect(pills()).toHaveLength(0)
    expect([...container.querySelectorAll('a')].map(a => a.textContent)).toEqual(['the spec', 'the decision'])
    expect(mocks.fileMetadata).not.toHaveBeenCalled()
    expect(mocks.getMessageById).not.toHaveBeenCalled()
  })

  it('leaves web links, task links and document Markdown as links', async () => {
    await render('[site](https://example.com) [step](gugu-session://S1?message=turn%3A2)')
    expect(pills()).toHaveLength(0)
    await render(`[the spec](${groupFileLink(DOC)})`, 'document')
    expect(pills()).toHaveLength(0)
    expect(mocks.fileMetadata).not.toHaveBeenCalled()
  })
})
