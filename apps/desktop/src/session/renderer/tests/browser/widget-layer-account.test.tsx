import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ExtensionViewLayer } from '@renderer/features/extensions/extension-view-layer'
import { extensionViewStore, residentPageKey, residentPlace } from '@renderer/features/extensions/extension-view-store'
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store'
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest'
import { publishSelfIdentity } from '@/lib/selfIdentityBridge'

const accounts = vi.hoisted(() => ({ set: vi.fn(async () => {}) }))
vi.mock('@/lib/widgetSnapshots', async original => ({ ...(await original<object>()), widgetSnapshots: { setAccount: accounts.set, capture: () => null } }))

const manifest = parseExtensionManifest({
  id: 'counter', name: 'Counter', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [{ name: 'card', title: 'Counter', widget: { height: 200 } }] },
})
const kind = 'counter.card'
let harness: ReturnType<typeof createReactHarness>, slot: HTMLElement

afterEach(() => {
  harness?.cleanup()
  slot?.remove()
  act(() => { extensionViewStore.forgetOpened(kind); installedExtensionsStore.manifests = [] })
  publishSelfIdentity(null)
  vi.unstubAllGlobals()
})

// The layer is in the task workspace's own React root, outside the shell's AuthContext: the signed-in account reaches
// it through the shell's identity bridge, as the workspace's chats and search learn it.
it('mounts a widget page claimed by the signed-in account, clear until painted, and drops it when the account changes', async () => {
  vi.stubGlobal('electronAPI', { eventOn: () => () => {}, invoke: async (channel: string) => {
    if (channel === 'extensions.activate') return { success: true, data: { partition: 'counter', entryUrl: 'about:blank' } }
    throw new Error(`Unexpected bridge call: ${channel}`)
  } })
  act(() => { installedExtensionsStore.manifests = [manifest] })
  publishSelfIdentity({ userId: 'reader', displayName: null, guguNumber: null })
  harness = createReactHarness()
  slot = document.createElement('div')
  Object.assign(slot.style, { position: 'fixed', top: '20px', left: '20px', width: '400px', height: '200px' })
  document.body.append(slot)
  await harness.render(<ExtensionViewLayer />)
  expect(accounts.set).toHaveBeenLastCalledWith('reader')
  const widget = { id: 'widget', originMessageId: 'origin', messageId: 'reference', data: {}, senderId: 'sender' }
  act(() => { extensionViewStore.claim(kind, { chatId: 'chat', accountId: 'reader', tabId: 'widget:widget', widget, element: slot }) })
  await until('the claimed widget page is mounted in the layer', () => !!harness.container.querySelector('webview'))
  // Until its page has painted, the box is clear: the slot's snapshot below shows, not a blank box.
  const box = () => harness.container.querySelector<HTMLElement>('[data-extension-view]')!
  expect(box().className).not.toContain('bg-background')
  act(() => extensionViewStore.widgetPainted(residentPageKey(kind, residentPlace({ chatId: 'chat', widget }))))
  expect(box().className).toContain('bg-background')
  await act(async () => publishSelfIdentity({ userId: 'other', displayName: null, guguNumber: null }))
  await until('the previous account\'s widget page is gone', () => !harness.container.querySelector('webview'))
  expect(extensionViewStore.residentPages.size).toBe(0)
  expect(accounts.set).toHaveBeenLastCalledWith('other')
})
