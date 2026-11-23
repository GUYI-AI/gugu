import { useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { useChatStore } from '@/store/chatContext'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'

const editors = vi.hoisted(() => ({ ids: [] as string[], read: Promise.resolve() }))
// The cited file's makers, as the workspace reads answer them: none by the item row, every id among its versions' authors.
vi.mock('@/lib/supabase', async (original) => {
  const actual = await original<typeof import('@/lib/supabase')>()
  const rpc = (fn: string) => fn === 'workspace_get_as'
    ? { select: () => ({ single: async () => ({ data: { created_by: null, updated_by: null }, error: null }) }) }
    : editors.read.then(() => ({ data: editors.ids.map((made_by) => ({ made_by })), error: null }))
  return { ...actual, chatDb: new Proxy(actual.chatDb, { get: (target, key, receiver) => key === 'rpc' ? rpc : Reflect.get(target, key, receiver) }) }
})

const FILE = 'gugu-file://0b6f6c1e-58a4-4a39-9a37-3f1f4c7a2d10?v=2#L3'
const members = [{ id: 'cite-agent', name: 'Cite agent', type: 'agent' as const }, { id: 'cite-peer', name: 'Cite peer', type: 'human' as const }]
let root: Root
let host: HTMLDivElement
const onSend = vi.fn(async (_content: string, _options?: { toUserIds?: string[] | null }) => {})

function Seed({ text }: { text: string }) {
  const { writeDraft } = useChatStore('writeDraft')
  useEffect(() => queueMicrotask(() => writeDraft('cite-room', text)), [writeDraft, text])
  return null
}

async function mountWithCite() {
  root.render(<LocalizationProvider><ChatMessageComposer chatId="cite-room" currentUserId="cite-me" isGroupChat onSend={onSend} groupMembers={members} />
    <Seed text={`look @[notes.md](${FILE}) `} /></LocalizationProvider>)
  const input = page.getByTestId('chat-composer')
  await until('the cited line is a pill in the editor', () => input.elements().length === 1 && input.element().querySelector(`[data-mention-id="${FILE}"]`) !== null)
  return input
}

beforeEach(async () => {
  editors.read = Promise.resolve()
  setLocalePreference('en-US')
  await page.viewport(1000, 720)
  onSend.mockClear()
  host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:24px;top:180px;width:640px'
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { root.unmount(); host.remove() })

it('sends a cite with no @ to the members who made the file, not to the sender or to non-members', async () => {
  editors.ids = ['cite-me', 'cite-agent', 'cite-peer', 'someone-who-left']
  await mountWithCite()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await until('sent', () => onSend.mock.calls.length === 1)
  expect(onSend.mock.calls[0]?.[0]).toContain(FILE)
  expect(onSend.mock.calls[0]?.[1]?.toUserIds).toEqual(['cite-agent', 'cite-peer'])
})

it('leaves a cite unaddressed when the sender is its only editor', async () => {
  editors.ids = ['cite-me']
  await mountWithCite()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await until('sent', () => onSend.mock.calls.length === 1)
  expect(onSend.mock.calls[0]?.[1]?.toUserIds).toEqual([])
})

it('lets an @ win over the cite', async () => {
  editors.ids = ['cite-agent']
  const input = await mountWithCite()
  await input.click()
  await userEvent.keyboard('{End}@')
  const member = page.getByRole('option', { name: /Cite peer/ })
  await until('member picker result', () => member.elements().length === 1)
  await member.click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await until('sent', () => onSend.mock.calls.length === 1)
  expect(onSend.mock.calls[0]?.[1]?.toUserIds).toEqual(['cite-peer'])
})

it('keeps words typed while the cited files are read, and sends only what was there at send', async () => {
  editors.ids = ['cite-agent']
  let readDone = () => {}
  editors.read = new Promise<void>((resolve) => { readDone = resolve })
  const input = await mountWithCite()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await input.click()
  await userEvent.keyboard('{End}next thought')
  readDone()
  await until('sent', () => onSend.mock.calls.length === 1)
  expect(onSend.mock.calls[0]?.[0]).not.toContain('next thought')
  expect(onSend.mock.calls[0]?.[1]?.toUserIds).toEqual(['cite-agent'])
  await until('the later words stay in the composer', () => input.element().textContent?.trim() === 'next thought')
})
