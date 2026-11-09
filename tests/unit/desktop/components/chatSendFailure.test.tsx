// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { ChatStoreProvider, useTextDraftStore } from '../../../../apps/desktop/src/store/chatContext'
import { useChatDraft } from '../../../../apps/desktop/src/components/chat/useChatDraft'
import { useChatMessageSend } from '../../../../apps/desktop/src/components/chat/useChatMessageSend'
import { chatStore, createReactHarness } from '../../../support/testHarness'
import { ToastContext } from '../../../../apps/desktop/src/components/toastContext'
import { notify } from '../../../../apps/desktop/src/lib/notices'
const notices = vi.hoisted(() => new Map<string | number, string>())
vi.mock('sonner', () => {
  let sequence = 0
  const show = (title: string, options?: { id?: string }) => { const id = options?.id ?? ++sequence; notices.set(id, title); return id }
  return { toast: Object.assign(show, { error: show, info: show, success: show, warning: show, dismiss: (id: string | number) => notices.delete(id) }) }
})
vi.mock('../../../../apps/desktop/src/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: () => null }))
const send = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}))
function Composer({ id, group }: { id: string; group: boolean }) {
  const draft = useChatDraft(id)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [peer, setPeer] = useState(0), [quote, setQuote] = useState(0)
  const { handleSend } = useChatMessageSend({ chatId: id, currentUserId: 'owner', isGroupChat: group, onSend: send,
    whisperTarget: peer ? { userId: `peer-${peer}`, displayName: 'Peer' } : null,
    quoteContent: quote ? { messageId: `quote-${quote}`, senderName: 'Peer', content: 'quoted' } : null }, draft, [], [], ref)
  return <section data-chat={id}><textarea ref={ref} value={draft.text} onChange={event => draft.setText(event.target.value)} />
    <button onClick={() => draft.setText('same words')}>type</button><button onClick={() => void handleSend()}>send</button>
    <button onClick={() => setPeer(value => value + 1)}>whisper</button><button onClick={() => setQuote(value => value + 1)}>quote</button></section>
}
function Host() {
  const drafts = useTextDraftStore(), [base] = useState(chatStore)
  return <ToastContext.Provider value={{ toast: (title, tier) => { notify({ title, tier }) } }}>
    <ChatStoreProvider value={{ ...base, ...drafts }}><Composer id="dm" group={false} /><Composer id="group" group /></ChatStoreProvider>
  </ToastContext.Provider>
}
let ui: ReturnType<typeof createReactHarness>
const click = (chat: string, index: number) => act(async () => { ui.container.querySelectorAll<HTMLButtonElement>(`[data-chat="${chat}"] button`)[index].click() })
beforeEach(async () => { ui = createReactHarness(); send.mockReset(); notices.clear(); await ui.render(<Host />) })
afterEach(() => ui.cleanup())

it.each(['dm', 'group'])('the retained %s submission reuses its id and removes its own failure after success', async chat => {
  send.mockRejectedValueOnce(new Error('storage refused'))
  await click(chat, 0); await click(chat, 1)
  expect(ui.container.querySelector<HTMLTextAreaElement>(`[data-chat="${chat}"] textarea`)!.value).toBe('same words')
  expect(notices.size).toBe(1)
  const id = (send.mock.calls[0][1] as { clientMessageId: string }).clientMessageId
  expect(id).toBeTruthy()
  await click(chat, 1)
  expect((send.mock.calls[1][1] as { clientMessageId: string }).clientMessageId).toBe(id)
  expect(notices.size).toBe(0)
})

it('a repeated failure updates one notice while another composer retains its failure', async () => {
  send.mockRejectedValue(new Error('same failure'))
  await click('dm', 0); await click('dm', 1)
  await click('group', 0); await click('group', 1)
  await click('dm', 1)
  expect(notices.size).toBe(2)
  send.mockResolvedValue(undefined)
  await click('dm', 1)
  expect(notices.size).toBe(1)
})

it.each(['draft', 'whisper', 'reply'])('a new %s intent has a new identity without settling the previous failure', async mode => {
  const edit = mode === 'draft' ? 0 : mode === 'whisper' ? 2 : 3
  await click('group', 0)
  if (edit) await click('group', edit)
  send.mockRejectedValueOnce(new Error('first refused'))
  await click('group', 1)
  const first = (send.mock.calls[0][1] as { clientMessageId: string }).clientMessageId
  await click('group', edit); await click('group', 1)
  expect((send.mock.calls[1][1] as { clientMessageId: string }).clientMessageId).not.toBe(first)
  expect(notices.size).toBe(1)
})
