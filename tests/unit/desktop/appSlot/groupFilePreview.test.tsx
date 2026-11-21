import type { MessageItem } from '@gugu/core/shared/types/chat'
// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearViewState } from '../../../../apps/desktop/src/lib/viewStateTable'
import { followRendererSession } from '../../../../apps/desktop/src/lib/replica'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'

const boundary = vi.hoisted(() => ({
  mobile: false,
  read: vi.fn(),
  document: vi.fn(),
  forward: vi.fn(),
  signed: vi.fn(),
  local: vi.fn(),
  save: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  preview: vi.fn(),
  image: vi.fn(),
  previewContents: new Map<string, string>(),
}))
vi.mock('@/components/preview/html-preview-registration', () => ({ registerHtmlPreview: boundary.preview }))
vi.mock('@/platform', () => ({ platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } } }))
vi.mock('@/hooks/useMobileShell', () => ({ useMobileShell: () => boundary.mobile, readMobileShell: () => boundary.mobile }))
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: vi.fn(async () => ({ error: null })) } }))
vi.mock('@/lib/attachmentBytes', () => (((mocked: Record<string, unknown>) => ({ ...mocked, shownAttachmentBytes: async (source: unknown, progress?: unknown) => { const read = mocked.attachmentBytes as (...args: unknown[]) => Promise<{ status: string }>; const bytes = await read(source, 'shown', undefined, undefined, progress); if (bytes.status !== 'ready') throw new Error(bytes.status); return bytes } }))({
  attachmentBytes: boundary.read,
  attachmentPreview: boundary.signed, localAttachmentCopy: boundary.local,
  openAttachmentInSystemApp: boundary.open,
  openAttachmentImages: boundary.image,
  sourceKeyOf: (source: { itemId: string; version: number }) => `${source.itemId}@${source.version}`,
})))
vi.mock('@/lib/chatFolder', () => ({ readChatFolderText: boundary.document, rendererFileServiceUrl: () => 'https://files.test' }))
vi.mock('@/lib/download', () => ({ downloadBlob: boundary.save }))
vi.mock('@/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => true, marketOffers: async () => ({ success: true, data: [] }), onMarketChanged: () => () => {}, groupFileOpener: vi.fn(), setOpenWithDefault: vi.fn() },
}))
vi.mock('@/components/extensionBundle/sharedPackages', async (original) => ({
  ...(await original<object>()), chatPackageCards: async () => (await import('./chatTabsHarness')).sharedCards.answer() }))

const { AppPeek } = await import('@/components/appSlot/AppPeek')
const { ask, linkShell, pill, shownItem } = await import('./chatTabsHarness')
const { folderItem, isFolderItem } = await import('@/session/renderer/features/chats/chat-tabs/chat-panel-item')
const { chatAlone, chatPaneOf, closeChatTab, openPanelItem, panelFull, panelTabsOf, shownPanelTab } = await import('@/session/renderer/features/chats/chat-tabs/chat-layouts')
import { tabFullscreen } from '@/session/renderer/features/tabs/tab-fullscreen'
const { installedExtensions } = await import('@/session/renderer/features/extensions/installed-extensions')
const { appsHere } = await import('@/components/appSlot/appsHere')
const workspace = { id: 'workspace', name: '文件夹', version: '0.2.53', apiVersion: 3, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: '文件夹', opensFiles: { chat: ['.md', '.json'] } }] } }
const candidate = { extensionId: 'workspace', tabKind: 'workspace.main', tabTitle: '文件夹', app: { name: '文件夹', defaultLocale: 'zh-CN' }, onlyTab: true, state: false, suffix: '.md' }
let harness: ReturnType<typeof createReactHarness>
const checkVisibility = HTMLElement.prototype.checkVisibility
const detail = (suffix: string) => ({ chatId: 'preview-group', itemId: `file-${suffix}`, name: `report.${suffix}`, typedName: `report.${suffix}`, file: { document: false, contentType: suffix === 'html' ? 'text/html' : suffix === 'mp4' ? 'video/mp4' : 'application/octet-stream', version: 3, size: 1024 }, choice: { kind: 'none' as const } })
/** The chat's tabs drawn (under the shell's link handling), then the file asked of it — with its host's answer, or as a
 *  link (`supplied` false: the shell asks the host, then hands the chat the answer). */
const slot = async (opener: ReturnType<typeof detail>, supplied = true, extra: { visible?: boolean; message?: MessageItem; tabbed?: boolean; restore?: () => void; from?: string } = {}) => {
  await harness.render(linkShell({ chatId: opener.chatId, visible: extra.visible ?? true, tabbed: extra.tabbed, mobile: boundary.mobile, onForward: boundary.forward }, 'viewer'))
  if (!supplied) {
    await act(async () => { void pill(opener.itemId) })
    return
  }
  ask(opener.chatId, { itemId: opener.itemId, ...(extra.restore ? { restore: extra.restore } : {}), ...(extra.message ? { message: extra.message } : {}), opener: opener as never, ...(extra.from ? { from: extra.from } : {}) })
}
const redraw = (chatId: string, extra: { visible?: boolean } = {}) =>
  harness.render(linkShell({ chatId, visible: extra.visible ?? true, mobile: boundary.mobile, onForward: boundary.forward }, 'viewer'))
beforeEach(() => {
  // Signed in, as the harness's person (user-1): the group's shared packages are read for an account.
  followRendererSession('SIGNED_IN', 'user-1')
  harness = createReactHarness()
  HTMLElement.prototype.checkVisibility = () => false
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  boundary.mobile = false
  vi.clearAllMocks()
  boundary.previewContents.clear()
  boundary.preview.mockImplementation(async (html: string) => {
    const url = `blob:group-preview-${boundary.previewContents.size}`
    boundary.previewContents.set(url, html)
    return { ok: true, url, update: vi.fn(), release: vi.fn() }
  })
  boundary.local.mockResolvedValue(null)
  boundary.signed.mockResolvedValue({ status: 'ready', purpose: 'preview', revision: { source: 'managed-object' }, content: async () => ({ url: 'https://media.test/signed.mp4', expiresAt: Date.now() + 60_000 }), dispose: vi.fn() })
  boundary.read.mockResolvedValue({ status: 'ready', blob: { text: async () => '<h1>lane report</h1>', arrayBuffer: async () => new ArrayBuffer(4) } })
  boundary.document.mockResolvedValue({ text: '<h1>live report</h1>' })
  boundary.save.mockResolvedValue(undefined)
  for (const tab of panelTabsOf('preview-group')) closeChatTab('preview-group', tab.tabId)
  act(() => installedExtensions.set(['local'], { extensions: [workspace], invalid: [] } as never))
})
// Where each resource last opened is the account's (tab-placement memory): each case starts with none remembered (after
// the setup above, whose closing of tabs is itself remembered).
beforeEach(() => { clearViewState({ conversation: '', panel: 'tab-placement' }) })
afterEach(async () => {
  harness.cleanup()
  ;(await import('@/lib/replica')).followRendererSession('SIGNED_OUT', null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  HTMLElement.prototype.checkVisibility = checkVisibility
  act(() => installedExtensions.set(['local'], { extensions: [], invalid: [] } as never))
})

/** What the tab's × does in the strip: the engine asks the tab, and its close hands back what opened it. */
async function closeFromTab(chatId: string) {
  const tab = shownPanelTab(chatId)!
  await act(async () => { chatPaneOf(chatId, tab.tabId)!.requestCloseTab(tab.tabId) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

describe('unclaimed group files use the message preview from every entry', () => {
  it.each([false, true])('an image opened from the folder opens in the image viewer over it, the folder left as it is (mobile=%s)', async (mobile) => {
    boundary.mobile = mobile
    boundary.read.mockResolvedValue({ status: 'ready', blob: new Blob(['png'], { type: 'image/png' }) })
    // A chat of its own per run: the chat's tabs (module state) of the other run are not this one's.
    const chatId = `preview-group-${mobile ? 'phone' : 'desktop'}`
    const folder = openPanelItem(chatId, folderItem())
    const file = { ...detail('png'), chatId }
    const among = [{ itemId: 'file-a', version: 1, name: 'a.png', contentType: 'image/png' }, { itemId: file.itemId, version: 3, name: file.name, contentType: 'image/png' }]
    const origin = { x: 40, y: 60, width: 120, height: 120 }
    await slot({ ...file, among, origin } as never, true, { from: shownPanelTab(chatId)!.tabId })
    await until('the viewer asked', () => boundary.image.mock.calls.length === 1)
    expect(boundary.image).toHaveBeenCalledWith(among, 1, { chatId: file.chatId }, origin)
    expect(shownPanelTab(file.chatId)?.tabId).toBe(folder)
    expect(panelTabsOf(file.chatId)).toHaveLength(1)
    expect(isFolderItem(shownItem(file.chatId)!)).toBe(true)
    expect(harness.container.querySelector('[data-testid="message-file-preview-panel"]')).toBeNull()
  })
  it('an image the folder opens in a new tab is drawn there, and one that cannot be drawn says so', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:broken-png')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    boundary.read.mockResolvedValue({ status: 'ready', blob: new Blob(['not a png'], { type: 'image/png' }) })
    openPanelItem('preview-group', folderItem())
    await slot({ ...detail('png'), intent: 'newTab' } as never, true, { from: shownPanelTab('preview-group')!.tabId })
    expect(boundary.image).not.toHaveBeenCalled()
    await until('the picture tried', () => harness.container.querySelector('[data-testid="message-file-preview-panel"] img') !== null)
    await act(async () => harness.container.querySelector('[data-testid="message-file-preview-panel"] img')!.dispatchEvent(new Event('error')))
    expect(harness.container.querySelector('[data-testid="message-file-preview-panel"] img')).toBeNull()
    expect(harness.container.querySelector('[data-testid="message-file-preview-panel"]')!.textContent).toContain('无法渲染此文件')
  })
  it.each(['preview-group', 'another-chat'])('an image link retains its originating message in %s', async (chatId) => {
    const file = { ...detail('png'), chatId }
    const message = { id: 'image-reference', chat_id: chatId } as MessageItem
    await slot(file, true, { message })
    expect(boundary.image).toHaveBeenCalledWith([{ itemId: file.itemId, version: 3, name: file.name, contentType: file.file.contentType }], 0, { chatId, messageId: message.id }, undefined)
  })
  it('renews an expired video preview after a late Range failure, preserving position without downloading the original', async () => {
    let now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const content = vi.fn(async () => ({ url: `https://media.test/lease-${now}.mp4`, expiresAt: now + 60_000 })), dispose = vi.fn()
    boundary.signed.mockResolvedValue({ status: 'ready', purpose: 'preview', revision: { source: 'managed-object' }, content, dispose })
    await slot(detail('mp4'))
    await until('first short playback lease', () => harness.container.querySelector('video')?.src.includes(`lease-${now}`) === true)
    const video = harness.container.querySelector('video')!, play = vi.spyOn(video, 'play').mockResolvedValue()
    video.currentTime = 42; Object.defineProperty(video, 'paused', { value: false, configurable: true })
    now += 60_001
    await act(async () => video.dispatchEvent(new Event('error')))
    await until('renewed playback lease', () => video.src.includes(`lease-${now}`))
    await act(async () => video.dispatchEvent(new Event('loadedmetadata')))
    expect(video.currentTime).toBe(42); expect(play).toHaveBeenCalledTimes(1); expect(content).toHaveBeenCalledTimes(2)
    expect(boundary.read).not.toHaveBeenCalled(); expect(boundary.open).not.toHaveBeenCalled()
    await harness.render(null); expect(dispose).toHaveBeenCalledTimes(1)
  })
  it('a fresh video lease failure is displayed once instead of repeatedly signing or fetching the original', async () => {
    const content = vi.fn(async () => ({ url: 'https://media.test/fresh.mp4', expiresAt: Date.now() + 60_000 }))
    boundary.signed.mockResolvedValue({ status: 'ready', purpose: 'preview', revision: { source: 'managed-object' }, content, dispose: vi.fn() })
    await slot(detail('mp4'))
    await until('player ready', () => harness.container.querySelector('video') !== null)
    await act(async () => harness.container.querySelector('video')!.dispatchEvent(new Event('error')))
    expect(harness.container.querySelector('video')).toBeNull(); expect(content).toHaveBeenCalledTimes(1)
    expect(boundary.read).not.toHaveBeenCalled()
  })
  it('the phone opens its chooser above the App page; cancelling keeps that page and picking preserves its Back link', async () => {
    boundary.mobile = true
    const folder = openPanelItem('preview-group', folderItem())
    const file = { ...detail('md'), choice: { kind: 'choose' as const, suffix: '.md', candidates: [candidate] } }
    await slot(file as never, true, { from: shownPanelTab('preview-group')!.tabId })
    const chooser = () => document.querySelector('[role="dialog"] [data-testid="group-app-open-with"]')
    expect(chooser()).not.toBeNull()
    expect(harness.container.contains(chooser()), 'the chooser is portalled above the full-screen page').toBe(false)
    await act(async () => window.dispatchEvent(new Event('gugu:native-back')))
    expect(chooser()).toBeNull()
    expect(shownPanelTab('preview-group')?.tabId).toBe(folder)
    ask(file.chatId, { itemId: file.itemId, opener: file as never, from: shownPanelTab('preview-group')!.tabId })
    await act(async () => document.querySelector<HTMLButtonElement>('[data-open-with="workspace.main"]')!.click())
    expect(shownItem(file.chatId)).toMatchObject({ kind: 'workspace.main', itemId: file.itemId })
    await act(async () => chatPaneOf(file.chatId, folder!)!.go(folder!, -1))
    expect(shownPanelTab(file.chatId)?.tabId).toBe(folder)
  })

  it('the phone back key goes from a file to the folder that opened it, then to the chat', async () => {
    boundary.mobile = true
    const folder = openPanelItem('preview-group', folderItem())!
    const file = { ...detail('md'), choice: { kind: 'one' as const, candidate } }
    await slot(file as never, true, { from: folder })
    expect(shownItem(file.chatId)).toMatchObject({ kind: 'workspace.main', itemId: file.itemId })
    await act(async () => window.dispatchEvent(new Event('gugu:native-back')))
    expect(shownPanelTab(file.chatId)?.tabId).toBe(folder)
    expect(isFolderItem(shownItem(file.chatId)!)).toBe(true)
    await act(async () => window.dispatchEvent(new Event('gugu:native-back')))
    expect(shownPanelTab(file.chatId)).toBeNull()
  })

  it('a file in a tab of its own: the phone back key closes it, so it does not come back after the folder is left', async () => {
    boundary.mobile = true
    const folder = openPanelItem('preview-group', folderItem())!
    const file = { ...detail('md'), choice: { kind: 'one' as const, candidate } }
    openPanelItem(file.chatId, { kind: candidate.tabKind, itemId: file.itemId, title: file.name, fileName: file.name, typedName: file.typedName } as never, { from: folder, intent: 'newTab' })
    await redraw(file.chatId)
    expect(shownItem(file.chatId)).toMatchObject({ itemId: file.itemId })
    await act(async () => window.dispatchEvent(new Event('gugu:native-back')))
    expect(shownPanelTab(file.chatId)?.tabId).toBe(folder)
    await act(async () => window.dispatchEvent(new Event('gugu:native-back')))
    expect(shownPanelTab(file.chatId)).toBeNull()
    expect(panelTabsOf(file.chatId)).toEqual([])
  })

  it.each([false, true])('ordinary openWith plays MP4 on the host (mobile=%s)', async (mobile) => {
    boundary.mobile = mobile
    const file = detail('mp4')
    await slot(file)
    await until('the existing video player is ready', () => harness.container.querySelector('video') !== null)
    const video = harness.container.querySelector('video')!
    expect(video.src).toBe('https://media.test/signed.mp4')
    expect(video.controls).toBe(true)
    expect(video.playsInline).toBe(true)
    expect(boundary.signed).toHaveBeenCalledWith({ kind: 'item', itemId: file.itemId, version: 3 })
    expect(boundary.read).not.toHaveBeenCalled()
    expect(boundary.open).not.toHaveBeenCalled()
    const download = harness.container.querySelector('button[aria-label="下载"]')
    expect(download).not.toBeNull()
  })

  // A video this machine already has (it sent it, or opened it before) plays from those bytes: no link is asked for.
  it('plays a cloud MP4 this machine already has from its bytes, without a streaming lease', async () => {
    const dispose = vi.fn(async () => {}), content = vi.fn()
    boundary.signed.mockResolvedValue({ status: 'ready', purpose: 'preview', revision: { source: 'managed-object', sha256: 'c'.repeat(64), content_type: 'video/mp4' }, content, dispose })
    boundary.local.mockResolvedValue(new Blob(['kept video'], { type: 'video/mp4' }))
    const urls = { create: vi.fn(() => 'blob:kept-video'), revoke: vi.fn() }
    vi.stubGlobal('URL', class extends URL { static createObjectURL = urls.create; static revokeObjectURL = urls.revoke })
    await slot(detail('mp4'))
    await until('the kept video plays', () => harness.container.querySelector('video')?.getAttribute('src') === 'blob:kept-video')
    expect(boundary.local).toHaveBeenCalledWith('c'.repeat(64), 'video/mp4')
    expect(content).not.toHaveBeenCalled(); expect(boundary.read).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledTimes(1)
  })

  // A video kept on a machine has no signed link: it is read whole like any file, its bar moving while it comes.
  it('reads a held MP4 whole with its progress, then plays it from its bytes', async () => {
    const dispose = vi.fn(async () => {}), content = vi.fn()
    boundary.signed.mockResolvedValue({ status: 'ready', purpose: 'preview', revision: { source: 'local' }, content, dispose })
    let arrive!: () => void
    boundary.read.mockImplementation(async (_source: unknown, _variant: unknown, _link: unknown, _metadata: unknown, progress: (done: number, total: number) => void) => {
      progress(4, 10)
      await new Promise<void>(resolve => { arrive = resolve })
      return { status: 'ready', blob: new Blob(['held video'], { type: 'video/mp4' }) }
    })
    const urls = { create: vi.fn(() => 'blob:held-video'), revoke: vi.fn() }
    vi.stubGlobal('URL', class extends URL { static createObjectURL = urls.create; static revokeObjectURL = urls.revoke })
    await slot(detail('mp4'))
    await until('the read shows how far it has come', () => harness.container.querySelector('[data-testid="message-file-preview-loading"] progress')?.getAttribute('value') === '0.4')
    await act(async () => { arrive() })
    await until('the held video plays', () => harness.container.querySelector('video')?.getAttribute('src') === 'blob:held-video')
    expect(content).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(boundary.read).toHaveBeenCalledWith({ kind: 'item', itemId: 'file-mp4', version: 3 }, 'shown', undefined, undefined, expect.any(Function))
    await harness.render(null); expect(urls.revoke).toHaveBeenCalledWith('blob:held-video')
  })

  it('a file link and an App card resolve HTML through the same host preview', async () => {
    const file = detail('html')
    vi.mocked(appsHere!.groupFileOpener).mockResolvedValue({ success: true, data: file })
    await slot(file, false)
    await until('the report HTML is drawn', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('lane report') === true)
    expect(appsHere!.groupFileOpener).toHaveBeenCalledExactlyOnceWith({ itemId: file.itemId })
    expect(harness.container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(boundary.read).toHaveBeenCalledWith({ kind: 'item', itemId: file.itemId, version: 3 }, 'shown', undefined, undefined, expect.any(Function))
  })

  it('peek has the same content and download as ordinary openWith', async () => {
    const file = detail('html')
    await harness.render(createElement(AppPeek, { target: { kind: 'chat', detail: file }, slotKey: 'report-peek', beside: false, onClose: vi.fn() }))
    await until('peek uses the same HTML content', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('lane report') === true)
    expect(harness.container.querySelector('button[aria-label="下载"]')).not.toBeNull()
  })

  it('unsupported exe shows details and downloads only when asked, without opening it', async () => {
    const file = detail('exe')
    await slot(file)
    expect(harness.container.querySelector('[data-preview-kind="unsupported"]')).not.toBeNull()
    expect(harness.container.textContent).toContain('report.exe')
    expect(boundary.read).not.toHaveBeenCalled()
    expect(boundary.signed).not.toHaveBeenCalled()
    expect(harness.container.querySelector('button[aria-label="在系统浏览器打开"]')).toBeNull()
    await act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="下载"]')!.click())
    expect(boundary.save).toHaveBeenCalledWith(expect.anything(), 'report.exe')
    expect(boundary.open).not.toHaveBeenCalled()
  })

  it('a claimed markdown file still opens in the folder App, without fetching a host preview', async () => {
    const file = { ...detail('md'), choice: { kind: 'one' as const, candidate } }
    await slot(file as never)
    expect(shownItem(file.chatId)).toMatchObject({ kind: 'workspace.main', itemId: file.itemId })
    expect(harness.container.querySelector('[data-testid="message-file-preview-panel"]')).toBeNull()
    expect(boundary.read).not.toHaveBeenCalled()
  })

  it.each([false, true])('back restores the App a preview was opened from without closing the panel (mobile=%s)', async (mobile) => {
    boundary.mobile = mobile
    openPanelItem('preview-group', { kind: 'workspace.main', itemId: 'notes', title: 'notes.md', typedName: 'notes.md' })
    await slot(detail('exe'), true, { from: shownPanelTab('preview-group')!.tabId })
    expect(shownItem('preview-group')?.kind).toBeNull()
    const back = harness.container.querySelector<HTMLButtonElement>('button[aria-label="返回"]')
    expect(back).not.toBeNull()
    await act(async () => back!.click())
    expect(shownItem('preview-group')).toMatchObject({ kind: 'workspace.main', itemId: 'notes' })
    expect(chatAlone('preview-group')).toBe(false)
  })

  it.each([false, true])('back from the folder preview restores the list and keeps the panel open (mobile=%s)', async (mobile) => {
    boundary.mobile = mobile
    const folder = openPanelItem('preview-group', folderItem())
    await slot(detail('exe'), true, { from: shownPanelTab('preview-group')!.tabId })
    const back = harness.container.querySelector<HTMLButtonElement>('button[aria-label="返回"]')
    expect(back).not.toBeNull()
    await act(async () => back!.click())
    expect(shownPanelTab('preview-group')?.tabId).toBe(folder)
    expect(isFolderItem(shownItem('preview-group'))).toBe(true)
    expect(harness.container.querySelector('[data-testid="message-file-preview-panel"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="group-app-slot"]')).not.toBeNull()
  })

  it('closing the tabbed binary preview closes its context without leaving a stale source tab', async () => {
    const source = openPanelItem('preview-group', { kind: 'workspace.main', itemId: 'notes', title: 'notes.md' })
    const file = detail('exe')
    await slot(file, true, { tabbed: true, from: shownPanelTab('preview-group')!.tabId })
    // In a block the tab is the file's name, its × and its maximize: no header, no row of its own.
    expect(harness.container.querySelector('header')).toBeNull()
    expect(harness.container.querySelector('button[aria-label="关闭"]')).toBeNull()
    await closeFromTab(file.chatId)
    expect(panelTabsOf('preview-group').some(tab => tab.tabId === source)).toBe(false)
    expect(panelTabsOf('preview-group').some((tab) => tab.item.itemId === file.itemId)).toBe(false)
  })

  it('a message entry has Close, removes its object and then restores the original message', async () => {
    const restore = vi.fn()
    const file = detail('exe')
    await slot(file, true, { tabbed: true, restore })
    expect(harness.container.querySelector('button[aria-label="返回"]')).toBeNull()
    await closeFromTab(file.chatId)
    expect(panelTabsOf('preview-group').some((tab) => tab.item.itemId === file.itemId)).toBe(false)
    expect(chatAlone('preview-group')).toBe(true)
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('a phone message preview has Back and closes its tab before restoring the originating topic', async () => {
    boundary.mobile = true
    const restore = vi.fn(() => expect(chatAlone('preview-group')).toBe(true))
    await slot(detail('exe'), true, { restore })
    expect(harness.container.querySelector('button[aria-label="关闭预览"]')).toBeNull()
    const back = harness.container.querySelector<HTMLButtonElement>('button[aria-label="返回"]')
    expect(back).not.toBeNull()
    await act(async () => back!.click())
    expect(shownItem('preview-group')).toBeNull()
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('expands and restores a group HTML preview in a block without replacing its page', async () => {
    const file = detail('html')
    await slot(file, true, { tabbed: true })
    await until('HTML is ready before expanding', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('lane report') === true)
    const page = harness.container.querySelector('iframe')
    const tabId = shownPanelTab(file.chatId)!.tabId
    const fill = () => chatPaneOf(file.chatId, tabId)!.tabFill(tabId)!
    await act(async () => fill().toggle())
    // 全屏只盖住工作区,❌ 动布局(panelFull = 拆开、对话不在,是另一件事)。
    expect(tabFullscreen.isOn(chatPaneOf(file.chatId, tabId)!, tabId)).toBe(true)
    expect(panelFull(file.chatId, tabId)).toBe(fill().full)
    await act(async () => fill().toggle())
    expect(tabFullscreen.isOn(chatPaneOf(file.chatId, tabId)!)).toBe(false)
    expect(panelFull(file.chatId, tabId)).toBe(fill().full)
    expect(harness.container.querySelector('iframe')).toBe(page)
    expect(harness.container.querySelectorAll('header')).toHaveLength(0)
    expect(shownItem(file.chatId)?.itemId).toBe(file.itemId)
    expect(boundary.read).toHaveBeenCalledTimes(1)
    expect(chatAlone(file.chatId)).toBe(false)
  })

  it('outside a block a group HTML preview has no full switch (no strip to fill)', async () => {
    await slot(detail('html'))
    expect(harness.container.querySelector('button[aria-label="面板全屏"]')).toBeNull()
  })

  it.each([false, true])('an App arriving during a later file ask never takes over it (later answer first=%s)', async (answerFirst) => {
    const file = detail('exe')
    await slot(file)
    let answer!: (value: never) => void
    vi.mocked(appsHere!.groupFileOpener).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const later = { ...detail('md'), choice: { kind: 'one' as const, candidate } }
    await act(async () => { void pill(later.itemId) })
    const release = async () => act(async () => answer({ success: true, data: later } as never))
    if (answerFirst) await release()
    const app = { ...workspace, id: 'exe-reader', contributes: { tabs: [{ name: 'main', title: 'Reader', opensFiles: { chat: ['.exe'] } }] } }
    await act(async () => installedExtensions.set(['local'], { extensions: [workspace, app], invalid: [] } as never))
    expect(shownItem(file.chatId)?.itemId, 'the later ask is not answered by the App arriving').toBe(answerFirst ? later.itemId : file.itemId)
    if (!answerFirst) await release()
    expect(shownItem(file.chatId)).toMatchObject({ kind: 'workspace.main', itemId: later.itemId })
  })

  it('an enabled App arriving while a preview is open takes over the same file', async () => {
    const file = detail('exe')
    await slot(file)
    expect(harness.container.querySelector('[data-preview-kind="unsupported"]')).not.toBeNull()
    const app = { ...workspace, id: 'exe-reader', contributes: { tabs: [{ name: 'main', title: 'Reader', opensFiles: { chat: ['.exe'] } }] } }
    await act(async () => installedExtensions.set(['local'], { extensions: [workspace, app], invalid: [] } as never))
    expect(shownItem(file.chatId)).toMatchObject({ kind: 'exe-reader.main', itemId: file.itemId })
    expect(harness.container.querySelector('[data-preview-kind="unsupported"]')).toBeNull()
  })

  it('switching a peek to another HTML file never paints the old content under the new filename', async () => {
    const painted: string[] = []
    function Peek({ file }: { file: ReturnType<typeof detail> }) {
      useLayoutEffect(() => { painted.push(boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '') ?? '') }, [file])
      return createElement(AppPeek, { target: { kind: 'chat', detail: file }, slotKey: 'changing-peek', beside: false, onClose: vi.fn() })
    }
    await harness.render(createElement(Peek, { file: detail('html') }))
    await until('first report loaded', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('lane report') === true)
    boundary.read.mockImplementationOnce(() => new Promise(() => {}))
    await harness.render(createElement(Peek, { file: { ...detail('html'), itemId: 'other-report', name: 'next.html' } }))
    expect(painted.at(-1), 'layout commit happens before the next file load effect').not.toContain('lane report')
  })

  it.each([false, true])('a collaborative HTML document uses the existing live document reader (peek=%s)', async (peek) => {
    const file = { ...detail('html'), file: { ...detail('html').file, document: true } }
    if (peek) await harness.render(createElement(AppPeek, { target: { kind: 'chat', detail: file }, slotKey: 'live-document', beside: false, onClose: vi.fn() }))
    else await slot(file)
    await until('live document rendered', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('live report') === true)
    expect(boundary.document).toHaveBeenCalledWith({ id: file.itemId })
    expect(boundary.signed).not.toHaveBeenCalled()
    expect(boundary.read).not.toHaveBeenCalled()
    await act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="下载"]')!.click())
    expect(boundary.save).toHaveBeenCalledWith(expect.anything(), file.name)
  })

  it('group message previews retain the originating message forward action', async () => {
    const message = { id: 'original-message', content: 'attachment', retracted_at: null } as MessageItem
    await slot(detail('exe'), true, { message })
    await act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="转发"]')!.click())
    expect(boundary.forward).toHaveBeenCalledWith(message)
    expect(boundary.read).not.toHaveBeenCalled()
  })

  it('a retained hidden mobile chat unmounts its native player while keeping the file for return', async () => {
    boundary.mobile = true
    const file = detail('mp4')
    await slot(file)
    await until('video started in visible chat', () => harness.container.querySelector('video') !== null)
    await redraw(file.chatId, { visible: false })
    expect(harness.container.querySelector('video')).toBeNull()
    expect(shownItem('preview-group')?.itemId).toBe('file-mp4')
  })

})

it('the shared-package mock is live (signed in): a file waits for this chat\'s packages, then is drawn', async () => {
  const { expectSharedPackagesLive } = await import('./chatTabsHarness')
  await expectSharedPackagesLive((node) => harness.render(node))
})
