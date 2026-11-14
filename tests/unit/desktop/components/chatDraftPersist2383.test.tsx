// @vitest-environment jsdom
// #2383 群聊/私聊草稿按账号落在本机:整页重载后还在,别的账号看不到,发出或清空后删掉。
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { IDBFactory } from 'fake-indexeddb'
import { File as NodeFile } from 'node:buffer'
import { ChatStoreProvider, useDraftAttachmentsStore, useDraftMentionsStore, useTextDraftStore } from '../../../../apps/desktop/src/store/chatContext'
import { ToastContext } from '../../../../apps/desktop/src/components/toastContext'
import { chatStore, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { readComposer, writeComposer } from '../../../support/composerEditor'

let harness: ReturnType<typeof createReactHarness>
let mentions: ReturnType<typeof useDraftMentionsStore>
function Host({ accountId, onSend = async () => {} }: { accountId: string | null; onSend?: (content: string) => Promise<void> }) {
  const drafts = useTextDraftStore(accountId)
  mentions = useDraftMentionsStore(accountId)
  const [base] = useState(chatStore)
  return <ChatStoreProvider value={{ ...base, ...drafts, ...mentions }}>
    <ChatMessageComposer chatId="group-1" onSend={onSend} />
  </ChatStoreProvider>
}
const composer = () => harness.container.querySelector<HTMLElement>('[data-testid="chat-composer"]')!
async function typeAndSettle(text: string) {
  await act(async () => { writeComposer(composer(), text); vi.advanceTimersByTime(1000) })
}
async function reload(accountId: string | null) {
  harness.cleanup()
  harness = createReactHarness()
  await renderWithAppProviders(harness, <Host accountId={accountId} />)
}

beforeEach(async () => {
  localStorage.clear()
  vi.useFakeTimers()
  harness = createReactHarness()
  await renderWithAppProviders(harness, <Host accountId="account-a" />)
})
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

describe('chat drafts across a full reload (#2383)', () => {
  it('restores the text and its @ picks after a reload of the same account', async () => {
    await typeAndSettle('写到一半的话')
    await act(async () => { mentions.setDraftMentions('group-1', [{ userId: 'agent-1', displayName: 'Agent 一' }]) })
    await reload('account-a')
    expect(readComposer(composer())).toBe('写到一半的话')
    expect(mentions.draftMentions['group-1']).toEqual([{ userId: 'agent-1', displayName: 'Agent 一' }])
  })

  it('keeps one account’s draft away from another account', async () => {
    await typeAndSettle('A 的草稿')
    await reload('account-b')
    expect(readComposer(composer())).toBe('')
    await reload('account-a')
    expect(readComposer(composer())).toBe('A 的草稿')
  })

  it('forgets the draft once it is sent', async () => {
    harness.cleanup()
    harness = createReactHarness()
    const onSend = vi.fn(async () => {})
    await renderWithAppProviders(harness, <Host accountId="account-a" onSend={onSend} />)
    await typeAndSettle('发出去的话')
    await act(async () => {
      composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
      vi.advanceTimersByTime(1000)
    })
    expect(onSend).toHaveBeenCalledOnce()
    await reload('account-a')
    expect(readComposer(composer())).toBe('')
    expect(Object.keys(localStorage).filter((key) => key.startsWith('gugu.chat-draft:'))).toEqual([])
  })

  it('forgets the draft once it is cleared by hand', async () => {
    await typeAndSettle('删掉的话')
    await typeAndSettle('')
    await reload('account-a')
    expect(readComposer(composer())).toBe('')
    expect(Object.keys(localStorage).filter((key) => key.startsWith('gugu.chat-draft:'))).toEqual([])
  })
})

describe('queued attachments across a full reload', () => {
  let attachments: ReturnType<typeof useDraftAttachmentsStore>
  const toast = vi.fn()
  function Files({ accountId, composer = false }: { accountId: string | null; composer?: boolean }) {
    attachments = useDraftAttachmentsStore(accountId)
    const [base] = useState(chatStore)
    return <ToastContext.Provider value={{ toast }}>
      <ChatStoreProvider value={{ ...base, ...attachments }}>{composer ? <ChatMessageComposer chatId="group-1" onSend={async () => {}} /> : null}</ChatStoreProvider>
    </ToastContext.Provider>
  }
  const mount = async (accountId: string | null, composer = false) => {
    harness.cleanup()
    harness = createReactHarness()
    await renderWithAppProviders(harness, <Files accountId={accountId} composer={composer} />)
  }
  const settle = (done: () => boolean) => vi.waitFor(() => { if (!done()) throw new Error('not yet') })
  // fake-indexeddb clones with Node's structuredClone, which keeps Node files (as Chromium keeps its own) but not jsdom's.
  const picture = new NodeFile(['png bytes'], 'screenshot.png', { type: 'image/png' }) as unknown as File
  beforeEach(async () => {
    vi.useRealTimers()
    Object.assign(globalThis, { indexedDB: new IDBFactory() })
    toast.mockClear()
    await mount('account-a')
  })

  it('restores a pasted file, bytes and all, and forgets it once removed', async () => {
    await act(async () => { attachments.setDraftAttachments('group-1', [{ id: 'f1', file: picture, kind: 'image' }]) })
    await new Promise(resolve => setTimeout(resolve, 50))
    await mount('account-a')
    await settle(() => attachments.draftAttachments['group-1']?.length === 1)
    const restored = attachments.draftAttachments['group-1']![0]!
    expect(restored.id).toBe('f1')
    expect(restored.file.name).toBe('screenshot.png')
    expect(await restored.file.text()).toBe('png bytes')
    await mount('account-b')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(attachments.draftAttachments['group-1'], 'another account does not see it').toBeUndefined()

    await mount('account-a')
    await settle(() => attachments.draftAttachments['group-1']?.length === 1)
    await act(async () => { attachments.setDraftAttachments('group-1', []) })
    await mount('account-a')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(attachments.draftAttachments['group-1'] ?? []).toEqual([])
    expect(Object.keys(localStorage).filter((key) => key.startsWith('gugu.chat-draft:'))).toEqual([])
  })

  it('names a file whose bytes are gone in that chat’s composer instead of dropping it silently', async () => {
    localStorage.setItem('gugu.chat-draft:account-a/group-1', JSON.stringify({ text: '看这个', mentions: [], attachments: [{ id: 'lost', name: 'report.pdf' }] }))
    await mount('account-a', true)
    await settle(() => toast.mock.calls.length === 1)
    expect(toast.mock.calls[0]![0]).toContain('report.pdf')
    expect(toast.mock.calls[0]![1]).toBe('error')
    expect(attachments.draftAttachmentsUnavailable, 'told once, then dismissed').toEqual({})
    expect(JSON.parse(localStorage.getItem('gugu.chat-draft:account-a/group-1')!)).toMatchObject({ text: '看这个', attachments: [] })
  })
})
