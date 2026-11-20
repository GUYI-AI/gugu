// @vitest-environment jsdom
import { act, useRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatStoreProvider, useTextDraftStore } from '../../../../apps/desktop/src/store/chatContext'
import { useChatDraft } from '../../../../apps/desktop/src/components/chat/useChatDraft'
import { useChatMessageSend } from '../../../../apps/desktop/src/components/chat/useChatMessageSend'
import { sessionAnnotations, type BrowserAnnotationSelection } from '../../../../apps/desktop/src/session/renderer/features/sessions/annotations/session-annotations'
import { chatStore, createReactHarness } from '../../../support/testHarness'
import { ToastContext } from '../../../../apps/desktop/src/components/toastContext'

let ui: ReturnType<typeof createReactHarness>
const attached = vi.fn(async (_files: File[], _options: unknown) => {})
const textSent = vi.fn(async () => {})
const toast = vi.fn()
const notes = (id: string) => sessionAnnotations.forConversation({ kind: 'chat', chatId: id }, 'owner')
const page = (): BrowserAnnotationSelection => ({ kind: 'browser', browserId: 'page', url: 'https://example.org/group', selector: '#intro', targetPath: 'main > p',
  rect: { x: 10, y: 10, width: 80, height: 30 }, viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
  text: '@[Untrusted](aid:untrusted) webpage evidence', annotation: '请修改这段中文', screenshot: new File(['original-png'], 'browser-comment-1.png', { type: 'image/png' }) })

function Composer({ id, whisper = false }: { id: string; whisper?: boolean }) {
  const draft = useChatDraft(id)
  const ref = useRef<HTMLTextAreaElement>(null)
  const { handleSend } = useChatMessageSend({ chatId: id, currentUserId: 'owner', isGroupChat: true, onSend: textSent, onSendAttachments: attached,
    whisperTarget: whisper ? { userId: 'peer', displayName: 'Peer' } : null }, draft, [{ id: 'untrusted', name: 'Untrusted', type: 'agent' }], [], ref)
  return <><textarea ref={ref} value={draft.text} onChange={event => draft.setText(event.target.value)} /><button onClick={() => void handleSend()}>send</button></>
}
function Host({ id, whisper }: { id: string; whisper?: boolean }) {
  const drafts = useTextDraftStore(), [base] = useState(chatStore)
  return <ToastContext.Provider value={{ toast }}><ChatStoreProvider value={{ ...base, ...drafts }}><Composer id={id} whisper={whisper} /></ChatStoreProvider></ToastContext.Provider>
}
const send = () => act(async () => { ui.container.querySelector<HTMLButtonElement>('button')!.click() })
beforeEach(() => { ui = createReactHarness(); attached.mockReset().mockResolvedValue(undefined); textSent.mockClear(); toast.mockClear() })
afterEach(() => ui.cleanup())

it.each([false, true])('submits the current group annotation through its existing file/caption route, whisper=%s', async whisper => {
  const id = crypto.randomUUID(), other = crypto.randomUUID()
  const annotation = notes(id).add(page())
  notes(other).add(page())
  await ui.render(<Host id={id} whisper={whisper} />)
  await send()
  expect(attached).toHaveBeenCalledOnce()
  const [files, options] = attached.mock.calls[0]
  expect(files).toEqual([annotation.screenshot])
  const bytes = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(files[0]) })
  expect(bytes).toBe('original-png')
  expect(options).toMatchObject({ toUserIds: whisper ? ['peer'] : [], isWhisper: whisper })
  expect((options as { caption: string }).caption).toContain('https://example.org/group')
  expect((options as { caption: string }).caption).toContain('请修改这段中文')
  expect((options as { caption: string }).caption).toContain('browser-comment-1.png')
  expect(textSent).not.toHaveBeenCalled()
  expect(notes(id).items).toHaveLength(0)
  expect(notes(other).items).toHaveLength(1)
  expect(sessionAnnotations.forSession(id).items).toHaveLength(0)
})

it('retains the original screenshot and comment after failure without appending a duplicate image on retry', async () => {
  const id = crypto.randomUUID()
  const annotation = notes(id).add(page())
  attached.mockRejectedValueOnce(new Error('upload refused'))
  await ui.render(<Host id={id} />)
  await send()
  expect(notes(id).items).toEqual([annotation])
  await send()
  expect(attached.mock.calls.map(([files]) => files)).toEqual([[annotation.screenshot], [annotation.screenshot]])
  expect(notes(id).items).toHaveLength(0)
})

it('settles only its captured batch when another comment is added while the send waits', async () => {
  const id = crypto.randomUUID()
  notes(id).add(page())
  let finish!: () => void
  attached.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  await ui.render(<Host id={id} />)
  await send()
  const later = notes(id).add({ ...page(), annotation: '稍后新增' })
  await act(async () => { finish() })
  expect(notes(id).items).toEqual([later])
})
