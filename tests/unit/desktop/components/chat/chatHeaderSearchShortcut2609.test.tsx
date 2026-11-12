// @vitest-environment jsdom
//
// #2609 页头 ⋯ 里「搜索聊天记录」后面写的快捷键,是真正跑它的那一个(app.find,含用户改过的绑定),按本平台的键写:
// macOS ⌘F,Windows / Linux Ctrl+F。Windows 真机 Beta 上原来写死 ⌘F。
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'
import { appSettingsMetaQueryKey } from '../../../../../apps/desktop/src/session/renderer/features/settings/app-settings-client'
import { queryClient } from '../../../../../apps/desktop/src/session/renderer/lib/query-client'

const platform = vi.hoisted(() => ({ current: 'windows' as 'mac' | 'windows' | 'linux' }))
vi.mock('@tanstack/react-hotkeys', async (original) => ({
  ...await original<typeof import('@tanstack/react-hotkeys')>(),
  detectPlatform: () => platform.current,
}))
vi.mock('@/lib/chatPinSettings', () => ({ readChatPinSettings: async () => ({ topicIds: [] }), setChatPinPreference: vi.fn(), watchChatPinSettings: () => () => {} }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => {
  harness.cleanup()
  queryClient.removeQueries({ queryKey: appSettingsMetaQueryKey('keyboard') })
})

async function searchShortcut(isRoomChat: boolean) {
  await renderWithAppProviders(harness, createNode(ChatHeaderActions, {
    isGroupChat: isRoomChat,
    isRoomChat,
    infoShown: false,
    showHeaderMenu: true,
    moreButtonRef: createRef<HTMLButtonElement>(),
    onSearch: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenInfo: vi.fn(),
    onCloseInfo: vi.fn(),
    onToggleHeaderMenu: vi.fn(),
    onCloseHeaderMenu: vi.fn(),
  }), { chat: { activeChatId: 'g', chats: [{ id: 'g', kind: isRoomChat ? 'group' : 'dm' }] as never } })
  const item = document.querySelector('[data-testid="chat-header-search-button"]')
    ?? [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('搜索'))
  expect(item, 'search item').toBeTruthy()
  return item!.querySelector('.gg-menu-item-shortcut')?.textContent ?? null
}

describe('#2609 搜索聊天记录 的快捷键按平台写', () => {
  it('Windows:Ctrl+F,❌ ⌘F', async () => {
    platform.current = 'windows'
    expect(await searchShortcut(true)).toBe('Ctrl+F')
  })

  it('macOS:⌘F', async () => {
    platform.current = 'mac'
    expect(await searchShortcut(true)).toBe('⌘F')
  })

  it('用户把查找改绑成别的键:写改过的那个', async () => {
    platform.current = 'linux'
    queryClient.setQueryData(appSettingsMetaQueryKey('keyboard'), { value: { 'app.find': 'Mod+Shift+F' } })
    expect(await searchShortcut(true)).toBe('Ctrl+Shift+F')
  })

  it('用户把查找解绑了:不写快捷键', async () => {
    platform.current = 'windows'
    queryClient.setQueryData(appSettingsMetaQueryKey('keyboard'), { value: { 'app.find': null } })
    expect(await searchShortcut(true)).toBeNull()
  })

  it('私聊页头照旧不写快捷键', async () => {
    platform.current = 'windows'
    expect(await searchShortcut(false)).toBeNull()
  })
})
