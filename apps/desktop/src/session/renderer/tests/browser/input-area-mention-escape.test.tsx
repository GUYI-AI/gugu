/**
 * 群聊 @ 候选:Esc 关掉之后不再自己弹回来。
 *
 * keydown 的 Esc 关框,同一次按键的 keyup 又按光标重算了一遍 —— `@` 还在光标前,框当场重开。
 * 真浏览器里按一次真 Esc(keydown + keyup 两个事件都走完)再读。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import type { GroupRosterCandidate } from '@/lib/mention'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'

const members: GroupRosterCandidate[] = [
  { id: 'user-a', name: 'Alice', type: 'human' },
  { id: 'agent-1', name: 'Claude 1', type: 'agent' },
]

let root: Root | null = null
let host: HTMLDivElement | null = null

const picker = () => document.querySelector<HTMLElement>('[data-slot="composer-menu"][role="listbox"]')
const nextFrames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

describe('@ mention picker dismissal', () => {
  const onSend = vi.fn(async () => {})
  const render = (hidden: boolean) => root!.render(
    <LocalizationProvider>
      <ChatMessageComposer onSend={onSend} isGroupChat groupMembers={members} hidden={hidden} />
    </LocalizationProvider>,
  )
  beforeEach(() => {
    setLocalePreference('zh-CN')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    render(false)
  })

  afterEach(() => {
    root?.unmount()
    host?.remove()
    root = null
    host = null
  })

  it('Escape closes the picker and its keyup does not reopen it', async () => {
    const textarea = page.getByTestId('chat-composer')
    await textarea.click()
    await userEvent.keyboard('@')
    await until('mention picker opens', () => picker() !== null)

    await userEvent.keyboard('{Escape}')
    await nextFrames()

    expect(picker()).toBeNull()
    expect((textarea.element() as HTMLElement).innerText).toBe('@')
  })

  // The picker is portaled out of the composer host. A phone chat left for the chat list stays mounted with its
  // composer hidden; the open @ list used to stay on screen over the list. It hides with the composer, and comes back
  // with it, the draft's @ still there.
  it('hides with its composer and comes back with it', async () => {
    const textarea = page.getByTestId('chat-composer')
    await textarea.click()
    await userEvent.keyboard('@')
    await until('mention picker opens', () => picker() !== null)

    render(true)
    await until('picker hidden with the composer', () => picker() === null)
    await nextFrames()
    expect(picker()).toBeNull()

    render(false)
    await until('picker back with the composer', () => picker() !== null)
    expect((textarea.element() as HTMLElement).innerText).toBe('@')
  })
})
