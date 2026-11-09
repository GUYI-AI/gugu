import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import type { BrowserWindow, WebContents } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isAnimationWindowVisible } from '@gugu/session-shared/animation-visibility'
import { forwardWindowSeen } from '../../../../apps/desktop/electron/animation-visibility'
import { markCredentialHandoffCandidate, registerPrivateCredentialSurface, restrictCredentialPartition } from '../../../../apps/desktop/electron/session/main/core/browser/credential-isolation-registry'

const native = vi.hoisted(() => ({ listeners: new Map<string, (...args: unknown[]) => void>(), contents: [] as WebContents[] }))
vi.mock('electron', () => ({
  app: { on: (event: string, listener: (...args: unknown[]) => void) => native.listeners.set(event, listener) },
  webContents: { getAllWebContents: () => native.contents },
  BrowserWindow: { fromWebContents: (contents: { getOwnerBrowserWindow: () => unknown }) => contents.getOwnerBrowserWindow() },
}))
const log = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({ createLogger: () => log }))

const cleanup: Array<() => void> = []
function fixture(owner?: BrowserWindow) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, runScripts: 'outside-only' })
  const contents = Object.assign(new EventEmitter(), {
    destroyed: false,
    session: {},
    debugger: { isAttached: () => false },
    isDestroyed() { return this.destroyed },
    executeJavaScript: vi.fn(async (source: string) => dom.window.eval(source) as unknown),
  })
  const host = Object.assign(new EventEmitter(), {
    visible: true,
    minimized: false,
    isDestroyed: () => false,
    isVisible() { return this.visible },
    isMinimized() { return this.minimized },
    webContents: contents,
  })
  const target = Object.assign(contents, { getOwnerBrowserWindow: () => owner ?? host }) as unknown as WebContents
  native.contents.push(target)
  native.listeners.get('web-contents-created')?.({}, target)
  if (!owner) native.listeners.get('browser-window-created')?.({}, host)
  const value = { dom, host, contents, window: host as unknown as BrowserWindow, target }
  cleanup.push(() => {
    contents.destroyed = true
    contents.emit('destroyed')
    dom.window.close()
  })
  return value
}

beforeEach(() => {
  native.listeners.clear()
  native.contents.length = 0
  forwardWindowSeen()
})

afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop())
  vi.clearAllMocks()
})

it('sends the native signal to each window and its layers without pausing a visible auxiliary window', () => {
  const main = fixture(), aux = fixture(), layer = fixture(main.window)
  for (const { dom } of [main, aux, layer]) expect(isAnimationWindowVisible(dom.window.document)).toBe(true)
  expect(main.host.listenerCount('minimize')).toBe(1)
  main.host.minimized = true
  main.host.visible = false
  main.host.emit('minimize')
  expect([main, aux, layer].map(({ dom }) => isAnimationWindowVisible(dom.window.document))).toEqual([false, true, false])
  expect(main.dom.window.document.hidden).toBe(false)
  aux.host.visible = false
  aux.host.emit('hide')
  expect(isAnimationWindowVisible(aux.dom.window.document)).toBe(false)
  aux.host.visible = true
  aux.host.emit('show')
  expect(isAnimationWindowVisible(aux.dom.window.document)).toBe(true)
  main.host.minimized = false
  main.host.visible = true
  main.host.emit('restore')
  expect([main, aux, layer].map(({ dom }) => isAnimationWindowVisible(dom.window.document))).toEqual([true, true, true])
})

it('synchronizes an initially hidden document on load and skips destroyed contents', () => {
  const { dom, host, contents } = fixture()
  host.visible = false
  // The first event preceded renderer installation. The load boundary must
  // report the actual native state instead of assuming a new document is shown.
  isAnimationWindowVisible(dom.window.document)
  contents.emit('did-finish-load')
  expect(isAnimationWindowVisible(dom.window.document)).toBe(false)
  contents.destroyed = true
  contents.emit('destroyed')
  const delivered = contents.executeJavaScript.mock.calls.length
  host.visible = true
  host.emit('show')
  expect(contents.executeJavaScript).toHaveBeenCalledTimes(delivered)
})

it('reports a failed delivery while the target is still alive', async () => {
  const { contents } = fixture()
  contents.executeJavaScript.mockRejectedValueOnce(new Error('delivery failed'))
  contents.emit('did-finish-load')
  await Promise.resolve()
  await Promise.resolve()
  expect(log.error).toHaveBeenCalledOnce()
})

function privateSurface(target: WebContents) {
  const release = registerPrivateCredentialSurface({ loginSurfaceId: randomUUID(), loginSurfaceEpoch: randomUUID(),
    browserId: randomUUID(), partition: randomUUID(), contents: target })
  cleanup.push(release)
}

it('does not execute page-world code on a private surface or unpublished candidate', () => {
  const privatePage = fixture(), candidate = fixture()
  privateSurface(privatePage.target)
  markCredentialHandoffCandidate(candidate.target)
  privatePage.contents.emit('did-finish-load')
  candidate.contents.emit('did-finish-load')
  privatePage.host.emit('show')
  candidate.host.emit('show')
  expect(privatePage.contents.executeJavaScript.mock.calls.length).toBe(0)
  expect(candidate.contents.executeJavaScript.mock.calls.length).toBe(0)
})

it('drops a real pending error when the target becomes private before rejection', async () => {
  const page = fixture()
  let reject!: (error: unknown) => void
  page.contents.executeJavaScript.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
  page.contents.emit('did-finish-load')
  expect(page.contents.executeJavaScript.mock.calls.length).toBe(1)
  privateSurface(page.target)
  reject(new Error(randomUUID()))
  await Promise.resolve()
  await Promise.resolve()
  expect(log.error.mock.calls.length).toBe(0)
})

it('blocks new deliveries and late errors while the native partition is isolated', async () => {
  const page = fixture()
  let reject!: (error: unknown) => void
  page.contents.executeJavaScript.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
  page.contents.emit('did-finish-load')
  const release = restrictCredentialPartition(randomUUID(), page.contents.session, { allowsPublication: () => false })
  cleanup.push(release)
  page.host.emit('show')
  reject(new Error(randomUUID()))
  await Promise.resolve()
  await Promise.resolve()
  expect(page.contents.executeJavaScript.mock.calls.length).toBe(1)
  expect(log.error.mock.calls.length).toBe(0)
})
