// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/**
 * `gugu.dispatch` naming no target: the shell's one sheet (on ChatPickSheet) offers what the call may go to — the page's
 * chat's agents and people, this computer's tasks (the page's own ticked, its project's next), a new agent, chats for a
 * draft — above it what will go: the text, theirs to change, and each pill. The App hears only the pick and the text.
 */

const chats: ChatItem[] = [
  { id: 'c-group', kind: 'group', name: 'Reading group' },
  { id: 'c-dm', kind: 'dm', name: '', peer_user_id: 'u-alpha', last_message_at: '2025-12-01T00:00:00.000Z' },
].map((overrides) => ({
  status: 'active', created_at: '2026-01-01T00:00:00.000Z', last_message_at: null, last_message_preview: null, unread_count: 0,
  pinned_message_id: null, last_read_seq: 0, next_message_seq: 1, ...overrides,
}) as ChatItem)
// The chat on screen and its messages: what the @ order reads (who spoke there lately).
const store = { chats, identitiesById: { 'u-alpha': { display_name: 'Alpha', avatar: null, type: 'human' } }, activeChatId: null as string | null, messages: [] as unknown[] }
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => store }))
// The person's own agents (contacts they own), wherever they run.
const agent = (id: string, display_name: string) => ({ id, display_name, avatar: null, type: 'agent', owner_user_id: 'me', created_at: '2026-11-02T08:00:00.000Z' })
vi.mock('../../../../apps/desktop/src/components/settings/channels/channelAgents', () => ({
  useOwnedAgents: () => [agent('a-other', 'Codex 5'), agent('a-sibling', 'Same project'), agent('a-here', 'This page')],
}))

const computers = [
  { device_id: 'first', label: 'First computer', is_online: true },
  { device_id: 'second', label: 'Second computer', is_online: true },
  { device_id: 'offline', label: 'Offline computer', is_online: false },
].map((one) => ({ ...one, hostname: one.device_id, platform: 'darwin', status: one.is_online ? 'online' : 'offline', last_seen_at: '2026-10-26T01:00:00Z', capabilities: { terminals: [], runtimes: [] } }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: computers, phones: [{ ...computers[0], device_id: 'phone', capabilities: { host_kind: 'phone', host_runtime_capability: 1, terminals: [], runtimes: ['pi'] } }], loading: false, error: null }),
}))
// The composer's editor (NoteEditor, a TipTap PromptEditor) stands in as a textarea with the same handle: the sheet
// starts it with the App's words (setText) and reads what the person left (onChange); its @ list is the chat's own.
vi.mock('../../../../apps/desktop/src/components/chat/NoteEditor', async () => {
  const { createElement, useImperativeHandle, useState } = await import('react')
  return { NoteEditor: ({ editorRef, onChange, inputTestId }: { editorRef: never; onChange: (text: string) => void; inputTestId: string }) => {
    const [value, setValue] = useState('')
    const write = (next: string) => { setValue(next); onChange(next) }
    useImperativeHandle(editorRef, () => ({ setText: write, getText: () => value, isEmpty: () => false }) as never)
    return createElement('textarea', { 'data-testid': inputTestId, value, onChange: (event: { target: { value: string } }) => write(event.target.value) })
  } }
})
vi.mock('../../../../apps/desktop/src/components/chat/useGroupMentionProvider', () => ({ useGroupMentionProvider: () => ({}) }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: null }) }))
// Each agent's session's last interaction (presence): the agent order the sheet falls back to (compareByRecentActivity).
const lastInteractedAt: Record<string, string> = {}
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => ({
  useAgentRecentActivity: (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, { actions: [], lastActiveAt: null, lastInteractedAt: lastInteractedAt[id] ?? null }])),
}))

const { DispatchSheet } = await import('../../../../apps/desktop/src/components/chat/DispatchSheet')
const { pickDispatchTarget } = await import('../../../../apps/desktop/src/components/chat/dispatchAsk')
const ask = (over: Record<string, unknown>) => pickDispatchTarget({ draft: true, offers: ['chat', 'my-agent'], text: 'cite', pills: [], chat: null, preselect: null, visible: false, ...over } as never)

let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(DispatchSheet)))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const rowIds = () => [...document.body.querySelectorAll('[data-pick-row]')].map((row) => row.getAttribute('data-pick-row'))
const ticked = () => [...document.body.querySelectorAll('[data-pick-row][aria-selected="true"]')].map((row) => row.getAttribute('data-pick-row'))
const click = (element: Element | null | undefined) => act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const button = (text: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent === text)
const type = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('DispatchSheet', () => {
  it('shows and searches a fresh agent by the real name used for dispatch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-11-02T08:00:00.000Z')
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ offers: ['my-agent'] }) })
    await type(document.body.querySelector('input') as HTMLInputElement, 'codex')
    const row = document.body.querySelector('[data-pick-row="agent:user:a-other"]')!
    expect(row.textContent).toContain('Codex 5')
    expect(row.textContent).not.toContain('正在生成名称…')
    await click(row)
    await click(document.body.querySelector('[data-testid="dispatch-sheet-action"]'))
    await expect(picked).resolves.toEqual({ to: { agent: 'user:a-other' }, visible: false, text: 'cite' })
  })
  it('appends only applicable resource templates without picking a target or sending', async () => {
    let picked: Promise<unknown> = Promise.resolve(), answered = false
    await act(async () => { picked = ask({ text: 'keep this URL', pills: ['reference'], resource: { kind: 'app-variant', target: { kind: 'app-detail', extensionId: 'radar', deviceId: 'device', variant: 'remote-watch' }, facts: ['fork'] } }); void picked.then(() => { answered = true }) })
    const chips = document.querySelector('[data-testid="dispatch-templates"]')!
    expect(chips.textContent).toContain('删除 fork')
    expect(chips.textContent).not.toContain('合并上游')
    await click([...chips.querySelectorAll('button')].find(button => button.textContent === '删除 fork'))
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="dispatch-text-input"]')!.value).toContain('keep this URL\n先征求我的确认')
    expect(chips.compareDocumentPosition(document.querySelector('[data-testid="dispatch-pill"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(answered).toBe(false)
    expect(ticked()).toEqual([])
    await click(document.querySelector('[data-testid="dispatch-sheet-close"]') ?? document.querySelector('[aria-label="关闭"]'))
    await expect(picked).resolves.toBeNull()
  })
  it('uses the phone New task machine picker for a new agent, defaults to context, and returns the selected computer', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ draft: false, offers: ['new-agent'], spawnOn: 'first' }) })
    await click(document.body.querySelector('[data-pick-row="new:agent"]'))
    expect(document.body.querySelector('[data-testid="dispatch-machine"]')?.textContent).toContain('First computer')
    await click(document.body.querySelector('[data-testid="dispatch-machine"]'))
    expect(document.body.querySelector('[data-testid="agent-watch-pick-machine"]')).not.toBeNull()
    expect(document.body.querySelector('[data-device-id="phone"]')).toBeNull()
    expect(document.body.querySelector<HTMLButtonElement>('[data-device-id="offline"]')?.disabled).toBe(true)
    await click(document.body.querySelector('[data-device-id="second"]'))
    expect(document.body.querySelector('[data-testid="dispatch-machine"]')?.textContent).toContain('Second computer')
    await click(document.body.querySelector('[data-testid="dispatch-sheet-action"]'))
    await expect(picked).resolves.toEqual({ to: { new: true, device: 'second' }, visible: false, text: 'cite' })
  })

  it('a draft from a task\'s tab: 「我的 agent」 first, the page\'s own ticked and first, only those with a session here; a pick is the place', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ preselect: 'user:a-here', local: ['user:a-here', 'user:a-other'] }) })
    expect([...document.body.querySelectorAll('[data-pick-section]')].map((s) => s.getAttribute('data-pick-section'))).toEqual(['agents', 'chats'])
    expect(rowIds()).toEqual(['agent:user:a-here', 'agent:user:a-other', 'chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual(['agent:user:a-here'])

    // One at a time: picking a chat unticks the task.
    await click(document.body.querySelector('[data-pick-row="chat:c-dm"]'))
    expect(ticked()).toEqual(['chat:c-dm'])
    await click(button('放入输入框'))
    await expect(picked).resolves.toEqual({ to: { chat: 'c-dm' }, visible: false, text: 'cite' })
    expect(rowIds()).toEqual([])
  })

  it('chats only when there are no tasks to offer (the phone, or images riding along); cancelling answers null', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ offers: ['chat'] }) })
    expect(rowIds()).toEqual(['chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual([])
    expect(button('放入输入框')?.disabled).toBe(true)
    // One at a time: the foot counts nothing (the forward sheet's 「已选 N 个」 is for several).
    expect(document.body.textContent).not.toContain('已选')
    await click(document.body.querySelector('button[aria-label="关闭"]'))
    await expect(picked).resolves.toBeNull()
  })

  it('a search narrows chats and agents alike', async () => {
    await act(async () => { void ask({}) })
    expect(rowIds()).toEqual(['agent:user:a-other', 'agent:user:a-sibling', 'agent:user:a-here', 'chat:c-group', 'chat:c-dm'])
    expect(ticked()).toEqual([])
    await type(document.body.querySelector('input') as HTMLInputElement, 'same')
    expect(rowIds()).toEqual(['agent:user:a-sibling'])
  })

  it('a message: the chat\'s agents, its people, tasks, a new agent; the text shown and theirs to change, the pills under it, visible for a member', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => {
      picked = ask({
        draft: false,
        offers: ['agent-in-chat', 'person-in-chat', 'my-agent', 'new-agent'],
        text: 'Host this round',
        pills: ['round.soup.json'],
        chat: { id: 'c-group', name: 'Reading group', members: [{ id: 'user:a', name: 'Kip', kind: 'agent' }, { id: 'user:p', name: 'Wei', kind: 'human' }] },
      })
    })
    expect([...document.body.querySelectorAll('[data-pick-section]')].map((s) => s.getAttribute('data-pick-section'))).toEqual(['chat-agents', 'chat-people', 'agents', 'new'])
    expect(rowIds()).toEqual(['member:user:a', 'member:user:p', 'agent:user:a-other', 'agent:user:a-sibling', 'agent:user:a-here', 'new:agent'])
    const text = document.body.querySelector('[data-testid="dispatch-text-input"]') as HTMLTextAreaElement
    expect(text.value).toBe('Host this round')
    expect([...document.body.querySelectorAll('[data-testid="dispatch-pill"]')].map((p) => p.textContent)).toEqual(['@round.soup.json'])
    // Nothing picked: nothing to send.
    expect(button('发送')?.disabled).toBe(true)
    // An agent of theirs: no 「visible」, that is a chat's.
    await click(document.body.querySelector('[data-pick-row="agent:user:a-here"]'))
    expect(document.body.querySelector('[data-testid="dispatch-visible"]')).toBeNull()
    await click(document.body.querySelector('[data-pick-row="member:user:a"]'))
    // Picked: the rows give the composer their room; typing a name brings them back.
    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]')!
    expect(listbox.hidden).toBe(true)
    await type(document.body.querySelector('input') as HTMLInputElement, 'k')
    expect(listbox.hidden).toBe(false)
    await type(document.body.querySelector('input') as HTMLInputElement, '')
    await click(document.body.querySelector('[data-testid="dispatch-visible"]'))
    await type(text, 'Host this round, hard mode')
    await click(button('发送'))
    await expect(picked).resolves.toEqual({ to: { chat: 'c-group', member: 'user:a' }, visible: true, text: 'Host this round, hard mode' })
  })

  it('the chat\'s members come in the chat\'s @ order: who spoke there lately first, and a search matches as @ does', async () => {
    store.activeChatId = 'c-group'
    // As they are: a message's sender is the bare uuid; the App's members come as `user:<uuid>` (personId).
    store.messages = [{ id: 'm1', chat_id: 'c-group', seq: 1, sender_user_id: 'lin', to_user_ids: [], content_type: 'text', created_at: new Date().toISOString() }]
    await act(async () => {
      void ask({ draft: false, offers: ['agent-in-chat'], chat: { id: 'c-group', name: 'Reading group', members: [{ id: 'user:kip', name: 'Kip', kind: 'agent' }, { id: 'user:lin', name: 'Lin', kind: 'agent' }] } })
    })
    expect(rowIds()).toEqual(['member:user:lin', 'member:user:kip'])
    await type(document.body.querySelector('input') as HTMLInputElement, 'ki')
    expect(rowIds()).toEqual(['member:user:kip'])
    store.activeChatId = null
    store.messages = []
  })

  it('Assign to: with nothing said in the chat, its agents come in the agent order (last interaction, else when made), not the roster\'s', async () => {
    Object.assign(lastInteractedAt, { mid: '2026-11-23T10:00:00.000Z', new: '2026-11-24T07:00:00.000Z' })
    // Out of order, as list_member_ids gives them; `old` has never been worked with.
    const members = [{ id: 'user:old', name: 'Old', kind: 'agent' }, { id: 'user:mid', name: 'Mid', kind: 'agent' }, { id: 'user:new', name: 'New', kind: 'agent' }]
    await act(async () => { void ask({ draft: false, offers: ['agent-in-chat'], chat: { id: 'c-group', name: 'Reading group', members } }) })
    expect(rowIds()).toEqual(['member:user:new', 'member:user:mid', 'member:user:old'])
    // Who spoke in the chat on screen still comes first (the @ order), the rest in the agent order.
    store.activeChatId = 'c-group'
    store.messages = [{ id: 'm1', chat_id: 'c-group', seq: 1, sender_user_id: 'old', to_user_ids: [], content_type: 'text', created_at: new Date().toISOString() }]
    await act(async () => { void ask({ draft: false, offers: ['agent-in-chat'], chat: { id: 'c-group', name: 'Reading group', members } }) })
    expect(rowIds()).toEqual(['member:user:old', 'member:user:new', 'member:user:mid'])
    store.activeChatId = null
    store.messages = []
    for (const id of Object.keys(lastInteractedAt)) delete lastInteractedAt[id]
  })

  it('a pick: the App\'s words, what it is about read only, the person\'s own agents; the pick is the agent', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ draft: false, offers: ['my-agent'], text: '', pick: { title: '指派', subject: '并发问题', body: '选一个', action: '指派', search: '搜索', empty: '没有' }, preselect: 'user:a-sibling' }) })
    expect(document.body.querySelector('[data-testid="dispatch-pick"]')?.textContent).toContain('并发问题')
    expect(document.body.querySelector('[data-testid="dispatch-text"]')).toBeNull()
    expect(rowIds()).toEqual(['agent:user:a-sibling', 'agent:user:a-other', 'agent:user:a-here'])
    expect(ticked()).toEqual(['agent:user:a-sibling'])
    await click(document.body.querySelector('[data-testid="dispatch-sheet-action"]'))
    await expect(picked).resolves.toEqual({ to: { agent: 'user:a-sibling' }, visible: false, text: '' })
  })

  it('a pick is taken back by its chip\'s × or by its row again, and Send turns off again', async () => {
    await act(async () => { void ask({ draft: false, offers: ['my-agent'], text: 'Take card x9zo' }) })
    await click(document.body.querySelector('[data-pick-row="agent:user:a-other"]'))
    expect(ticked()).toEqual(['agent:user:a-other'])
    const chip = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Codex 5')
    await click(chip)
    expect(ticked()).toEqual([])
    expect(button('发送')?.disabled).toBe(true)
    await click(document.body.querySelector('[data-pick-row="agent:user:a-other"]'))
    await click(document.body.querySelector('[data-pick-row="agent:user:a-other"]'))
    expect(ticked()).toEqual([])
    await click(document.body.querySelector('[data-pick-row="agent:user:a-here"]'))
    await click(document.body.querySelector('[data-pick-row="agent:user:a-other"]'))
    expect(ticked()).toEqual(['agent:user:a-other'])
  })

  it('a new agent: its row picks { new }', async () => {
    let picked: Promise<unknown> = Promise.resolve()
    await act(async () => { picked = ask({ draft: false, offers: ['new-agent'], text: 'Make a deck' }) })
    expect(rowIds()).toEqual(['new:agent'])
    await click(document.body.querySelector('[data-pick-row="new:agent"]'))
    await click(button('发送'))
    await expect(picked).resolves.toEqual({ to: { new: true }, visible: false, text: 'Make a deck' })
  })
})
