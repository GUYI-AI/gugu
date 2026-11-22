// @vitest-environment jsdom
import { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'

// 5-minute game ①: an agent makes a group game (template group-json: one tab, on the group's data file) and installs it into the
// group; the group's App list never showed it — the list held only Apps with a page of their own. Owner 11-21: an App that
// opens files (研究树) came only after a read of the chat's folder; the list is what the Apps declare, whole when it opens.

// This device's Apps are the desktop's.
vi.mock('@/components/appSlot/hereHost', () => ({ HERE_HOST: 'local' }))
const { ChatAppsPicker } = await import('@/components/chat/ChatAppsPicker')
const { installedExtensions } = await import('@/session/renderer/features/extensions/installed-extensions')
const { EXTENSION_API_VERSION, parseExtensionManifest } = await import('@/session/shared/extensions/manifest')

const manifest = (id: string, tab: Record<string, unknown>) =>
  parseExtensionManifest({ id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: id, ...tab }] } })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  installedExtensions.set(['local'], {
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
  installedExtensions.set(['local'], { extensions: [], invalid: [], disabled: [] } as never)
})

const onOpen = vi.fn()
async function picker(chatId: string | null = 'g1') {
  onOpen.mockClear()
  await renderWithAppProviders(harness, createNode(ChatAppsPicker, { chatId, onOpen, mobile: true, anchor: createRef<HTMLButtonElement>(), onClose: vi.fn() }))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return [...document.querySelectorAll<HTMLElement>('[data-app-id]')].map((row) => row.dataset.appId)
}

describe('the group\'s App list is the Apps that open in a chat, as they declare it', () => {
  it('lists the Apps that open chat files beside the Apps with a page of their own, at once: nothing is read first', async () => {
    expect(await picker()).toEqual(['board', 'tictactoe', 'sheet'])
    expect(document.querySelector('[data-unknown]')).toBeNull()
  })

  it('hands the picked App to its caller, who opens it where it belongs (beside the chat, or as a task tab)', async () => {
    await picker()
    await clickElement(document.querySelector('[data-app-id="tictactoe"] [data-testid="chat-apps-open"]')!)
    expect(onOpen.mock.calls[0]![0]).toMatchObject({ extensionId: 'tictactoe', kind: 'tictactoe.main' })
  })

  it('[control] a task (no chat folder) lists only the Apps with a page of their own', async () => {
    expect(await picker(null)).toEqual(['board'])
  })

  it('a switched-off game is not listed', async () => {
    installedExtensions.set(['local'], (list) => list && ({ ...list, disabled: ['tictactoe'] }))
    expect(await picker()).toEqual(['board', 'sheet'])
  })
})
