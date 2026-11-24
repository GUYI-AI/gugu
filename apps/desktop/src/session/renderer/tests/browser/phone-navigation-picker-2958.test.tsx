import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import type { ActiveMemberProfile } from '@/components/memberProfileModels'
import { Popover } from '@/components/ui/Popover'
import { MemberProfileRoot, MemberProfilePopover } from '@/components/MemberProfilePopover'
import { PhoneRoomComposerControls } from '@/mobile/chat/PhoneRoomComposerControls'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { chat, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

const topics: TopicSummary[] = Array.from({ length: 35 }, (_, n) => ({ chat_id: `topic-${n}`, name: n < 2 ? '同名话题' : `讨论 ${n}`,
  source_message_id: `source-${n}`, creator_user_id: 'owner', last_message_at: null, message_count: 0, participant_count: 1, is_participant: true }))
const agents: MemberProfileCardModel[] = ['agent-a', 'agent-b'].map(id => ({ id, displayName: '同名智能体', avatar: null, email: null,
  type: 'agent', ownerUserId: 'another-owner', role: 'member', membership: 'current', profileScope: 'group', agentStatus: 'offline' }))
let harness: ReturnType<typeof createReactHarness> | null = null
const picked = vi.fn(), opened = vi.fn()
function Fixture() {
  const [handle] = useState(() => Popover.createHandle<ActiveMemberProfile>())
  return <><PhoneRoomComposerControls chatId="source-room" topics={topics} topicsReady current={null} onPick={picked} members={agents}
    roster={{ ready: true, failed: false, retry: () => {} }} userId="owner" profileOpener={{ handle }} onOpenAgent={opened} />
    <MemberProfileRoot handle={handle}>{profile => <MemberProfilePopover profile={profile} onClose={() => handle.close()} />}</MemberProfileRoot></>
}
async function mount() {
  await page.viewport(390, 844); setLocalePreference('zh-CN'); document.documentElement.setAttribute('data-phone-shell', '')
  harness = createReactHarness()
  Object.assign(harness.container.style, { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' })
  await renderWithAppProviders(harness, <LocalizationProvider><Fixture /></LocalizationProvider>, {
    auth: { id: 'owner' }, chat: { chats: [chat({ id: 'source-room', kind: 'group' })] }, contacts: { contacts: [] },
  })
}
afterEach(() => { harness?.cleanup(); harness = null; picked.mockClear(); opened.mockClear(); document.documentElement.removeAttribute('data-phone-shell') })

it('keeps topic search first and pinned while preserving duplicate-name selection IDs', async () => {
  await mount(); await page.getByTestId('phone-room-topics').click()
  const list = document.querySelector<HTMLElement>('.gg-phone-composer-sheet-list')!
  const search = document.querySelector<HTMLElement>('.gg-phone-navigation-search')!
  expect(list.firstElementChild?.firstElementChild).toBe(search)
  expect(getComputedStyle(search).position).toBe('sticky')
  list.scrollTop = 400; await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  expect(list.scrollTop).toBeGreaterThan(0)
  expect(search.getBoundingClientRect().top).toBeGreaterThanOrEqual(list.getBoundingClientRect().top - 1)
  const field = page.getByTestId('phone-topics-search')
  await field.fill('没有这个话题')
  await expect.element(page.getByText('没有匹配结果', { exact: true })).toBeVisible()
  await expect.element(page.getByRole('heading', { name: '话题 35', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '清除搜索' }).click()
  await expect.element(field).toHaveValue('')
  await field.fill('同名')
  expect(document.querySelectorAll('[data-testid="phone-room-topic"]')).toHaveLength(2)
  await page.elementLocator(document.querySelector<HTMLElement>('[data-topic-id="topic-1"]')!).click()
  expect(picked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chat_id: 'topic-1' }))
})

it('searches the actual Agent roster and opens the chosen profile without creating a conversation', async () => {
  await mount(); await page.getByTestId('phone-room-agents').click(); await page.getByTestId('phone-agents-search').fill('同名')
  expect(document.querySelectorAll('[data-testid="phone-room-agent"]')).toHaveLength(2)
  await page.elementLocator(document.querySelector<HTMLElement>('[data-agent-id="agent-b"]')!).click()
  await until('profile B opened by ID', () => !!document.querySelector('[data-profile-member-id="agent-b"]'))
  expect(opened).not.toHaveBeenCalled()
})
