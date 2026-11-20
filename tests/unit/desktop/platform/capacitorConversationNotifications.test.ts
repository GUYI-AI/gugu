// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Capacitor } from '@capacitor/core'
import type { ChatNotificationPresentation } from '../../../../apps/desktop/src/platform/types'
import { capacitorPlatform } from '../../../../apps/desktop/src/platform/capacitor'
import { setAndroidPushConfirmed } from '../../../../apps/desktop/src/mobile/android-push/androidPushState'

// #3416 The Android adapter hands a chat message that carries who spoke to the native conversation presenter, and every
// other notification to the plain outlet exactly as before. Native plugins are mocked; the adapter runs in jsdom.
const mocks = vi.hoisted(() => ({
  appState: vi.fn(),
  notificationsCheck: vi.fn(),
  createChannel: vi.fn(),
  ensureQuietChannel: vi.fn(),
  schedule: vi.fn(),
  show: vi.fn(),
  addListener: vi.fn(),
  localAddListener: vi.fn(),
}))

vi.mock('@capacitor/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@capacitor/core')>()
  return {
    ...actual,
    registerPlugin: (name: string) => name === 'GuguNotificationChannels' ? { ensureQuietChannel: mocks.ensureQuietChannel }
      : name === 'GuguChatNotifications' ? { show: mocks.show, addListener: mocks.addListener }
      : actual.registerPlugin(name),
  }
})
vi.mock('@capacitor/app', () => ({ App: { getState: mocks.appState, addListener: vi.fn() } }))
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: mocks.notificationsCheck, createChannel: mocks.createChannel, schedule: mocks.schedule,
    addListener: mocks.localAddListener,
  },
}))
vi.mock('@capacitor-mlkit/barcode-scanning', () => ({ BarcodeFormat: { QrCode: 'QR_CODE' }, BarcodeScanner: {} }))

const presentation = (over: Partial<ChatNotificationPresentation> = {}): ChatNotificationPresentation => ({
  accountId: 'account-1', messageId: 'message-1', sentAt: 1_767_225_600_000,
  conversation: { id: 'chat-1', kind: 'group', name: 'Team', avatar: 'data:image/png;base64,AAAA' },
  author: { id: 'ann', name: 'Ann', avatar: 'data:image/png;base64,BBBB' },
  ...over,
})
let pluginAvailable = true

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  pluginAvailable = true
  vi.spyOn(Capacitor, 'isPluginAvailable').mockImplementation((name) => name === 'GuguChatNotifications' ? pluginAvailable : false)
  vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android')
  mocks.appState.mockResolvedValue({ isActive: true })
  mocks.notificationsCheck.mockResolvedValue({ display: 'granted' })
  mocks.ensureQuietChannel.mockResolvedValue({ id: 'gugu-alerts-quiet-v2' })
  mocks.createChannel.mockResolvedValue(undefined)
  mocks.show.mockResolvedValue({ displayed: true })
  mocks.addListener.mockResolvedValue({ remove: vi.fn(async () => undefined) })
  mocks.localAddListener.mockResolvedValue({ remove: vi.fn(async () => undefined) })
  setAndroidPushConfirmed(false)
})

describe('capacitor conversation notifications', () => {
  it('reports the capability only while the native presenter is there', () => {
    expect(capacitorPlatform.capabilities.conversationNotifications).toBe(true)
    pluginAvailable = false
    expect(capacitorPlatform.capabilities.conversationNotifications).toBe(false)
  })

  it('hands a message that carries who spoke to the conversation presenter, not the plain outlet', async () => {
    await expect(capacitorPlatform.showNotification({ title: 'Team', body: 'hi all', chatId: 'chat-1', presentation: presentation() }))
      .resolves.toMatchObject({ displayed: true })
    expect(mocks.schedule).not.toHaveBeenCalled()
    expect(mocks.show).toHaveBeenCalledExactlyOnceWith({
      channelId: 'gugu-alerts', body: 'hi all', silent: false, accountId: 'account-1', messageId: 'message-1',
      sentAt: 1_767_225_600_000, update: false,
      conversation: { id: 'chat-1', kind: 'group', name: 'Team', avatar: 'data:image/png;base64,AAAA' },
      author: { id: 'ann', name: 'Ann', avatar: 'data:image/png;base64,BBBB' },
    })
  })

  it('uses the quiet channel when the sound is off, and marks a picture refresh as an update', async () => {
    await capacitorPlatform.showNotification({ title: 'Team', body: 'hi all', chatId: 'chat-1', silent: true, presentation: presentation({ update: true }) })
    expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'gugu-alerts-quiet-v2', silent: true, update: true }))
  })

  it('keeps the plain outlet for notifications without a presentation and when the presenter is missing', async () => {
    await capacitorPlatform.showNotification({ title: 'agent finished', body: 'done', chatId: 'chat-1' })
    pluginAvailable = false
    await capacitorPlatform.showNotification({ title: 'Team', body: 'hi', chatId: 'chat-1', presentation: presentation() })
    expect(mocks.show).not.toHaveBeenCalled()
    expect(mocks.schedule).toHaveBeenCalledTimes(2)
  })

  it('does not show without the system permission, and keeps the remote outlet for a backgrounded app', async () => {
    mocks.notificationsCheck.mockResolvedValue({ display: 'denied' })
    await expect(capacitorPlatform.showNotification({ title: 'Team', chatId: 'chat-1', presentation: presentation() }))
      .resolves.toMatchObject({ displayed: false, error: 'NOTIFICATIONS_NOT_GRANTED' })
    mocks.notificationsCheck.mockResolvedValue({ display: 'granted' })
    setAndroidPushConfirmed(true)
    mocks.appState.mockResolvedValue({ isActive: false })
    await expect(capacitorPlatform.showNotification({ title: 'Team', chatId: 'chat-1', kind: 'chat_message', presentation: presentation() }))
      .resolves.toMatchObject({ displayed: false, error: 'APP_NOT_ACTIVE' })
    expect(mocks.show).not.toHaveBeenCalled()
  })

  it('reports a presenter that did not show it as not displayed', async () => {
    mocks.show.mockResolvedValue({ displayed: false })
    await expect(capacitorPlatform.showNotification({ title: 'Team', chatId: 'chat-1', presentation: presentation({ update: true }) }))
      .resolves.toMatchObject({ success: true, displayed: false })
  })
})

describe('conversation notification taps', () => {
  it('forwards a tap on a conversation notification as its chat, next to the plain outlet taps', () => {
    let tap: (data: Record<string, unknown>) => void = () => undefined
    mocks.addListener.mockImplementation(async (_event, listener) => { tap = listener; return { remove: vi.fn(async () => undefined) } })
    const listener = vi.fn()
    const stop = capacitorPlatform.subscribeNotificationClicks!(listener)
    expect(mocks.addListener).toHaveBeenCalledWith('opened', expect.any(Function))
    expect(mocks.localAddListener).toHaveBeenCalledWith('localNotificationActionPerformed', expect.any(Function))
    tap({ chatId: 'chat-1', accountId: 'account-1' })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1' })
    tap({ chatId: '' })
    tap({ chatId: 42 })
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })

  it('removes the conversation handle on unsubscribe, also one that arrives late', async () => {
    const remove = vi.fn(async () => undefined)
    const registration = Promise.withResolvers<{ remove: () => Promise<void> }>()
    mocks.addListener.mockReturnValue(registration.promise)
    const stop = capacitorPlatform.subscribeNotificationClicks!(vi.fn())
    stop()
    registration.resolve({ remove })
    await registration.promise
    await Promise.resolve()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('does not listen for conversation taps where the presenter is missing', () => {
    pluginAvailable = false
    const stop = capacitorPlatform.subscribeNotificationClicks!(vi.fn())
    expect(mocks.addListener).not.toHaveBeenCalled()
    stop()
  })
})
