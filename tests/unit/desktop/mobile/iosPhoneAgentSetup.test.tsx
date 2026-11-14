// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import type { IOSOwnerPublicationState } from '../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerPublication'
import type { IOSHostRuntimeSnapshot } from '../../../../apps/desktop/src/mobile/ios-host/iosHostRuntimeStore'
import { clickElement, createNode, createReactHarness, deferred } from '../../../support/testHarness'

const native = vi.hoisted(() => ({
  owner: 'owner-a', available: true, publication: null as IOSOwnerPublicationState | null,
  snapshot: null as IOSHostRuntimeSnapshot | null, listeners: new Set<() => void>(),
  retry: vi.fn(), stop: vi.fn(), retryOwner: vi.fn(), androidInstallation: vi.fn(), androidHost: vi.fn(),
}))
vi.mock('@capacitor/core', async original => ({
  ...await original<typeof import('@capacitor/core')>(),
  Capacitor: { getPlatform: () => 'ios', isNativePlatform: () => true, isPluginAvailable: () => true },
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  kind: 'capacitor', capabilities: { get phoneAgentHost() { return native.available }, phoneDevice: false },
} }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: native.owner } }) }))
vi.mock('../../../../apps/desktop/src/mobile/ios-runtime/startIOSOwnerPublication', () => ({
  getIOSOwnerPublicationSnapshot: () => native.publication,
  subscribeIOSOwnerPublication: (changed: () => void) => { native.listeners.add(changed); return () => native.listeners.delete(changed) },
  retryIOSOwnerPublication: native.retryOwner,
}))
vi.mock('../../../../apps/desktop/src/mobile/ios-host/iosHostRuntime', () => ({
  iosHostRuntime: { getSnapshot: () => native.snapshot, retry: native.retry, stopHost: native.stop },
  useIOSHostRuntimeSnapshot: () => useSyncExternalStore(
    (changed: () => void) => { native.listeners.add(changed); return () => native.listeners.delete(changed) }, () => native.snapshot),
}))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneInstallation', () => ({ readPhoneInstallation: native.androidInstallation }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDeviceRuntime', () => ({
  usePhoneDevice: native.androidHost, stopPhoneAgentHost: native.androidHost, restartPhoneAgentHost: native.androidHost,
}))
vi.mock('../../../../apps/desktop/src/components/ui/Sheet', () => ({
  Sheet: ({ children, testId }: { children: ReactNode; testId?: string }) => createElement('section', { role: 'dialog', 'data-testid': testId }, children),
}))
import { PhoneAgentSetupGate } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentSetupGate'
import { PhoneHostSetupEntry } from '../../../../apps/desktop/src/mobile/agent-watch/PhoneHostSetupEntry'
import { IOSPhoneAgentHostControl } from '../../../../apps/desktop/src/mobile/local-agent/IOSPhoneAgentHostControl'
import { verifiedPhoneHostBinding } from '../../../../apps/desktop/src/mobile/local-agent/usePhoneHostIdentity'
import { readPhoneAgentSetup, savePhoneAgentSetup } from '../../../../apps/desktop/src/mobile/local-agent/PhoneAgentSetupState'

const binding = (ownerId = native.owner, installationId = 'install-a') => ({ ownerId, installationId, deviceId: `phone-${installationId}-${ownerId}` })
function ready(installationId = 'install-a') {
  const identity = binding(native.owner, installationId)
  native.publication = { status: 'ready', binding: identity, error: null }
  native.snapshot = { phase: 'configured', binding: identity, host: { ...identity, status: 'ready', ready: true, taskTimeline: true,
    sessions: [], project: null, lastHeartbeatAt: 1, error: null, errorCode: null }, settings: { status: 'unknown', meta: null, error: null }, error: null }
}
let h: ReturnType<typeof createReactHarness>
let ownerSequence = 0
const element = (id: string) => h.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const publish = async () => act(async () => native.listeners.forEach(changed => changed()))
const product = () => createNode(PhoneAgentSetupGate, { ownerId: native.owner, children: createNode(PhoneHostSetupEntry) })
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); native.owner = `owner-${++ownerSequence}`; native.available = true; native.listeners.clear()
  ready(); native.retry.mockResolvedValue(undefined); native.stop.mockResolvedValue(undefined)
  native.androidInstallation.mockRejectedValue(new Error('Android installation must not run on iOS'))
  native.androidHost.mockImplementation(() => { throw new Error('Android host must not run on iOS') })
  h = createReactHarness()
})
afterEach(() => h.cleanup())

describe('iOS reuses the phone setup and host controls', () => {
  it('opens, completes and reopens the existing guide without Android calls or permission grants', async () => {
    await h.render(product())
    expect(element('phone-agent-setup-form')).not.toBeNull()
    expect(element('phone-setup-open-permissions')).not.toBeNull()
    expect(element('phone-permissions-list')).toBeNull()
    await clickElement(element('phone-agent-setup-finish'))
    expect(readPhoneAgentSetup(native.owner, 'install-a').completed).toBe(true)
    await clickElement(element('agent-watch-setup-phone'))
    expect(element('phone-agent-setup-form')).not.toBeNull()
    expect(native.androidInstallation).not.toHaveBeenCalled(); expect(native.androidHost).not.toHaveBeenCalled()
    expect(native.retry).not.toHaveBeenCalled(); expect(native.stop).not.toHaveBeenCalled()
  })
  it('binds progress and host controls to the current installation and owner', async () => {
    await h.render(product()); await clickElement(element('phone-agent-setup-finish'))
    ready('install-b'); await publish()
    expect(element('phone-agent-setup-form')).not.toBeNull()
    expect(readPhoneAgentSetup(native.owner, 'install-b').completed).toBe(false)
    native.owner = 'owner-b'; await h.render(product())
    expect(element('phone-setup-enable-host')).toBeNull()
    expect(verifiedPhoneHostBinding(native.owner, native.publication!)).toBeNull()
    native.publication = { status: 'retiring', binding: null, error: null }; await publish()
    expect(element('phone-setup-enable-host')).toBeNull()
  })
  it('uses existing iOS runtime stop/retry with English copy and no Android settings', async () => {
    setLocalePreference('en-US')
    await h.render(createNode(IOSPhoneAgentHostControl, { ownerId: native.owner, setup: true }))
    expect(h.container.textContent).toContain('Ready for tasks')
    expect(h.container.textContent).not.toMatch(/[\u3400-\u9fff]/)
    await clickElement(element('phone-setup-enable-host')); expect(native.stop).toHaveBeenCalledOnce()
    native.snapshot = { ...native.snapshot!, phase: 'stopped', host: null }; await publish()
    await clickElement(element('phone-setup-enable-host')); expect(native.retry).toHaveBeenCalledOnce()
    expect(native.androidHost).not.toHaveBeenCalled()
  })
  it('does not show a previous installation action failure after binding changes', async () => {
    setLocalePreference('en-US'); const pending = deferred<void>(); native.stop.mockReturnValueOnce(pending.promise)
    await h.render(createNode(IOSPhoneAgentHostControl, { ownerId: native.owner, setup: true }))
    await clickElement(element('phone-setup-enable-host'))
    ready('install-b'); await publish()
    await act(async () => pending.reject(new Error('old installation failure')))
    expect(h.container.querySelector('[role="alert"]')).toBeNull()
    expect(h.container.textContent).toContain('Ready for tasks')
  })
  it('reopens a completed installation when the explicit request arrives before verification', async () => {
    savePhoneAgentSetup(native.owner, 'install-a', { step: 'tools', dismissed: true, completed: true })
    native.publication = { status: 'publishing', binding: null, error: null }
    await h.render(product()); await clickElement(element('agent-watch-setup-phone'))
    expect(element('phone-agent-setup-form')).toBeNull()
    ready(); await publish()
    expect(element('phone-agent-setup-form')).not.toBeNull()
  })
  it('honors Later while identity is pending and permits an explicit reopen afterwards', async () => {
    setLocalePreference('en-US')
    native.publication = { status: 'publishing', binding: null, error: null }
    await h.render(product()); await clickElement(element('agent-watch-setup-phone'))
    const later = [...h.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use Gugu first')!
    await clickElement(later)
    ready(); await publish()
    expect(element('phone-agent-setup-form')).toBeNull()
    expect(readPhoneAgentSetup(native.owner, 'install-a').dismissed).toBe(true)
    await clickElement(element('agent-watch-setup-phone'))
    expect(element('phone-agent-setup-form')).not.toBeNull()
  })
  it('keeps a completed installation quiet and hides the entry when the native host is unavailable', async () => {
    savePhoneAgentSetup(native.owner, 'install-a', { step: 'tools', dismissed: true, completed: true })
    await h.render(product()); expect(element('phone-agent-setup-form')).toBeNull()
    native.available = false; await h.render(product()); expect(element('agent-watch-setup-phone')).toBeNull()
  })
})
