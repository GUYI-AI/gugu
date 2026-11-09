import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { ChatTailNotice } from '@/components/chat/ChatTailNotice'
import { LocalizationProvider } from '@/i18n'
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(() => { root?.unmount(); host?.remove(); root = undefined; host = undefined })

it.each([
  { group: false, width: 390 }, { group: true, width: 390 },
  { group: false, width: 900 }, { group: true, width: 900 },
])('preserves the human input and its separate tail control: group=$group width=$width', async ({ group, width }) => {
  await page.viewport(width, 800)
  const recover = vi.fn()
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = `position:relative;width:${width}px;height:600px`
  if (width < 720) host.setAttribute('data-phone-shell', '')
  root = createRoot(host)
  root.render(<LocalizationProvider>
    <ChatTailNotice onClick={recover} window={{ chatId: 'controlled-layout-chat', messages: [], firstItemIndex: 0,
      hasOlder: false, hasNewer: true, loading: null, change: 'reset', navigation: 'reset', navigationVersion: 0,
      viewVersion: 0, newMessageCount: 0, latestSeen: 0 }} />
    <ChatBottomDock reserve={false}><ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat={group} /></ChatBottomDock>
  </LocalizationProvider>)
  await until('human composer mounted', () => !!host!.querySelector('[data-testid="chat-composer"]'))
  await untilStable('human input painted', () => host!.querySelector('[data-slot="composer-input"]')!.getBoundingClientRect().top)
  const input = host!.querySelector('[data-slot="composer-input"]')!.getBoundingClientRect()
  const frame = host!.getBoundingClientRect()
  expect(input.left).toBeGreaterThanOrEqual(frame.left)
  expect(input.right).toBeLessThanOrEqual(frame.right)
  const tail = host!.firstElementChild as HTMLElement
  const rect = tail.getBoundingClientRect()
  expect(rect.bottom).toBeLessThanOrEqual(input.top)
  expect(tail.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))).toBe(true)
  await page.getByText(tail.textContent!, { exact: true }).click()
  expect(recover).toHaveBeenCalledOnce()
  await page.getByTestId('chat-composer').fill('Controlled input remains editable')
  expect(host!.querySelector('[data-testid="chat-composer"]')!.textContent).toContain('Controlled input remains editable')
  expect(host!.querySelector('[data-slot="aui-thread-scroll-to-bottom"]'), 'human chats retain their own tail-control path').toBeNull()
})
