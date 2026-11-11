// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneProfile } from '../../../apps/desktop/src/mobile/assistant/PhoneProfile'
import type { PhonePageProps } from '../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import { clickElement, createReactHarness, typeInto } from '../../support/testHarness'

const rename = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [{ device_id: 'offline-mac', label: '离线 Mac' }], phones: [], loading: false, error: null, rename }) }))
vi.mock('../../../apps/desktop/src/components/devices/AssistantDevicesPage', () => ({ AssistantDevicesPage: () => <div data-testid="device-content" /> }))
vi.mock('../../../apps/desktop/src/mobile/assistant/usePhoneProfileData', async original => ({
  ...await original<object>(),
  usePhoneIntegrations: () => ({ data: { items: [{ id: 'amap', name: '高德地图', description: '' }], configured: { amap: true }, statuses: { amap: { connected: true } } }, loading: false, error: null, retry: vi.fn() }),
}))
vi.mock('../../../apps/desktop/src/components/assistant/AssistantLibraryVolume', () => ({
  AssistantLibraryVolume: ({ kind }: { kind: string }) => <div data-testid={`library-page-${kind}`} />,
}))

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => h.cleanup())
it('draws no 资料 home of its own (the assistant App does); opens the screens the App asks for', async () => {
  const props: PhonePageProps = { assistant: { id: 'a', display_name: '咕咕', avatar: null, created_at: null }, chatId: 'dm', ownerName: null,
    homeDeviceId: null, cloudDeviceId: null, home: null, machine: { state: 'opening' }, askInChat: vi.fn(), sub: null, go: vi.fn(), open: vi.fn() }
  await h.render(<PhoneProfile {...props} />)
  expect(h.container.textContent).toBe('')
  await h.render(<PhoneProfile {...props} sub="library:workspace" />)
  expect(h.container.querySelector('[data-testid="library-page-workspace"]')).not.toBeNull()
})

it.each([['devices', '设备'], ['devices:this-phone', '这台手机'], ['devices:offline-mac', '离线 Mac']])('names the %s page once without an inner back button', async (sub, title) => {
  const props: PhonePageProps = { assistant: { id: 'a', display_name: '咕咕', avatar: null, created_at: null }, chatId: 'dm', ownerName: null,
    homeDeviceId: null, cloudDeviceId: null, home: null, machine: { state: 'opening' }, askInChat: vi.fn(), sub, go: vi.fn(), open: vi.fn() }
  await h.render(<PhoneProfile {...props} />)
  expect([...h.container.querySelectorAll('h1')].map(heading => heading.textContent)).toEqual([title])
  expect(h.container.querySelector('[data-testid="device-content"]')).not.toBeNull()
  // No inner back button; a device's own page carries only the rename entry.
  expect([...h.container.querySelectorAll('button')].map(button => button.dataset.testid)).toEqual(sub === 'devices:offline-mac' ? ['settings-device-actions-rename'] : [])
})

it('renames the opened device from the phone page head through the devices store', async () => {
  const props: PhonePageProps = { assistant: { id: 'a', display_name: '咕咕', avatar: null, created_at: null }, chatId: 'dm', ownerName: null,
    homeDeviceId: null, cloudDeviceId: null, home: null, machine: { state: 'opening' }, askInChat: vi.fn(), sub: 'devices:offline-mac', go: vi.fn(), open: vi.fn() }
  await h.render(<PhoneProfile {...props} />)
  await clickElement(h.container.querySelector<HTMLElement>('[data-testid="settings-device-actions-rename"]')!)
  const input = h.container.querySelector<HTMLInputElement>('[data-testid="device-rename-input"]')!
  expect(input.value).toBe('离线 Mac')
  await typeInto(input, 'juma2')
  await clickElement([...h.container.querySelectorAll<HTMLElement>('button')].find(button => button.textContent === '保存')!)
  expect(rename).toHaveBeenCalledWith('offline-mac', 'juma2')
  expect(h.container.querySelector('[data-testid="device-rename-input"]')).toBeNull()
})
