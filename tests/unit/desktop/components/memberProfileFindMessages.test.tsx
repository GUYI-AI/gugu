// @vitest-environment jsdom
// 「查找 TA 的消息」:资料卡里的这一钮打开的就是全局搜索,带这个会话的 in: 和这个人的 from: 两枚可删标签,
// 不是另一套界面。只有知道自己开在哪个会话里的卡才有这一钮。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { pressProfileOpener, profileCardWithOpener } from '../../../support/memberProfileCard'

vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => false }))

const { commandRegistry } = await import('../../../../apps/desktop/src/session/renderer/lib/commands/registry')
const { resetSearchSession, useSearchSession } = await import('../../../../apps/desktop/src/session/renderer/features/global-search/search-session')

const member: MemberProfileCardModel = { id: 'u-a', displayName: 'Alice', avatar: null, email: null, type: 'human', role: 'member', membership: 'current', profileScope: 'group' }
const button = () => document.body.querySelector<HTMLElement>('[data-testid="member-profile-find-messages-button"]')
function SearchSnapshot() { return createNode('output', { 'data-search-session': true }, JSON.stringify(useSearchSession())) }

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  resetSearchSession()
})

describe('member profile 「查找 TA 的消息」', () => {
  it('opens the global search scoped to this conversation and this member, and closes the card', async () => {
    const openPanel = vi.fn()
    const unregister = commandRegistry.register({ scopeId: 'app', getCommands: () => [{ id: 'app.globalSearch', execute: openPanel }] })
    const onClose = vi.fn()
    try {
      await renderWithAppProviders(harness, createNode('div', null,
        profileCardWithOpener({ member }, { onClose, searchChatId: 'chat-1' }), createNode(SearchSnapshot)), { chat: {}, contacts: {} })
      await pressProfileOpener()
      await clickElement(button()!)
      expect(openPanel).toHaveBeenCalledOnce()
      expect(onClose).toHaveBeenCalledOnce()
      expect(JSON.parse(harness.container.querySelector('[data-search-session]')!.textContent!).chips)
        .toEqual([{ kind: 'in', chatId: 'chat-1' }, { kind: 'from', userId: 'u-a', name: 'Alice' }])
    } finally { unregister() }
  })

  it('has no such button when the card does not know its conversation', async () => {
    await renderWithAppProviders(harness, profileCardWithOpener({ member }, { onClose: vi.fn() }), { chat: {}, contacts: {} })
    await pressProfileOpener()
    expect(document.body.querySelector('[data-testid="member-profile-send-message-button"], .gg-pop')).not.toBeNull()
    expect(button()).toBeNull()
  })
})
