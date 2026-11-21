// @vitest-environment jsdom
import { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'

// 5-minute game ①: an agent makes a group game (template group-json: one tab, on the group's data file) and installs it into the
// group; the group's App list never showed it — the list held only Apps with a page of their own.
const files = vi.hoisted(() => ({ byApp: {} as Record<string, number>, asked: [] as string[] }))
vi.mock('@/components/appSlot/appsHere', () => ({
  appsHere: {
    groupFilesOpenedBy: async ({ chatId, extensionId }: { chatId: string; extensionId: string }) => {
      files.asked.push(`${chatId}/${extensionId}`)
      return { success: true, data: Array.from({ length: files.byApp[extensionId] ?? 0 }, (_, n) => ({ itemId: `${extensionId}-${n}`, name: 'game.ttt.json', displayName: 'game' })) }
    },
  },
}))

// This device's Apps are the desktop's.
vi.mock('@/components/appSlot/hereHost', () => ({ HERE_HOST: 'local' }))
const { ChatAppsPicker } = await import('@/components/chat/ChatAppsPicker')
const { tellInstalled, putInstalled } = await import('@/session/renderer/features/extensions/installed-extensions')
const { EXTENSION_API_VERSION, parseExtensionManifest } = await import('@/session/shared/extensions/manifest')

const manifest = (id: string, tab: Record<string, unknown>) =>
  parseExtensionManifest({ id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: id, ...tab }] } })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  files.byApp = { tictactoe: 1 }; files.asked = []
  harness = createReactHarness()
  tellInstalled('local', {
    extensions: [
      manifest('board', {}),
      manifest('tictactoe', { opensFiles: { chat: ['.tictactoe.json'] } }),
      manifest('sheet', { opensFiles: { chat: ['.sheet.json'] } }),
    ],
    invalid: [],
    disabled: [],
  } as never)
})
afterEach(() => {
  harness.cleanup()
  tellInstalled('local', { extensions: [], invalid: [], disabled: [] } as never)
})

const onOpen = vi.fn()
async function picker(chatId: string | null = 'g1') {
  onOpen.mockClear()
  await renderWithAppProviders(harness, createNode(ChatAppsPicker, { chatId, onOpen, mobile: true, anchor: createRef<HTMLButtonElement>(), onClose: vi.fn() }))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return [...document.querySelectorAll<HTMLElement>('[data-app-id]')].map((row) => row.dataset.appId)
}

describe('the group\'s App list holds the group game an agent installed', () => {
  it('lists an App that opens this group\'s file beside the Apps with a page of their own; one with no file here is left out', async () => {
    expect(await picker()).toEqual(['board', 'tictactoe'])
    expect(files.asked.sort()).toEqual(['g1/sheet', 'g1/tictactoe'])
  })

  it('[control] with no file of it in this group the game is not listed (it would open nothing)', async () => {
    files.byApp = {}
    expect(await picker()).toEqual(['board'])
  })

  it('hands the picked App to its caller, who opens it where it belongs (beside the chat, or as a task tab)', async () => {
    await picker()
    await clickElement(document.querySelector('[data-app-id="tictactoe"] [data-testid="chat-apps-open"]')!)
    expect(onOpen.mock.calls[0]![0]).toMatchObject({ extensionId: 'tictactoe' })
  })

  it('[control] a task (no chat folder) lists only the Apps with a page of their own and reads no folder', async () => {
    files.asked = []
    expect(await picker(null)).toEqual(['board'])
    expect(files.asked).toEqual([])
  })

  it('a switched-off game is not listed', async () => {
    putInstalled('local', (list) => ({ ...list, disabled: ['tictactoe'] }))
    expect(await picker()).toEqual(['board'])
  })
})
