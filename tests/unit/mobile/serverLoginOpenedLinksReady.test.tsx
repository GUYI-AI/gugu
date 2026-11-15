// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ServerLoginApproveHost } from '../../../apps/desktop/src/mobile/server-login/ServerLoginApproveHost'

const m = vi.hoisted(() => ({
  chatsRead: false,
  open: vi.fn(async () => true),
  subscribe: vi.fn(),
  stop: vi.fn(),
  toast: vi.fn(),
  scan: vi.fn(),
  t: (key: string) => key,
}))
vi.mock('../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chatsRead: m.chatsRead }) }))
vi.mock('../../../apps/desktop/src/lib/guguLinks', () => ({ openLink: m.open }))
vi.mock('../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => true }))
vi.mock('../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: m.toast }) }))
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: m.t }) }))
vi.mock('../../../apps/desktop/src/platform', () => ({ platform: { subscribeOpenedLinks: m.subscribe } }))
vi.mock('../../../apps/desktop/src/mobile/server-login/ServerLoginApproveSheet', () => ({ ServerLoginApproveSheet: () => null }))

it('consumes the native launch URL only after the signed-in chat list is ready', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const href = 'gugu-beta://chat/00000000-0000-4000-8000-000000000001'
  m.subscribe.mockImplementation((listener: (url: string) => void) => { listener(href); return m.stop })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(ServerLoginApproveHost, { active: false, onScanRoute: m.scan })))
    await act(async () => root.render(createElement(ServerLoginApproveHost, { active: true, onScanRoute: m.scan })))
    expect(m.subscribe).not.toHaveBeenCalled()
    expect(m.open).not.toHaveBeenCalled()
    m.chatsRead = true
    await act(async () => root.render(createElement(ServerLoginApproveHost, { active: true, onScanRoute: m.scan })))
    expect(m.open).toHaveBeenCalledExactlyOnceWith(href)
    await act(async () => root.render(createElement(ServerLoginApproveHost, { active: true, onScanRoute: m.scan })))
    expect(m.subscribe).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
  expect(m.stop).toHaveBeenCalledOnce()
})

it('an invite link the site hands to the App takes the camera-scan route, not openLink', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  m.chatsRead = true
  m.open.mockClear()
  m.subscribe.mockImplementation((listener: (url: string) => void) => { listener('gugu://gugu.nextmind.space/j/?208803.n4bQgYhMfWWaL-qgxVrQFQ'); return m.stop })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(ServerLoginApproveHost, { active: true, onScanRoute: m.scan })))
    expect(m.scan).toHaveBeenCalledExactlyOnceWith({ nav: 'group_join', publicId: 208803, joinToken: '9f86d081884c7d659a2feaa0c55ad015' })
    expect(m.open).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
