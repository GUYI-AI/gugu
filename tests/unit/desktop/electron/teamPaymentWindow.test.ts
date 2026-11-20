import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ windows: [] as unknown[] }))
vi.mock('electron', async () => {
  const { EventEmitter: MockEmitter } = await import('node:events')
  return { BrowserWindow: class extends MockEmitter {
  destroyed = false
  show = vi.fn(); removeMenu = vi.fn(); loadURL = vi.fn(async () => undefined)
  webContents = Object.assign(new MockEmitter(), { session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }, setWindowOpenHandler: vi.fn() })
  constructor(readonly options: Record<string, unknown>) { super(); state.windows.push(this) }
  isDestroyed() { return this.destroyed }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
} }
})
import { BrowserWindow } from 'electron'
import { openTeamPaymentWindow } from '../../../../apps/desktop/electron/team-payment-window'
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
