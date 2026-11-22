// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { focusManager, notifyManager, onlineManager } from '@tanstack/react-query'
import { toast } from 'sonner'
import { persistentNotices, dismissNotice } from '../../../../apps/desktop/src/lib/notices'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { FileStorageNotice } from '../../../../apps/desktop/src/components/chat/FileStorageNotice'
import { queryClient as fileStorageUsageClient } from '../../../../apps/desktop/src/lib/replica'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'

const rpc = vi.hoisted(() => vi.fn())
const translation = vi.hoisted(() => ({ t: (key: string, values?: { used: string; limit: string }) => key + (values ? ` ${values.used} / ${values.limit}` : '') }))
vi.mock('@/lib/supabase', async (original) => ({ ...await original<typeof import('@/lib/supabase')>(), chatDb: { rpc } }))
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => translation }))
// Exercise notify's stable-key/dismissal logic; replace only the third-party delivery boundary.
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }) }))

const healthy = { used_and_reserved_bytes: 100, limit_bytes: 1000, warning: false, full: false }
const warning = { ...healthy, used_and_reserved_bytes: 900, warning: true }
const unavailable = { data: null, error: { message: 'controlled unavailable', code: '503' } }
let sequence = 0
describe('group manager storage notice', () => {
  let harness: ReturnType<typeof createReactHarness>
  let chatId: string
  beforeEach(() => {
    vi.useFakeTimers()
    chatId = `storage-group-${++sequence}`
    harness = createReactHarness()
    fileStorageUsageClient.clear()
    vi.clearAllMocks()
    rpc.mockReset().mockResolvedValue({ data: healthy, error: null })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    notifyManager.setNotifyFunction(callback => { act(callback) })
    notifyManager.setScheduler(callback => { callback() })
  })
  afterEach(() => {
    harness.cleanup()
    for (const banner of persistentNotices.read()) dismissNotice(banner.key)
    fileStorageUsageClient.clear()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    notifyManager.setNotifyFunction(callback => { callback() })
    notifyManager.setScheduler(callback => { setTimeout(callback, 0) })
    vi.useRealTimers()
  })
  async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
  async function render(role: ChatItem['my_role'] = 'admin', messages: MessageItem[] = [], kind: ChatItem['kind'] = 'group', copies = 1) {
    await renderWithAppProviders(harness, createElement(Fragment, null, ...Array.from({ length: copies }, (_, key) => createElement(FileStorageNotice, { key, chatId }))), {
      chat: { chats: [chat({ id: chatId, kind, my_role: role })], messages },
    })
    await tick()
  }
  // The storage warning is a persistent notice: it lives in the banner slot (lib/notices), not in the toast strip.
  const shown = () => persistentNotices.read().find((banner) => banner.title?.startsWith('attachmentView.storage'))
  const attachment = (id: string) => message({ chat_id: chatId, id, content_type: 'attachment' })

  it.each(['owner', 'admin'] as const)('reads only the existing metadata RPC as the actual %s account', async role => {
    await render(role)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('file_transfer_group_usage', { p_chat: chatId, p_as: 'user-1' })
    expect(harness.container.textContent).toBe('')
    expect(shown()).toBeUndefined()
  })
  it('does not query for ordinary members, unknown roles or private chats', async () => {
    await render('member'); await render(null); await render('owner', [], 'dm')
    expect(rpc).not.toHaveBeenCalled()
    expect(shown()).toBeUndefined()
  })
  it('keeps a failed background read out of the composer without a retry row', async () => {
    rpc.mockResolvedValue(unavailable)
    await render()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(harness.container.querySelector('[role="status"]')).toBeNull()
    expect(harness.container.querySelector('button')).toBeNull()
    expect(harness.container.textContent).toBe('')
    expect(toast.error).not.toHaveBeenCalled()
    expect(shown()).toBeUndefined()
  })
  it.each([false, true])('uses one shared notice with verified used/reserved bytes, never an inline strip (%s)', async full => {
    rpc.mockResolvedValue({ data: { ...warning, full }, error: null })
    await render()
    expect(harness.container.querySelector('[role="status"]')).toBeNull()
    expect(harness.container.textContent).toBe('')
    expect(shown()?.title).toBe(`${full ? 'attachmentView.storageFull' : 'attachmentView.storageWarning'} 900 B / 1000 B`)
    expect(shown()).toMatchObject({ ongoing: true, tier: 'warning' })
    expect(toast.warning).not.toHaveBeenCalled()
    const listener = vi.fn()
    window.addEventListener(UI_EVENTS.openApp, listener)
    shown()!.action!.onClick()
    expect(listener.mock.calls[0][0].detail).toEqual({ extensionId: 'workspace', chatId })
    window.removeEventListener(UI_EVENTS.openApp, listener)
  })
  it.each([unavailable, { data: {}, error: null }])('retries errors/invalid data with capped backoff and local diagnostics, never zero usage (%s)', async refusal => {
    rpc.mockResolvedValue(refusal)
    await render()
    expect(rpc).toHaveBeenCalledTimes(1)
    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
      await tick(delay - 1)
      expect(rpc).toHaveBeenCalledTimes(index + 1)
      await tick(1)
      expect(rpc).toHaveBeenCalledTimes(index + 2)
    }
    expect(console.error).toHaveBeenCalledWith('[files/storage-usage] could not read group file storage usage', expect.objectContaining({ chatId, error: expect.any(String) }))
    expect(shown()).toBeUndefined()
    expect(toast.error).not.toHaveBeenCalled()
    expect(harness.container.textContent).toBe('')
    expect(fileStorageUsageClient.getQueryData(['file-storage-usage', 'user-1', chatId])).toBeUndefined()
  })
  it('retains verified warning through a failed attachment refresh and clears only after a healthy read', async () => {
    rpc.mockResolvedValueOnce({ data: warning, error: null }).mockResolvedValue(unavailable)
    await render()
    const first = shown()!
    await render('admin', [attachment('file')])
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(fileStorageUsageClient.getQueryData(['file-storage-usage', 'user-1', chatId])).toEqual(warning)
    expect(shown()).toMatchObject({ key: first.key, seq: first.seq })
    rpc.mockResolvedValue({ data: healthy, error: null })
    await tick(1000)
    expect(shown()).toBeUndefined()
  })
  it.each([false, true])('shares slow requests across mounts, attachment changes, focus and polling (cached=%s)', async cached => {
    if (cached) {
      rpc.mockResolvedValue({ data: warning, error: null })
      await render()
    }
    let resolve!: (result: { data: typeof healthy; error: null }) => void
    rpc.mockImplementation(() => new Promise(done => { resolve = done }))
    await render('admin', cached ? [attachment('first')] : [], 'group', 2)
    await render('admin', [attachment('file')], 'group', 2)
    await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')) })
    await tick(120_000)
    expect(rpc).toHaveBeenCalledTimes(cached ? 2 : 1)
    await act(async () => { resolve({ data: healthy, error: null }) })
    await tick()
    expect(harness.container.textContent).toBe('')
    if (!cached) expect(shown()).toBeUndefined()
  })
  it('stops retrying after losing manager access', async () => {
    rpc.mockResolvedValue(unavailable)
    await render()
    await render('member')
    await tick(120_000)
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it.each(['focus', 'online'] as const)('resumes a paused retry when %s returns', async event => {
    rpc.mockResolvedValue(unavailable)
    await render()
    await act(async () => {
      if (event === 'focus') focusManager.setFocused(false)
      else onlineManager.setOnline(false)
    })
    await tick(1000)
    expect(rpc).toHaveBeenCalledTimes(1)
    rpc.mockResolvedValue({ data: healthy, error: null })
    await act(async () => {
      if (event === 'focus') focusManager.setFocused(true)
      else onlineManager.setOnline(true)
    })
    await tick()
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(fileStorageUsageClient.getQueryData(['file-storage-usage', 'user-1', chatId])).toEqual(healthy)
  })
  it('honors dismissal across refreshes and remounts until verified recovery starts a new incident', async () => {
    rpc.mockResolvedValue({ data: warning, error: null })
    await render()
    persistentNotices.clear(shown()!.key)
    await render('member')
    rpc.mockResolvedValue({ data: { ...warning, full: true }, error: null })
    await render()
    await tick(60_000)
    expect(shown()).toBeUndefined()
    rpc.mockResolvedValue({ data: healthy, error: null })
    await tick(60_000)
    rpc.mockResolvedValue({ data: warning, error: null })
    await tick(60_000)
    expect(shown()).toBeDefined()
  })
  it('refreshes on attachments but leaves unrelated text messages alone', async () => {
    await render()
    await render('admin', [message({ chat_id: chatId, id: 'text', content_type: 'text' })])
    expect(rpc).toHaveBeenCalledTimes(1)
    await render('admin', [attachment('file')])
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})
