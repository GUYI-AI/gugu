import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { Pane, PaneHeader } from '@/components/ui/Pane'
import { IconButton } from '@/components/ui/IconButton'
import { MobileTabPager } from '@/mobile/MobileTabPager'
import { PhoneConversationHeading } from '@/mobile/chat/PhoneConversationHeading'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'

let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  await page.viewport(390, 844)
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  delete document.documentElement.dataset.theme
})

it.each(['light', 'dark'])('%s: only phone root-list headers get separate layers, without moving them', async (theme) => {
  document.documentElement.dataset.theme = theme
  const rootList = (tab: 'chats' | 'contacts') => (
    <Pane paneRole="nav" mobile data-phone-root-list={tab}>
      <div><PaneHeader mobile titleLevel="page" title={tab} /></div>
    </Pane>
  )
  await harness.render(<>
    <div data-phone-shell="" style={{ display: 'flex', height: 400, width: 390 }}>
      <MobileTabPager mobile tabs={['chats', 'contacts']} activeTab="chats" swipeable
        onSettle={() => {}} tabBarRef={{ current: null }} pages={{ chats: rootList('chats'), contacts: rootList('contacts') }} />
    </div>
    <div data-phone-shell="">
      {['private chat', 'group chat', 'settings'].map(title => (
        <Pane key={title} paneRole="detail" mobile><PaneHeader mobile title={title} /></Pane>
      ))}
    </div>
    <Pane paneRole="nav"><PaneHeader title="desktop" /></Pane>
  </>)
  const roots = [...harness.container.querySelectorAll<HTMLElement>('[data-phone-root-list] .gg-pane-header')]
  expect(roots).toHaveLength(2)
  for (const header of roots) {
    expect(getComputedStyle(header).transform).not.toBe('none')
    const rect = header.getBoundingClientRect().toJSON()
    header.style.transform = 'none'
    expect(header.getBoundingClientRect().toJSON()).toEqual(rect)
    header.style.removeProperty('transform')
  }
  const others = [...harness.container.querySelectorAll<HTMLElement>('.gg-pane-header')].filter(header => !roots.includes(header))
  expect(others).toHaveLength(4)
  for (const header of others) expect(getComputedStyle(header).transform).toBe('none')
})

it('keeps single and double-line conversation headers compact when system text scales differ', async () => {
  harness.container.style.setProperty('--title-scale', '1.5')
  harness.container.style.setProperty('--text-scale', '1.25')
  await harness.render(<div data-phone-shell="">
    {[undefined, '来源 gugu'].map((subtitle, index) => (
      <PaneHeader key={index} mobile centered subtitle={subtitle}
        title={<PhoneConversationHeading name="gugu 群会话" topic={!!subtitle} centered label="会话资料" onOpen={() => {}} />}
        leading={<IconButton size="lg" aria-label="返回">‹</IconButton>}
        actions={<IconButton size="lg" aria-label="更多">…</IconButton>} />
    ))}
  </div>)
  const headers = [...harness.container.querySelectorAll<HTMLElement>('.gg-pane-header[data-centered]')]
  expect(headers).toHaveLength(2)
  for (const [index, header] of headers.entries()) {
    const rect = header.getBoundingClientRect()
    const title = header.querySelector<HTMLElement>('.gg-pane-heading-title')!
    const text = title.querySelector<HTMLElement>('button .truncate')!
    const copy = header.querySelector<HTMLElement>('.gg-pane-heading-copy')!.getBoundingClientRect()
    const subtitle = header.querySelector<HTMLElement>('.gg-pane-heading-subtitle')
    expect(rect.height).toBe(52)
    expect([getComputedStyle(text).fontSize, getComputedStyle(text).lineHeight, text.getBoundingClientRect().height]).toEqual(['16px', '24px', 24])
    expect(copy.height).toBe(index ? 42 : 24)
    expect(copy.top - rect.top).toBe(index ? 5 : 14)
    if (subtitle) expect([getComputedStyle(subtitle).fontSize, getComputedStyle(subtitle).lineHeight]).toEqual(['12px', '18px'])
    const buttons = [...header.querySelectorAll('button')].filter(button => !title.contains(button))
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      const hit = button.getBoundingClientRect()
      expect([hit.width, hit.height, hit.top - rect.top]).toEqual([44, 44, 4])
    }
  }
})
