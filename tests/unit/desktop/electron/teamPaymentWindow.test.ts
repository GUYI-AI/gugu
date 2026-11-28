import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ windows: [] as unknown[], loadError: null as unknown }))
vi.mock('electron', async () => {
  const { EventEmitter: MockEmitter } = await import('node:events')
  return { BrowserWindow: class extends MockEmitter {
  destroyed = false
  show = vi.fn(); removeMenu = vi.fn(); loadURL = vi.fn(async () => { if (state.loadError) throw state.loadError })
  webContents = Object.assign(new MockEmitter(), { session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }, setWindowOpenHandler: vi.fn() })
  constructor(readonly options: Record<string, unknown>) { super(); state.windows.push(this) }
  isDestroyed() { return this.destroyed }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
} }
})
import { BrowserWindow } from 'electron'
import { openTeamPaymentWindow } from '../../../../apps/desktop/electron/team-payment-window'
beforeEach(() => { state.windows = []; state.loadError = null })
it('submits URL-encoded POST fields without exposing the app preload, profile or native permissions', async () => {
  const parent = new EventEmitter() as unknown as BrowserWindow, closed = vi.fn()
  const parameters = { money: '425.00', name: '咕咕 团队+会员', sign: 'owned-fixture-only', out_trade_no: 'gtt-owned' }
  const page = openTeamPaymentWindow(parent, 'Fixture payment', { url: 'https://payment.example.invalid/submit', parameters, closed })
  await page.ready
  const root = state.windows.at(-1) as {
    options: { webPreferences: Record<string, unknown> }; loadURL: ReturnType<typeof vi.fn>; destroyed: boolean
    webContents: { session: { setPermissionRequestHandler: ReturnType<typeof vi.fn> } }
  }
  expect(root.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true })
  expect(root.options.webPreferences).not.toHaveProperty('preload')
  expect(String(root.options.webPreferences.partition)).not.toContain('persist:')
  const [url, options] = root.loadURL.mock.calls[0]
  expect(url).toBe('https://payment.example.invalid/submit')
  expect(options.extraHeaders).toContain('Content-Type: application/x-www-form-urlencoded')
  expect(Object.fromEntries(new URLSearchParams(options.postData[0].bytes.toString('utf8')))).toEqual(parameters)
  const answer = vi.fn()
  root.webContents.session.setPermissionRequestHandler.mock.calls[0][0](null, 'camera', answer)
  expect(answer).toHaveBeenCalledWith(false)
  parent.emit('closed')
  expect(root.destroyed).toBe(true); expect(closed).toHaveBeenCalledTimes(1)
})
it.each([
  Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED' }),
  Object.assign(new Error('ERR_ABORTED (-3)'), { errno: -3 }),
])('keeps the cashier visible when its immediate navigation supersedes the initial POST', async error => {
  state.loadError = error
  const parent = new EventEmitter() as unknown as BrowserWindow, closed = vi.fn()
  const payment = openTeamPaymentWindow(parent, 'Fixture payment', {
    url: 'https://payment.example.invalid/submit', parameters: { money: '100.00' }, closed,
  })
  const root = state.windows.at(-1) as {
    show: ReturnType<typeof vi.fn>; destroyed: boolean; webContents: EventEmitter
  }
  const allowed = { preventDefault: vi.fn() }
  root.webContents.emit('will-navigate', allowed, 'https://payment.example.invalid/cashier')
  expect(allowed.preventDefault).not.toHaveBeenCalled()
  await expect(payment.ready).resolves.toBeUndefined()
  expect(root.show).toHaveBeenCalledTimes(1)
  expect(root.destroyed).toBe(false); expect(closed).not.toHaveBeenCalled()
  for (const event of ['will-navigate', 'will-redirect']) {
    for (const url of ['http://payment.example.invalid', 'alipay://cashier', 'https://user:pass@payment.example.invalid']) {
      const blocked = { preventDefault: vi.fn() }
      root.webContents.emit(event, blocked, url)
      expect(blocked.preventDefault).toHaveBeenCalledTimes(1)
    }
  }
  payment.close()
})
it('keeps genuine load errors rejected so checkout can close the failed payment window', async () => {
  const error = Object.assign(new Error('ERR_CONNECTION_REFUSED (-102)'), { code: 'ERR_CONNECTION_REFUSED', errno: -102 })
  state.loadError = error
  const closed = vi.fn(), payment = openTeamPaymentWindow(new EventEmitter() as unknown as BrowserWindow, 'Fixture payment', {
    url: 'https://payment.example.invalid/submit', parameters: {}, closed,
  })
  const root = state.windows.at(-1) as { show: ReturnType<typeof vi.fn>; destroyed: boolean }
  await expect(payment.ready).rejects.toBe(error)
  expect(root.show).not.toHaveBeenCalled()
  payment.close()
  expect(root.destroyed).toBe(true); expect(closed).toHaveBeenCalledTimes(1)
})
